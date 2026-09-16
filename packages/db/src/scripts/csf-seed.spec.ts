import { beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { db } from '../client';
import {
  buildManifestFromFramework,
  manifestFrameworkQuery,
  type FrameworkManifest,
} from '../framework-manifest';
import { CSF_FRAMEWORK_ID, loadCrosswalk } from './csf-crosswalk';

const dbUrl = process.env.DATABASE_URL ?? '';
const isScratchDb = dbUrl.includes('test') && !dbUrl.includes('prod') && !dbUrl.includes('staging');

// The seed script takes well over bun's 5s default hook/test timeout (it seeds
// ~1300 requirements and syncs the CSF crosswalk); test 10 below invokes it
// three times in a row. Raise the default for this file only.
setDefaultTimeout(180_000);

const SOC2_FRAMEWORK_ID = 'frk_683f377429b8408d1c85f9bd';
const SEED = path.resolve(__dirname, '..', '..', 'prisma', 'seed', 'seed.ts');

function runSeed(): void {
  execSync(`bun ${SEED}`, { stdio: 'pipe', env: process.env });
}

async function scopedLinkSets(frameworkId: string) {
  const [policies, tasks] = await Promise.all([
    db.frameworkEditorControlPolicyTemplateLink.findMany({
      where: { frameworkId },
      select: { controlTemplateId: true, policyTemplateId: true },
    }),
    db.frameworkEditorControlTaskTemplateLink.findMany({
      where: { frameworkId },
      select: { controlTemplateId: true, taskTemplateId: true },
    }),
  ]);
  return {
    policies: policies.map((l) => `${l.controlTemplateId}|${l.policyTemplateId}`).sort(),
    tasks: tasks.map((l) => `${l.controlTemplateId}|${l.taskTemplateId}`).sort(),
  };
}

async function requirementControlPairs(frameworkId: string) {
  const rows = await db.frameworkEditorRequirement.findMany({
    where: { frameworkId },
    select: { id: true, controlTemplates: { select: { id: true } } },
  });
  return rows.flatMap((r) => r.controlTemplates.map((c) => `${r.id}|${c.id}`)).sort();
}

describe.skipIf(!isScratchDb)('CSF seed', () => {
  beforeAll(() => {
    runSeed();
  });

  it('8: the CSF 1.0.0 manifest has 106 ordered requirements, each with controls that carry policies and tasks', async () => {
    const version = await db.frameworkVersion.findUnique({
      where: { frameworkId_version: { frameworkId: CSF_FRAMEWORK_ID, version: '1.0.0' } },
    });
    expect(version).not.toBeNull();
    const manifest = version!.manifest as unknown as FrameworkManifest;
    expect(manifest.requirements).toHaveLength(106);
    expect(manifest.requirements.map((r) => r.sortOrder)).toEqual([...Array(106).keys()]);
    for (const r of manifest.requirements) {
      expect(r.identifier).toMatch(/^[A-Z]{2}\.[A-Z]{2}-\d{2}$/);
      expect(r.requirementFamily).toBeTruthy();
      expect(manifest.controls.some((c) => c.requirementIds.includes(r.id))).toBe(true);
    }
    for (const c of manifest.controls) {
      expect(c.policyIds.length).toBeGreaterThan(0);
      expect(c.taskIds.length).toBeGreaterThan(0);
    }
  });

  it('9: the shared builder reproduces the stored CSF manifest exactly', async () => {
    const version = await db.frameworkVersion.findUnique({
      where: { frameworkId_version: { frameworkId: CSF_FRAMEWORK_ID, version: '1.0.0' } },
    });
    const framework = await db.frameworkEditorFramework.findUnique(
      manifestFrameworkQuery(CSF_FRAMEWORK_ID),
    );
    expect(buildManifestFromFramework(framework!)).toEqual(
      version!.manifest as unknown as FrameworkManifest,
    );
  });

  it('11: scoped-link population is idempotent and SOC 2 scoped links equal its global links', async () => {
    const before = await scopedLinkSets(SOC2_FRAMEWORK_ID);
    runSeed();
    const after = await scopedLinkSets(SOC2_FRAMEWORK_ID);
    expect(after).toEqual(before);
    const version = await db.frameworkVersion.findFirst({
      where: { frameworkId: SOC2_FRAMEWORK_ID },
      orderBy: { publishedAt: 'desc' },
    });
    const manifest = version!.manifest as unknown as FrameworkManifest;
    const fromManifest = {
      policies: manifest.controls.flatMap((c) => c.policyIds.map((p) => `${c.id}|${p}`)).sort(),
      tasks: manifest.controls.flatMap((c) => c.taskIds.map((t) => `${c.id}|${t}`)).sort(),
    };
    expect(after).toEqual(fromManifest);
  });

  it('10: the crosswalk is authoritative for CSF mappings and scoped links', async () => {
    const crosswalk = loadCrosswalk();
    const soc2Before = await scopedLinkSets(SOC2_FRAMEWORK_ID);
    const soc2PairsBefore = await requirementControlPairs(SOC2_FRAMEWORK_ID);
    const expectedPairs = crosswalk.subcategories
      .flatMap((s) => s.controls.map((c) => `${s.requirementId}|${c.id}`))
      .sort();
    expect(await requirementControlPairs(CSF_FRAMEWORK_ID)).toEqual(expectedPairs);

    // Case A: add an unrelated control to a requirement whose control is shared by several
    // requirements; the seed's set restores the crosswalk and the shared control's scoped rows stay.
    const shared = crosswalk.subcategories.filter((s) =>
      s.controls.some((c) => c.id === 'frk_ct_683f47cc2faa426603d6bee8'),
    );
    expect(shared.length).toBeGreaterThan(1);
    const victim = shared[0]!;
    await db.frameworkEditorRequirement.update({
      where: { id: victim.requirementId },
      data: { controlTemplates: { connect: { id: 'frk_ct_683f42c71eea99f22f9df060' } } },
    });
    runSeed();
    expect(await requirementControlPairs(CSF_FRAMEWORK_ID)).toEqual(expectedPairs);
    const csfLinks = await scopedLinkSets(CSF_FRAMEWORK_ID);
    expect(csfLinks.tasks.some((l) => l.startsWith('frk_ct_683f47cc2faa426603d6bee8|'))).toBe(true);

    // Case B: an extra scoped row not in the crosswalk is removed by the seed.
    await db.frameworkEditorControlTaskTemplateLink.create({
      data: {
        frameworkId: CSF_FRAMEWORK_ID,
        controlTemplateId: 'frk_ct_683f47cc2faa426603d6bee8',
        taskTemplateId: 'frk_tt_68406903839203801ac8041a',
      },
    });
    runSeed();
    const afterB = await scopedLinkSets(CSF_FRAMEWORK_ID);
    expect(afterB.tasks).not.toContain(
      'frk_ct_683f47cc2faa426603d6bee8|frk_tt_68406903839203801ac8041a',
    );
    expect(await scopedLinkSets(SOC2_FRAMEWORK_ID)).toEqual(soc2Before);
    expect(await requirementControlPairs(SOC2_FRAMEWORK_ID)).toEqual(soc2PairsBefore);
  });
});

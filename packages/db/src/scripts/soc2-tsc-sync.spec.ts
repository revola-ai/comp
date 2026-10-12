import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { syncSoc2TscRetirements } from '../../prisma/seed/sync-soc2-tsc';
import { db } from '../client';
import { isScratchDatabaseUrl } from './scratch-db';
import { SOC2_LEGACY_FRAMEWORK_ID, loadSoc2Crosswalk } from './soc2-tsc';

const isScratchDb = isScratchDatabaseUrl(process.env.DATABASE_URL);

// Mirrors csf-seed.spec.ts: the seed takes well over bun's 5s default hook/test timeout.
setDefaultTimeout(180_000);

const SEED = path.resolve(__dirname, '..', '..', 'prisma', 'seed', 'seed.ts');

function runSeed(): void {
  execSync(`bun ${SEED}`, { stdio: 'pipe', env: process.env });
}

const crosswalk = loadSoc2Crosswalk();
const retired = crosswalk.retired[0]!;
const replacementId = crosswalk.criteria.find((c) => c.id === retired.replacedBy)!.requirementId;

describe.skipIf(!isScratchDb)('SOC 2 1.0.0 retired requirement reconciliation', () => {
  let orgId: string | undefined;
  let controlTemplateId: string;

  beforeAll(async () => {
    runSeed();
    // An install seeded before the realignment still has the retired record.
    await db.frameworkEditorRequirement.create({
      data: {
        id: retired.requirementId,
        frameworkId: SOC2_LEGACY_FRAMEWORK_ID,
        name: `${retired.formerLabel} legacy`,
        identifier: '',
        description: retired.formerText,
      },
    });
  });

  afterAll(async () => {
    if (orgId) await db.organization.delete({ where: { id: orgId } });
    await db.frameworkEditorIsmsDocumentRequirementLink.deleteMany({
      where: { frameworkId: SOC2_LEGACY_FRAMEWORK_ID },
    });
    if (controlTemplateId) {
      await db.frameworkEditorControlTemplate.update({
        where: { id: controlTemplateId },
        data: { requirements: { disconnect: [{ id: replacementId }] } },
      });
    }
  });

  it('moves every reference to the replacement criterion, merging duplicates, then deletes the record', async () => {
    const version = await db.frameworkVersion.findFirstOrThrow({
      where: { frameworkId: SOC2_LEGACY_FRAMEWORK_ID },
      orderBy: { publishedAt: 'desc' },
    });
    const org = await db.organization.create({ data: { name: `soc2-tsc-test-${Date.now()}` } });
    orgId = org.id;
    const instance = await db.frameworkInstance.create({
      data: {
        organizationId: org.id,
        frameworkId: SOC2_LEGACY_FRAMEWORK_ID,
        currentVersionId: version.id,
      },
    });
    const [onlyRetired, retiredActive, retiredArchived] = await Promise.all(
      ['only-retired', 'retired-active', 'retired-archived'].map((name) =>
        db.control.create({ data: { organizationId: org.id, name, description: 'test' } }),
      ),
    );
    const archivedAt = new Date('2026-01-01T00:00:00Z');
    const map = ({
      controlId,
      requirementId,
      archived = false,
    }: {
      controlId: string;
      requirementId: string;
      archived?: boolean;
    }) => ({
      controlId,
      requirementId,
      frameworkInstanceId: instance.id,
      archivedAt: archived ? archivedAt : null,
    });
    await db.requirementMap.createMany({
      data: [
        map({ controlId: onlyRetired!.id, requirementId: retired.requirementId }),
        map({ controlId: retiredActive!.id, requirementId: retired.requirementId }),
        map({ controlId: retiredActive!.id, requirementId: replacementId, archived: true }),
        map({
          controlId: retiredArchived!.id,
          requirementId: retired.requirementId,
          archived: true,
        }),
        map({ controlId: retiredArchived!.id, requirementId: replacementId }),
      ],
    });

    const template = await db.frameworkEditorControlTemplate.findFirstOrThrow({
      where: { requirements: { none: { id: { in: [retired.requirementId, replacementId] } } } },
      select: { id: true },
    });
    controlTemplateId = template.id;
    await db.frameworkEditorControlTemplate.update({
      where: { id: template.id },
      data: { requirements: { connect: [{ id: retired.requirementId }] } },
    });

    const ismsTemplate = await db.frameworkEditorIsmsDocumentTemplate.findFirstOrThrow();
    await db.frameworkEditorIsmsDocumentRequirementLink.create({
      data: {
        frameworkId: SOC2_LEGACY_FRAMEWORK_ID,
        ismsDocumentTemplateId: ismsTemplate.id,
        requirementId: retired.requirementId,
      },
    });
    const ismsDocument = await db.ismsDocument.create({
      data: {
        organizationId: org.id,
        frameworkId: SOC2_LEGACY_FRAMEWORK_ID,
        type: ismsTemplate.documentType,
        title: 'test',
        requirementId: retired.requirementId,
      },
    });

    await syncSoc2TscRetirements({ prisma: db });

    expect(
      await db.frameworkEditorRequirement.findUnique({ where: { id: retired.requirementId } }),
    ).toBeNull();

    const maps = await db.requirementMap.findMany({
      where: { frameworkInstanceId: instance.id },
      select: { controlId: true, requirementId: true, archivedAt: true },
    });
    const byControl = (controlId: string) => maps.filter((m) => m.controlId === controlId);
    expect(byControl(onlyRetired!.id)).toEqual([
      { controlId: onlyRetired!.id, requirementId: replacementId, archivedAt: null },
    ]);
    // An active link wins over an archived one for the same control and criterion.
    expect(byControl(retiredActive!.id)).toEqual([
      { controlId: retiredActive!.id, requirementId: replacementId, archivedAt: null },
    ]);
    expect(byControl(retiredArchived!.id)).toEqual([
      { controlId: retiredArchived!.id, requirementId: replacementId, archivedAt: null },
    ]);

    const templateRequirements = await db.frameworkEditorControlTemplate.findUniqueOrThrow({
      where: { id: template.id },
      select: { requirements: { select: { id: true } } },
    });
    expect(templateRequirements.requirements.map((r) => r.id)).toContain(replacementId);

    const ismsLinks = await db.frameworkEditorIsmsDocumentRequirementLink.findMany({
      where: { frameworkId: SOC2_LEGACY_FRAMEWORK_ID, ismsDocumentTemplateId: ismsTemplate.id },
      select: { requirementId: true },
    });
    expect(ismsLinks).toEqual([{ requirementId: replacementId }]);
    const document = await db.ismsDocument.findUniqueOrThrow({ where: { id: ismsDocument.id } });
    expect(document.requirementId).toBe(replacementId);
  });

  it('refuses, changing nothing, when a replacement record is not seeded', async () => {
    const control = await db.control.create({
      data: { organizationId: orgId!, name: 'refuse', description: 'test' },
    });
    const instance = await db.frameworkInstance.findFirstOrThrow({
      where: { organizationId: orgId!, frameworkId: SOC2_LEGACY_FRAMEWORK_ID },
    });
    await db.frameworkEditorRequirement.create({
      data: {
        id: retired.requirementId,
        frameworkId: SOC2_LEGACY_FRAMEWORK_ID,
        name: `${retired.formerLabel} legacy`,
        identifier: '',
        description: retired.formerText,
      },
    });
    await db.requirementMap.create({
      data: {
        controlId: control.id,
        requirementId: retired.requirementId,
        frameworkInstanceId: instance.id,
      },
    });
    const brokenCrosswalk = {
      ...crosswalk,
      criteria: crosswalk.criteria.map((c) =>
        c.id === retired.replacedBy ? { ...c, requirementId: 'frk_rq_not_seeded' } : c,
      ),
    };

    await expect(
      syncSoc2TscRetirements({ prisma: db, crosswalk: brokenCrosswalk }),
    ).rejects.toThrow('frk_rq_not_seeded');
    const maps = await db.requirementMap.findMany({
      where: { controlId: control.id },
      select: { requirementId: true },
    });
    expect(maps).toEqual([{ requirementId: retired.requirementId }]);

    await syncSoc2TscRetirements({ prisma: db });
  });

  it('is idempotent: a second run changes nothing', async () => {
    expect(await syncSoc2TscRetirements({ prisma: db })).toEqual({
      requirementMaps: 0,
      controlTemplateLinks: 0,
      ismsDocumentLinks: 0,
      ismsDocuments: 0,
      deletedRequirements: 0,
    });
  });
});

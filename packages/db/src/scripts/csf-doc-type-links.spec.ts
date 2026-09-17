import { beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { db } from '../client';
import { syncCsfCrosswalk } from '../../prisma/seed/sync-framework-scoped-links';
import { CSF_FRAMEWORK_ID, loadCrosswalk } from './csf-crosswalk';
import { isScratchDatabaseUrl } from './scratch-db';

const isScratchDb = isScratchDatabaseUrl(process.env.DATABASE_URL);

// Mirrors csf-seed.spec.ts: the seed takes well over bun's 5s default hook/test timeout.
setDefaultTimeout(180_000);

const SEED = path.resolve(__dirname, '..', '..', 'prisma', 'seed', 'seed.ts');

function runSeed(): void {
  execSync(`bun ${SEED}`, { stdio: 'pipe', env: process.env });
}

describe.skipIf(!isScratchDb)('CSF doc-type scoped links', () => {
  beforeAll(() => {
    runSeed();
  });

  it('reconciles FrameworkEditorControlDocumentTypeLink to exactly the crosswalk-mapped set, removing stale rows', async () => {
    const crosswalk = loadCrosswalk();
    const mappedControlIds = [
      ...new Set(crosswalk.subcategories.flatMap((s) => s.controls.map((c) => c.id))),
    ];

    const unmapped = await db.frameworkEditorControlTemplate.findFirst({
      where: { id: { notIn: mappedControlIds } },
      select: { id: true },
    });
    if (!unmapped) {
      throw new Error('Expected at least one seeded control template outside the CSF crosswalk mapping');
    }

    const stale = await db.frameworkEditorControlDocumentTypeLink.create({
      data: {
        frameworkId: CSF_FRAMEWORK_ID,
        controlTemplateId: unmapped.id,
        formType: 'infrastructure_inventory',
      },
    });

    await syncCsfCrosswalk({ prisma: db });

    const links = await db.frameworkEditorControlDocumentTypeLink.findMany({
      where: { frameworkId: CSF_FRAMEWORK_ID },
      select: { controlTemplateId: true, formType: true },
    });

    expect(links.some((l) => l.controlTemplateId === stale.controlTemplateId)).toBe(false);

    const mappedControls = await db.frameworkEditorControlTemplate.findMany({
      where: { id: { in: mappedControlIds } },
      select: { id: true, documentTypes: true },
    });
    const expected = new Set(
      mappedControls.flatMap((c) => c.documentTypes.map((formType) => `${c.id}|${formType}`)),
    );

    expect(new Set(links.map((l) => `${l.controlTemplateId}|${l.formType}`))).toEqual(expected);
    expect(links).toHaveLength(expected.size);
  });

  it('is idempotent: a second sync leaves the doc-type scoped set unchanged', async () => {
    const before = await db.frameworkEditorControlDocumentTypeLink.findMany({
      where: { frameworkId: CSF_FRAMEWORK_ID },
      select: { controlTemplateId: true, formType: true },
    });
    await syncCsfCrosswalk({ prisma: db });
    const after = await db.frameworkEditorControlDocumentTypeLink.findMany({
      where: { frameworkId: CSF_FRAMEWORK_ID },
      select: { controlTemplateId: true, formType: true },
    });
    const key = (l: { controlTemplateId: string; formType: string }) => `${l.controlTemplateId}|${l.formType}`;
    expect(new Set(after.map(key))).toEqual(new Set(before.map(key)));
  });
});

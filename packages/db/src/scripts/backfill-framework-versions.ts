import { Prisma } from '@prisma/client';
import { db } from '../client';
import { buildManifestFromFramework, manifestFrameworkQuery } from '../framework-manifest';

export interface BackfillResult {
  versionsCreated: number;
  instancesBackfilled: number;
}

export async function backfillFrameworkVersions(): Promise<BackfillResult> {
  const frameworkIds = await db.frameworkEditorFramework.findMany({ select: { id: true } });
  const frameworks = [];
  for (const { id } of frameworkIds) {
    const framework = await db.frameworkEditorFramework.findUnique(manifestFrameworkQuery(id));
    if (framework) frameworks.push(framework);
  }

  let versionsCreated = 0;

  for (const framework of frameworks) {
    const manifest = buildManifestFromFramework(framework);

    try {
      await db.frameworkVersion.create({
        data: {
          frameworkId: framework.id,
          version: '1.0.0',
          manifest: manifest as unknown as Prisma.InputJsonValue,
          releaseNotes: 'Initial version (backfilled).',
        },
      });
      versionsCreated += 1;
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Raced with another backfill run - already created. Not counted.
      } else {
        throw err;
      }
    }
  }

  // Backfill instances
  const versions = await db.frameworkVersion.findMany({
    where: { version: '1.0.0' },
    select: { id: true, frameworkId: true },
  });
  const byFrameworkId = new Map(versions.map((v) => [v.frameworkId, v.id]));

  const toBackfill = await db.frameworkInstance.findMany({
    where: { currentVersionId: null, frameworkId: { not: null } },
    select: { id: true, frameworkId: true },
  });

  let instancesBackfilled = 0;
  for (const inst of toBackfill) {
    const versionId = byFrameworkId.get(inst.frameworkId!);
    if (!versionId) continue;
    await db.frameworkInstance.update({
      where: { id: inst.id },
      data: { currentVersionId: versionId },
    });
    instancesBackfilled += 1;
  }

  return { versionsCreated, instancesBackfilled };
}

if (require.main === module) {
  backfillFrameworkVersions()
    .then((result) => {
      console.log('Backfill complete:', result);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Backfill failed:', err);
      process.exit(1);
    });
}

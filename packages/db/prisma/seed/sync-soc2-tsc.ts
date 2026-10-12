import type { Prisma, PrismaClient } from '@prisma/client';
import {
  SOC2_LEGACY_FRAMEWORK_ID,
  loadSoc2Crosswalk,
  retiredReplacements,
  type Soc2Crosswalk,
} from '../../src/scripts/soc2-tsc';

export interface Soc2TscSyncCounts {
  requirementMaps: number;
  controlTemplateLinks: number;
  ismsDocumentLinks: number;
  ismsDocuments: number;
  deletedRequirements: number;
}

async function moveReferences({
  tx,
  retiredId,
  replacementId,
}: {
  tx: Prisma.TransactionClient;
  retiredId: string;
  replacementId: string;
}): Promise<Soc2TscSyncCounts> {
  // A control already linked to the replacement keeps that link; it stays active if
  // either link was active.
  await tx.$executeRaw`
    UPDATE "RequirementMap" s SET "archivedAt" = NULL
    FROM "RequirementMap" r
    WHERE r."requirementId" = ${retiredId} AND s."requirementId" = ${replacementId}
      AND s."controlId" = r."controlId" AND s."frameworkInstanceId" = r."frameworkInstanceId"
      AND r."archivedAt" IS NULL AND s."archivedAt" IS NOT NULL`;
  const mergedMaps = await tx.$executeRaw`
    DELETE FROM "RequirementMap" r USING "RequirementMap" s
    WHERE r."requirementId" = ${retiredId} AND s."requirementId" = ${replacementId}
      AND s."controlId" = r."controlId" AND s."frameworkInstanceId" = r."frameworkInstanceId"`;
  const movedMaps = await tx.$executeRaw`
    UPDATE "RequirementMap" SET "requirementId" = ${replacementId}
    WHERE "requirementId" = ${retiredId}`;

  await tx.$executeRaw`
    INSERT INTO "_FrameworkEditorControlTemplateToFrameworkEditorRequirement" ("A", "B")
    SELECT "A", ${replacementId} FROM "_FrameworkEditorControlTemplateToFrameworkEditorRequirement"
    WHERE "B" = ${retiredId}
    ON CONFLICT DO NOTHING`;
  const controlTemplateLinks = await tx.$executeRaw`
    DELETE FROM "_FrameworkEditorControlTemplateToFrameworkEditorRequirement"
    WHERE "B" = ${retiredId}`;

  const mergedIsmsLinks = await tx.$executeRaw`
    DELETE FROM "FrameworkEditorIsmsDocumentRequirementLink" r
    USING "FrameworkEditorIsmsDocumentRequirementLink" s
    WHERE r."requirementId" = ${retiredId} AND s."requirementId" = ${replacementId}
      AND s."frameworkId" = r."frameworkId"
      AND s."ismsDocumentTemplateId" = r."ismsDocumentTemplateId"`;
  const movedIsmsLinks = await tx.$executeRaw`
    UPDATE "FrameworkEditorIsmsDocumentRequirementLink" SET "requirementId" = ${replacementId}
    WHERE "requirementId" = ${retiredId}`;
  const ismsDocuments = await tx.$executeRaw`
    UPDATE "IsmsDocument" SET "requirementId" = ${replacementId}
    WHERE "requirementId" = ${retiredId}`;

  const deletedRequirements = await tx.$executeRaw`
    DELETE FROM "FrameworkEditorRequirement"
    WHERE "id" = ${retiredId} AND "frameworkId" = ${SOC2_LEGACY_FRAMEWORK_ID}`;

  return {
    requirementMaps: mergedMaps + movedMaps,
    controlTemplateLinks,
    ismsDocumentLinks: mergedIsmsLinks + movedIsmsLinks,
    ismsDocuments,
    deletedRequirements,
  };
}

/**
 * "SOC 2" 1.0.0 only: retires the requirement records the TSC 2017 realignment removed
 * (soc2-tsc-2017.json `retired`). Installs seeded before the realignment still have them,
 * because the seed upserts and never deletes. Every reference (organization RequirementMap
 * rows, control template links, ISMS links and documents) moves to the replacement
 * criterion first, then the record is deleted, so no organization loses a control link to
 * the cascade. Idempotent: once the records are gone it changes nothing.
 *
 * Pinned framework versions are immutable; organizations see the realigned criteria after
 * a new version is published from the framework editor and they sync to it.
 */
export async function syncSoc2TscRetirements({
  prisma,
  crosswalk = loadSoc2Crosswalk(),
}: {
  prisma: PrismaClient;
  crosswalk?: Soc2Crosswalk;
}): Promise<Soc2TscSyncCounts> {
  const replacements = retiredReplacements({ crosswalk });
  const present = await prisma.frameworkEditorRequirement.findMany({
    where: { id: { in: replacements.flatMap((r) => [r.retiredId, r.replacementId]) } },
    select: { id: true },
  });
  const presentIds = new Set(present.map((r) => r.id));
  const pending = replacements.filter((r) => presentIds.has(r.retiredId));
  const missing = pending.filter((r) => !presentIds.has(r.replacementId));
  if (missing.length > 0) {
    throw new Error(
      `Cannot retire SOC 2 1.0.0 requirements: replacements not seeded: ${missing.map((r) => r.replacementId).join(', ')}`,
    );
  }

  const totals: Soc2TscSyncCounts = {
    requirementMaps: 0,
    controlTemplateLinks: 0,
    ismsDocumentLinks: 0,
    ismsDocuments: 0,
    deletedRequirements: 0,
  };
  await prisma.$transaction(async (tx) => {
    for (const { retiredId, replacementId } of pending) {
      const counts = await moveReferences({ tx, retiredId, replacementId });
      for (const key of Object.keys(totals) as Array<keyof Soc2TscSyncCounts>) {
        totals[key] += counts[key];
      }
    }
  });
  return totals;
}

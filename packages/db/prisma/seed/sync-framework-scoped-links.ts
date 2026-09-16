import type { PrismaClient } from '@prisma/client';
import { CSF_FRAMEWORK_ID, loadCrosswalk } from '../../src/scripts/csf-crosswalk';
import { pairKey, splitKey } from './pair-key';

export interface ScopedLinkCounts {
  policies: number;
  tasks: number;
  documentTypes: number;
}

/**
 * Baseline for every framework: scoped links derived from the global control links of the
 * controls mapped to the framework's requirements. Insert-only (ON CONFLICT DO NOTHING).
 * Fork decision documented in docs/specs/2026-09-15-nist-csf-2-crosswalk-design.md 5.3.
 */
export async function syncFrameworkScopedEditorLinks({ prisma }: { prisma: PrismaClient }): Promise<ScopedLinkCounts> {
  const policies = await prisma.$executeRawUnsafe(`
    INSERT INTO "FrameworkEditorControlPolicyTemplateLink" ("frameworkId", "controlTemplateId", "policyTemplateId")
    SELECT DISTINCT r."frameworkId", cr."A", cp."B"
    FROM "FrameworkEditorRequirement" r
    JOIN "_FrameworkEditorControlTemplateToFrameworkEditorRequirement" cr ON cr."B" = r.id
    JOIN "_FrameworkEditorControlTemplateToFrameworkEditorPolicyTemplate" cp ON cp."A" = cr."A"
    ON CONFLICT ("frameworkId", "controlTemplateId", "policyTemplateId") DO NOTHING
  `);
  const tasks = await prisma.$executeRawUnsafe(`
    INSERT INTO "FrameworkEditorControlTaskTemplateLink" ("frameworkId", "controlTemplateId", "taskTemplateId")
    SELECT DISTINCT r."frameworkId", cr."A", ct."B"
    FROM "FrameworkEditorRequirement" r
    JOIN "_FrameworkEditorControlTemplateToFrameworkEditorRequirement" cr ON cr."B" = r.id
    JOIN "_FrameworkEditorControlTemplateToFrameworkEditorTaskTemplate" ct ON ct."A" = cr."A"
    ON CONFLICT ("frameworkId", "controlTemplateId", "taskTemplateId") DO NOTHING
  `);
  const documentTypes = await prisma.$executeRawUnsafe(`
    INSERT INTO "FrameworkEditorControlDocumentTypeLink" ("frameworkId", "controlTemplateId", "formType")
    SELECT DISTINCT r."frameworkId", c.id, dt.form_type
    FROM "FrameworkEditorRequirement" r
    JOIN "_FrameworkEditorControlTemplateToFrameworkEditorRequirement" cr ON cr."B" = r.id
    JOIN "FrameworkEditorControlTemplate" c ON c.id = cr."A"
    CROSS JOIN LATERAL unnest(c."documentTypes") AS dt(form_type)
    ON CONFLICT ("frameworkId", "controlTemplateId", "formType") DO NOTHING
  `);
  return { policies, tasks, documentTypes };
}

/**
 * CSF only: the crosswalk file is authoritative for requirement->control mappings and for
 * scoped policy/task links (global links of mapped controls plus the crosswalk's CSF-only links).
 */
export async function syncCsfCrosswalk({ prisma }: { prisma: PrismaClient }): Promise<{ requirements: number; removedLinks: number; addedLinks: number }> {
  const crosswalk = loadCrosswalk();

  for (const sub of crosswalk.subcategories) {
    await prisma.frameworkEditorRequirement.update({
      where: { id: sub.requirementId },
      data: { controlTemplates: { set: sub.controls.map((c) => ({ id: c.id })) } },
    });
  }

  const controlIds = [...new Set(crosswalk.subcategories.flatMap((s) => s.controls.map((c) => c.id)))];
  const controls = await prisma.frameworkEditorControlTemplate.findMany({
    where: { id: { in: controlIds } },
    select: { id: true, policyTemplates: { select: { id: true } }, taskTemplates: { select: { id: true } } },
  });
  const targetPolicies = new Set<string>();
  const targetTasks = new Set<string>();
  for (const control of controls) {
    control.policyTemplates.forEach((p) => targetPolicies.add(pairKey({ a: control.id, b: p.id })));
    control.taskTemplates.forEach((t) => targetTasks.add(pairKey({ a: control.id, b: t.id })));
  }
  crosswalk.csfLinks.policies.forEach((l) => targetPolicies.add(pairKey({ a: l.controlTemplateId, b: l.policyTemplateId })));
  crosswalk.csfLinks.tasks.forEach((l) => targetTasks.add(pairKey({ a: l.controlTemplateId, b: l.taskTemplateId })));

  const existingPolicies = await prisma.frameworkEditorControlPolicyTemplateLink.findMany({
    where: { frameworkId: CSF_FRAMEWORK_ID },
    select: { id: true, controlTemplateId: true, policyTemplateId: true },
  });
  const existingTasks = await prisma.frameworkEditorControlTaskTemplateLink.findMany({
    where: { frameworkId: CSF_FRAMEWORK_ID },
    select: { id: true, controlTemplateId: true, taskTemplateId: true },
  });

  const stalePolicyIds = existingPolicies.filter((l) => !targetPolicies.has(pairKey({ a: l.controlTemplateId, b: l.policyTemplateId }))).map((l) => l.id);
  const staleTaskIds = existingTasks.filter((l) => !targetTasks.has(pairKey({ a: l.controlTemplateId, b: l.taskTemplateId }))).map((l) => l.id);
  await prisma.frameworkEditorControlPolicyTemplateLink.deleteMany({ where: { id: { in: stalePolicyIds } } });
  await prisma.frameworkEditorControlTaskTemplateLink.deleteMany({ where: { id: { in: staleTaskIds } } });

  const havePolicies = new Set(existingPolicies.map((l) => pairKey({ a: l.controlTemplateId, b: l.policyTemplateId })));
  const haveTasks = new Set(existingTasks.map((l) => pairKey({ a: l.controlTemplateId, b: l.taskTemplateId })));
  const newPolicies = [...targetPolicies].filter((k) => !havePolicies.has(k)).map((k) => {
    const [controlTemplateId, policyTemplateId] = splitKey(k);
    return { frameworkId: CSF_FRAMEWORK_ID, controlTemplateId, policyTemplateId };
  });
  const newTasks = [...targetTasks].filter((k) => !haveTasks.has(k)).map((k) => {
    const [controlTemplateId, taskTemplateId] = splitKey(k);
    return { frameworkId: CSF_FRAMEWORK_ID, controlTemplateId, taskTemplateId };
  });
  await prisma.frameworkEditorControlPolicyTemplateLink.createMany({ data: newPolicies, skipDuplicates: true });
  await prisma.frameworkEditorControlTaskTemplateLink.createMany({ data: newTasks, skipDuplicates: true });

  return {
    requirements: crosswalk.subcategories.length,
    removedLinks: stalePolicyIds.length + staleTaskIds.length,
    addedLinks: newPolicies.length + newTasks.length,
  };
}

import { EvidenceFormType, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { manifestSchema } from '../../src/framework-manifest';
import { pairKey, splitKey } from './pair-key';

const formTypeSchema = z.enum(EvidenceFormType);

function groupBy<T>({ rows, key }: { rows: T[]; key: (row: T) => string }): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(row);
  }
  return map;
}

/**
 * Instance-level links for pinned instances: insert-only from the pinned manifest; never
 * deletes. User-authored instance links (custom policies, custom controls, links added from
 * the framework control page) are preserved. A template link the user removed from a control
 * is re-added by the next seed run, the same limitation as the unpinned fallback handled by
 * seed.ts's insert-only organization-level backfill.
 */
export async function backfillInstanceLinksFromManifests({ prisma }: { prisma: PrismaClient }): Promise<{ instances: number; skippedTemplates: number }> {
  const instances = await prisma.frameworkInstance.findMany({
    where: { currentVersionId: { not: null } },
    select: { id: true, organizationId: true, currentVersion: { select: { manifest: true } } },
  });
  let skippedTemplates = 0;

  for (const instance of instances) {
    const parsed = manifestSchema.safeParse(instance.currentVersion!.manifest);
    if (!parsed.success) {
      throw new Error(`Invalid manifest for framework instance ${instance.id}: ${parsed.error.message}`);
    }
    const manifest = parsed.data;
    const [controls, policies, tasks] = await Promise.all([
      prisma.control.findMany({ where: { organizationId: instance.organizationId, controlTemplateId: { not: null } }, select: { id: true, controlTemplateId: true } }),
      prisma.policy.findMany({ where: { organizationId: instance.organizationId, policyTemplateId: { not: null } }, select: { id: true, policyTemplateId: true } }),
      prisma.task.findMany({ where: { organizationId: instance.organizationId, taskTemplateId: { not: null } }, select: { id: true, taskTemplateId: true } }),
    ]);
    const controlsByTemplate = groupBy({ rows: controls, key: (c) => c.controlTemplateId! });
    const policiesByTemplate = groupBy({ rows: policies, key: (p) => p.policyTemplateId! });
    const tasksByTemplate = groupBy({ rows: tasks, key: (t) => t.taskTemplateId! });

    const targetPolicy = new Set<string>();
    const targetTask = new Set<string>();
    const targetDoc = new Set<string>();
    const missingTemplateIds = new Set<string>();
    for (const mc of manifest.controls) {
      const orgControls = controlsByTemplate.get(mc.id) ?? [];
      if (orgControls.length === 0) missingTemplateIds.add(mc.id);
      for (const control of orgControls) {
        for (const pid of mc.policyIds) {
          const rows = policiesByTemplate.get(pid) ?? [];
          if (rows.length === 0) missingTemplateIds.add(pid);
          rows.forEach((p) => targetPolicy.add(pairKey({ a: control.id, b: p.id })));
        }
        for (const tid of mc.taskIds) {
          const rows = tasksByTemplate.get(tid) ?? [];
          if (rows.length === 0) missingTemplateIds.add(tid);
          rows.forEach((t) => targetTask.add(pairKey({ a: control.id, b: t.id })));
        }
        (mc.documentTypes ?? []).forEach((formType) => targetDoc.add(pairKey({ a: control.id, b: formType })));
      }
    }
    skippedTemplates += missingTemplateIds.size;

    await insertMissingPolicyLinks({ prisma, instanceId: instance.id, target: targetPolicy });
    await insertMissingTaskLinks({ prisma, instanceId: instance.id, target: targetTask });
    await insertMissingDocumentTypeLinks({ prisma, instanceId: instance.id, target: targetDoc });
  }
  return { instances: instances.length, skippedTemplates };
}

async function insertMissingPolicyLinks({ prisma, instanceId, target }: { prisma: PrismaClient; instanceId: string; target: Set<string> }): Promise<void> {
  const existing = await prisma.frameworkControlPolicyLink.findMany({ where: { frameworkInstanceId: instanceId }, select: { controlId: true, policyId: true } });
  const have = new Set(existing.map((l) => pairKey({ a: l.controlId, b: l.policyId })));
  await prisma.frameworkControlPolicyLink.createMany({
    data: [...target].filter((k) => !have.has(k)).map((k) => {
      const [controlId, policyId] = splitKey(k);
      return { frameworkInstanceId: instanceId, controlId, policyId };
    }),
    skipDuplicates: true,
  });
}

async function insertMissingTaskLinks({ prisma, instanceId, target }: { prisma: PrismaClient; instanceId: string; target: Set<string> }): Promise<void> {
  const existing = await prisma.frameworkControlTaskLink.findMany({ where: { frameworkInstanceId: instanceId }, select: { controlId: true, taskId: true } });
  const have = new Set(existing.map((l) => pairKey({ a: l.controlId, b: l.taskId })));
  await prisma.frameworkControlTaskLink.createMany({
    data: [...target].filter((k) => !have.has(k)).map((k) => {
      const [controlId, taskId] = splitKey(k);
      return { frameworkInstanceId: instanceId, controlId, taskId };
    }),
    skipDuplicates: true,
  });
}

async function insertMissingDocumentTypeLinks({ prisma, instanceId, target }: { prisma: PrismaClient; instanceId: string; target: Set<string> }): Promise<void> {
  const existing = await prisma.frameworkControlDocumentTypeLink.findMany({ where: { frameworkInstanceId: instanceId }, select: { controlId: true, formType: true } });
  const have = new Set(existing.map((l) => pairKey({ a: l.controlId, b: l.formType })));
  await prisma.frameworkControlDocumentTypeLink.createMany({
    data: [...target].filter((k) => !have.has(k)).map((k) => {
      const [controlId, formType] = splitKey(k);
      return { frameworkInstanceId: instanceId, controlId, formType: formTypeSchema.parse(formType) };
    }),
    skipDuplicates: true,
  });
}

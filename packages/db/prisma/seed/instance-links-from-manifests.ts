import { EvidenceFormType, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { FrameworkManifest } from '../../src/framework-manifest';

const formTypeSchema = z.nativeEnum(EvidenceFormType);

function pairKey({ a, b }: { a: string; b: string }): string {
  return `${a}|${b}`;
}

function splitKey(key: string): [string, string] {
  const [a, b] = key.split('|');
  if (!a || !b) throw new Error(`Malformed pair key: ${key}`);
  return [a, b];
}

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
 * Instance-level links for pinned instances: the exact set implied by the pinned manifest
 * (insert missing, delete extra). Unpinned instances are handled by seed.ts's insert-only
 * organization-level fallback.
 */
export async function backfillInstanceLinksFromManifests({ prisma }: { prisma: PrismaClient }): Promise<{ instances: number; skippedTemplates: number }> {
  const instances = await prisma.frameworkInstance.findMany({
    where: { currentVersionId: { not: null } },
    select: { id: true, organizationId: true, currentVersion: { select: { manifest: true } } },
  });
  let skippedTemplates = 0;

  for (const instance of instances) {
    const manifest = instance.currentVersion!.manifest as unknown as FrameworkManifest;
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
    for (const mc of manifest.controls) {
      const orgControls = controlsByTemplate.get(mc.id) ?? [];
      if (orgControls.length === 0) skippedTemplates += 1;
      for (const control of orgControls) {
        for (const pid of mc.policyIds) {
          const rows = policiesByTemplate.get(pid) ?? [];
          if (rows.length === 0) skippedTemplates += 1;
          rows.forEach((p) => targetPolicy.add(pairKey({ a: control.id, b: p.id })));
        }
        for (const tid of mc.taskIds) {
          const rows = tasksByTemplate.get(tid) ?? [];
          if (rows.length === 0) skippedTemplates += 1;
          rows.forEach((t) => targetTask.add(pairKey({ a: control.id, b: t.id })));
        }
        (mc.documentTypes ?? []).forEach((formType) => targetDoc.add(pairKey({ a: control.id, b: formType })));
      }
    }

    await reconcilePolicyLinks({ prisma, instanceId: instance.id, target: targetPolicy });
    await reconcileTaskLinks({ prisma, instanceId: instance.id, target: targetTask });
    await reconcileDocumentTypeLinks({ prisma, instanceId: instance.id, target: targetDoc });
  }
  return { instances: instances.length, skippedTemplates };
}

async function reconcilePolicyLinks({ prisma, instanceId, target }: { prisma: PrismaClient; instanceId: string; target: Set<string> }): Promise<void> {
  const existing = await prisma.frameworkControlPolicyLink.findMany({ where: { frameworkInstanceId: instanceId }, select: { id: true, controlId: true, policyId: true } });
  const have = new Set(existing.map((l) => pairKey({ a: l.controlId, b: l.policyId })));
  await prisma.frameworkControlPolicyLink.deleteMany({ where: { id: { in: existing.filter((l) => !target.has(pairKey({ a: l.controlId, b: l.policyId }))).map((l) => l.id) } } });
  await prisma.frameworkControlPolicyLink.createMany({
    data: [...target].filter((k) => !have.has(k)).map((k) => {
      const [controlId, policyId] = splitKey(k);
      return { frameworkInstanceId: instanceId, controlId, policyId };
    }),
    skipDuplicates: true,
  });
}

async function reconcileTaskLinks({ prisma, instanceId, target }: { prisma: PrismaClient; instanceId: string; target: Set<string> }): Promise<void> {
  const existing = await prisma.frameworkControlTaskLink.findMany({ where: { frameworkInstanceId: instanceId }, select: { id: true, controlId: true, taskId: true } });
  const have = new Set(existing.map((l) => pairKey({ a: l.controlId, b: l.taskId })));
  await prisma.frameworkControlTaskLink.deleteMany({ where: { id: { in: existing.filter((l) => !target.has(pairKey({ a: l.controlId, b: l.taskId }))).map((l) => l.id) } } });
  await prisma.frameworkControlTaskLink.createMany({
    data: [...target].filter((k) => !have.has(k)).map((k) => {
      const [controlId, taskId] = splitKey(k);
      return { frameworkInstanceId: instanceId, controlId, taskId };
    }),
    skipDuplicates: true,
  });
}

async function reconcileDocumentTypeLinks({ prisma, instanceId, target }: { prisma: PrismaClient; instanceId: string; target: Set<string> }): Promise<void> {
  const existing = await prisma.frameworkControlDocumentTypeLink.findMany({ where: { frameworkInstanceId: instanceId }, select: { id: true, controlId: true, formType: true } });
  const have = new Set(existing.map((l) => pairKey({ a: l.controlId, b: l.formType })));
  await prisma.frameworkControlDocumentTypeLink.deleteMany({ where: { id: { in: existing.filter((l) => !target.has(pairKey({ a: l.controlId, b: l.formType }))).map((l) => l.id) } } });
  await prisma.frameworkControlDocumentTypeLink.createMany({
    data: [...target].filter((k) => !have.has(k)).map((k) => {
      const [controlId, formType] = splitKey(k);
      return { frameworkInstanceId: instanceId, controlId, formType: formTypeSchema.parse(formType) };
    }),
    skipDuplicates: true,
  });
}

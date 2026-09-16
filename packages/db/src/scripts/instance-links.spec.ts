import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { db } from '../client';
import type { FrameworkManifest } from '../framework-manifest';
import { CSF_FRAMEWORK_ID, loadCrosswalk } from './csf-crosswalk';
import { backfillInstanceLinksFromManifests } from '../../prisma/seed/instance-links-from-manifests';

const dbUrl = process.env.DATABASE_URL ?? '';
const isScratchDb = dbUrl.includes('test') && !dbUrl.includes('prod') && !dbUrl.includes('staging');

// Mirrors csf-seed.spec.ts: the seed takes well over bun's 5s default timeout.
setDefaultTimeout(180_000);

const SOC2_FRAMEWORK_ID = 'frk_683f377429b8408d1c85f9bd';
const SEED = path.resolve(__dirname, '..', '..', 'prisma', 'seed', 'seed.ts');

// Access Rights: a control template shared by the SOC 2 and CSF manifests.
const CONTROL_TEMPLATE_ID = 'frk_ct_683f4a410cf5bf6d40bf3583';
// Role-based Access Controls: a CSF-only task link on that control (from the crosswalk).
const CSF_ONLY_TASK_TEMPLATE_ID = 'frk_tt_68e80544d9734e0402cfa807';

function runSeed(): void {
  execSync(`bun ${SEED}`, { stdio: 'pipe', env: process.env });
}

function findManifestControl({ manifest, controlTemplateId }: { manifest: FrameworkManifest; controlTemplateId: string }) {
  const control = manifest.controls.find((c) => c.id === controlTemplateId);
  if (!control) throw new Error(`Control template ${controlTemplateId} not found in manifest`);
  return control;
}

describe.skipIf(!isScratchDb)('instance links from pinned manifests', () => {
  let orgId: string;

  beforeAll(async () => {
    runSeed();
  });

  afterAll(async () => {
    if (orgId) await db.organization.delete({ where: { id: orgId } });
  });

  it('are insert-only and isolated per instance', async () => {
    const [soc2Version, csfVersion] = await Promise.all([
      db.frameworkVersion.findUniqueOrThrow({
        where: { frameworkId_version: { frameworkId: SOC2_FRAMEWORK_ID, version: '1.0.0' } },
      }),
      db.frameworkVersion.findUniqueOrThrow({
        where: { frameworkId_version: { frameworkId: CSF_FRAMEWORK_ID, version: '1.0.0' } },
      }),
    ]);
    const soc2Manifest = soc2Version.manifest as unknown as FrameworkManifest;
    const csfManifest = csfVersion.manifest as unknown as FrameworkManifest;
    const soc2Control = findManifestControl({ manifest: soc2Manifest, controlTemplateId: CONTROL_TEMPLATE_ID });
    const csfControl = findManifestControl({ manifest: csfManifest, controlTemplateId: CONTROL_TEMPLATE_ID });

    // Fixture sanity: the CSF-only task is on the CSF manifest control, not the SOC 2 one.
    expect(loadCrosswalk().csfLinks.tasks).toContainEqual({
      controlTemplateId: CONTROL_TEMPLATE_ID,
      taskTemplateId: CSF_ONLY_TASK_TEMPLATE_ID,
    });
    expect(csfControl.taskIds).toContain(CSF_ONLY_TASK_TEMPLATE_ID);
    expect(soc2Control.taskIds).not.toContain(CSF_ONLY_TASK_TEMPLATE_ID);

    const org = await db.organization.create({ data: { name: `csf-test-org-${Date.now()}` } });
    orgId = org.id;

    const [soc2Instance, csfInstance] = await Promise.all([
      db.frameworkInstance.create({
        data: { organizationId: org.id, frameworkId: SOC2_FRAMEWORK_ID, currentVersionId: soc2Version.id },
      }),
      db.frameworkInstance.create({
        data: { organizationId: org.id, frameworkId: CSF_FRAMEWORK_ID, currentVersionId: csfVersion.id },
      }),
    ]);

    const control = await db.control.create({
      data: { organizationId: org.id, name: 'Access Rights', description: 'test', controlTemplateId: CONTROL_TEMPLATE_ID },
    });
    const policies = await Promise.all(
      soc2Control.policyIds.map((policyTemplateId) =>
        db.policy.create({
          data: { organizationId: org.id, name: `policy-${policyTemplateId}`, content: [], policyTemplateId },
        }),
      ),
    );
    const customPolicy = await db.policy.create({
      data: { organizationId: org.id, name: 'custom-policy', content: [] },
    });
    const tasks = await Promise.all(
      csfControl.taskIds.map((taskTemplateId) =>
        db.task.create({
          data: { organizationId: org.id, title: `task-${taskTemplateId}`, description: 'test', taskTemplateId },
        }),
      ),
    );
    const taskRowByTemplateId = new Map(tasks.map((t) => [t.taskTemplateId as string, t.id]));
    const policyRowByTemplateId = new Map(policies.map((p) => [p.policyTemplateId as string, p.id]));

    await db.frameworkControlPolicyLink.create({
      data: { frameworkInstanceId: soc2Instance.id, controlId: control.id, policyId: customPolicy.id },
    });

    await backfillInstanceLinksFromManifests({ prisma: db });

    const expectedSoc2TaskIds = soc2Control.taskIds.map((id) => taskRowByTemplateId.get(id)!).sort();
    const soc2TaskLinks = await db.frameworkControlTaskLink.findMany({
      where: { frameworkInstanceId: soc2Instance.id },
      select: { taskId: true },
    });
    expect(soc2TaskLinks.map((l) => l.taskId).sort()).toEqual(expectedSoc2TaskIds);
    expect(soc2TaskLinks.map((l) => l.taskId)).not.toContain(taskRowByTemplateId.get(CSF_ONLY_TASK_TEMPLATE_ID));

    const csfTaskLinks = await db.frameworkControlTaskLink.findMany({
      where: { frameworkInstanceId: csfInstance.id },
      select: { taskId: true },
    });
    expect(csfTaskLinks.map((l) => l.taskId)).toContain(taskRowByTemplateId.get(CSF_ONLY_TASK_TEMPLATE_ID));

    const expectedSoc2PolicyIds = [...soc2Control.policyIds.map((id) => policyRowByTemplateId.get(id)!), customPolicy.id].sort();
    const soc2PolicyLinks = await db.frameworkControlPolicyLink.findMany({
      where: { frameworkInstanceId: soc2Instance.id },
      select: { policyId: true },
    });
    expect(soc2PolicyLinks.map((l) => l.policyId).sort()).toEqual(expectedSoc2PolicyIds);

    const countsBefore = await Promise.all([
      db.frameworkControlTaskLink.count({ where: { frameworkInstanceId: { in: [soc2Instance.id, csfInstance.id] } } }),
      db.frameworkControlPolicyLink.count({ where: { frameworkInstanceId: { in: [soc2Instance.id, csfInstance.id] } } }),
    ]);
    await backfillInstanceLinksFromManifests({ prisma: db });
    const countsAfter = await Promise.all([
      db.frameworkControlTaskLink.count({ where: { frameworkInstanceId: { in: [soc2Instance.id, csfInstance.id] } } }),
      db.frameworkControlPolicyLink.count({ where: { frameworkInstanceId: { in: [soc2Instance.id, csfInstance.id] } } }),
    ]);
    expect(countsAfter).toEqual(countsBefore);

    const soc2PolicyLinksAfter = await db.frameworkControlPolicyLink.findMany({
      where: { frameworkInstanceId: soc2Instance.id },
      select: { policyId: true },
    });
    expect(soc2PolicyLinksAfter.map((l) => l.policyId).sort()).toEqual(expectedSoc2PolicyIds);
  });
});

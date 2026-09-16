import type {
  FrameworkManifest,
  ManifestControl,
  ManifestPolicy,
  ManifestTask,
} from './manifest.types';

/** Query argument for `frameworkEditorFramework.findUnique`, usable with any generated client. */
export function manifestFrameworkQuery(frameworkId: string) {
  return {
    where: { id: frameworkId },
    include: {
      requirements: {
        orderBy: [
          { sortOrder: { sort: 'asc' as const, nulls: 'last' as const } },
          { identifier: 'asc' as const },
          { name: 'asc' as const },
        ],
        include: {
          controlTemplates: {
            include: {
              requirements: { select: { id: true } },
              frameworkPolicyLinks: { where: { frameworkId }, include: { policyTemplate: true } },
              frameworkTaskLinks: { where: { frameworkId }, include: { taskTemplate: true } },
              frameworkDocumentLinks: { where: { frameworkId }, select: { formType: true } },
            },
          },
        },
      },
    },
  };
}

/** Structural shape of the query result; both generated Prisma clients satisfy it. */
export interface ManifestFrameworkSource {
  id: string;
  name: string;
  version: string;
  description: string | null;
  requirements: Array<{
    id: string;
    identifier: string;
    name: string;
    description: string | null;
    requirementFamily: string | null;
    sortOrder: number | null;
    controlTemplates: Array<{
      id: string;
      name: string;
      description: string;
      controlFamily: string | null;
      requirements: Array<{ id: string }>;
      frameworkPolicyLinks: Array<{ policyTemplate: ManifestPolicy }>;
      frameworkTaskLinks: Array<{ taskTemplate: ManifestTask }>;
      frameworkDocumentLinks: Array<{ formType: string }>;
    }>;
  }>;
}

function sortedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

function sortById<T extends { id: string }>(items: Iterable<T>): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

export function buildManifestFromFramework(framework: ManifestFrameworkSource): FrameworkManifest {
  const ownRequirementIds = new Set(framework.requirements.map((r) => r.id));
  const controls = new Map<string, ManifestControl>();
  const policies = new Map<string, ManifestPolicy>();
  const tasks = new Map<string, ManifestTask>();

  for (const requirement of framework.requirements) {
    for (const ct of requirement.controlTemplates) {
      const policyTemplates = ct.frameworkPolicyLinks.map((link) => link.policyTemplate);
      const taskTemplates = ct.frameworkTaskLinks.map((link) => link.taskTemplate);
      // A control template can be nested under more than one requirement in
      // this framework; merge (rather than overwrite) so the aggregate
      // fields reflect every occurrence, not just the first one seen.
      const existing = controls.get(ct.id);
      controls.set(ct.id, {
        id: ct.id,
        name: ct.name,
        description: ct.description,
        controlFamily: ct.controlFamily || null,
        requirementIds: sortedIds([
          ...(existing?.requirementIds ?? []),
          ...ct.requirements.map((r) => r.id).filter((id) => ownRequirementIds.has(id)),
        ]),
        policyIds: sortedIds([...(existing?.policyIds ?? []), ...policyTemplates.map((p) => p.id)]),
        taskIds: sortedIds([...(existing?.taskIds ?? []), ...taskTemplates.map((t) => t.id)]),
        documentTypes: sortedIds([
          ...(existing?.documentTypes ?? []),
          ...ct.frameworkDocumentLinks.map((link) => link.formType),
        ]),
      });
      for (const policy of policyTemplates) {
        if (!policies.has(policy.id)) {
          policies.set(policy.id, {
            id: policy.id,
            name: policy.name,
            description: policy.description,
            content: policy.content,
            frequency: policy.frequency,
            department: policy.department,
          });
        }
      }
      for (const task of taskTemplates) {
        if (!tasks.has(task.id)) {
          tasks.set(task.id, {
            id: task.id,
            name: task.name,
            description: task.description,
            frequency: task.frequency,
            department: task.department,
          });
        }
      }
    }
  }

  return {
    framework: {
      id: framework.id,
      name: framework.name,
      catalogVersion: framework.version,
      description: framework.description,
    },
    requirements: framework.requirements.map((r) => ({
      id: r.id,
      identifier: r.identifier,
      name: r.name,
      description: r.description,
      requirementFamily: r.requirementFamily || null,
      sortOrder: r.sortOrder ?? null,
    })),
    controls: sortById(controls.values()),
    policies: sortById(policies.values()),
    tasks: sortById(tasks.values()),
  };
}

import fs from 'node:fs';
import path from 'node:path';
import {
  CSF_FRAMEWORK_ID,
  PRIMITIVES_DIR,
  RELATIONS_DIR,
  loadCrosswalk,
  loadCsfCore,
  readJsonArray,
  serializeJsonArray,
  writeJsonArray,
} from './csf-crosswalk';

type Framework = { id: string; visible: boolean; [key: string]: unknown };
type Requirement = {
  id: string;
  frameworkId: string;
  name: string;
  identifier: string;
  description: string;
  requirementFamily?: string;
  sortOrder?: number;
  [key: string]: unknown;
};
type ControlTemplate = { id: string; name: string; description: string; [key: string]: unknown };
type TaskTemplate = { id: string; name: string; description: string; [key: string]: unknown };
type Pair = { A: string; B: string };

export interface SeedState {
  frameworks: Framework[];
  requirements: Requirement[];
  controls: ControlTemplate[];
  tasks: TaskTemplate[];
  controlRequirementPairs: Pair[];
  controlPolicyPairs: Pair[];
  controlTaskPairs: Pair[];
}

const FILES = {
  frameworks: path.join(PRIMITIVES_DIR, 'FrameworkEditorFramework.json'),
  requirements: path.join(PRIMITIVES_DIR, 'FrameworkEditorRequirement.json'),
  controls: path.join(PRIMITIVES_DIR, 'FrameworkEditorControlTemplate.json'),
  tasks: path.join(PRIMITIVES_DIR, 'FrameworkEditorTaskTemplate.json'),
  controlRequirementPairs: path.join(RELATIONS_DIR, '_FrameworkEditorControlTemplateToFrameworkEditorRequirement.json'),
  controlPolicyPairs: path.join(RELATIONS_DIR, '_FrameworkEditorControlTemplateToFrameworkEditorPolicyTemplate.json'),
  controlTaskPairs: path.join(RELATIONS_DIR, '_FrameworkEditorControlTemplateToFrameworkEditorTaskTemplate.json'),
} as const;

const SEED_TIMESTAMP = '2026-09-15 00:00:00.000';

function byPair(a: Pair, b: Pair): number {
  return a.A.localeCompare(b.A) || a.B.localeCompare(b.B);
}

function upsertRows<T extends { id: string }>(rows: T[], additions: T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const row of additions) byId.set(row.id, { ...byId.get(row.id), ...row });
  return [...byId.values()];
}

function mergePairs(existing: Pair[], additions: Pair[]): Pair[] {
  const seen = new Set(existing.map((p) => `${p.A}|${p.B}`));
  const merged = [...existing];
  for (const p of additions) {
    if (seen.has(`${p.A}|${p.B}`)) continue;
    seen.add(`${p.A}|${p.B}`);
    merged.push(p);
  }
  return merged;
}

export function computeSeedState(): SeedState {
  const core = loadCsfCore();
  const crosswalk = loadCrosswalk();
  const subById = new Map(core.subcategories.map((s) => [s.id, s]));
  const orderIndex = new Map(core.subcategories.map((s, i) => [s.id, i]));

  const frameworks = readJsonArray<Framework>(FILES.frameworks).map((f) =>
    f.id === CSF_FRAMEWORK_ID ? { ...f, visible: true } : f,
  );

  const requirementUpdates = new Map(
    crosswalk.subcategories.map((s) => {
      const sub = subById.get(s.id);
      if (!sub) throw new Error(`Crosswalk subcategory ${s.id} is not in the official core`);
      return [
        s.requirementId,
        {
          identifier: s.id,
          name: core.categories[sub.category]!.name,
          description: sub.text,
          requirementFamily: core.functions[sub.function]!.name,
          sortOrder: orderIndex.get(s.id)!,
        },
      ];
    }),
  );
  const requirements = readJsonArray<Requirement>(FILES.requirements).map((r) => {
    const update = requirementUpdates.get(r.id);
    if (!update) return r;
    if (r.frameworkId !== CSF_FRAMEWORK_ID) throw new Error(`Requirement ${r.id} is not a CSF requirement`);
    return { ...r, ...update };
  });
  const csfRequirementIds = new Set(requirementUpdates.keys());

  const controls = upsertRows(
    readJsonArray<ControlTemplate>(FILES.controls),
    crosswalk.newControls.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      createdAt: SEED_TIMESTAMP,
      updatedAt: SEED_TIMESTAMP,
      documentTypes: [],
    })),
  );
  const tasks = upsertRows(
    readJsonArray<TaskTemplate>(FILES.tasks),
    crosswalk.newTasks.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      frequency: t.frequency,
      department: t.department,
      createdAt: SEED_TIMESTAMP,
      updatedAt: SEED_TIMESTAMP,
      automationStatus: 'MANUAL',
    })),
  );

  const existingPairs = readJsonArray<Pair>(FILES.controlRequirementPairs);
  const nonCsf = existingPairs.filter((p) => !csfRequirementIds.has(p.B));
  const csfPairs = crosswalk.subcategories
    .flatMap((s) => s.controls.map((c) => ({ A: c.id, B: s.requirementId })))
    .sort(byPair);
  const controlRequirementPairs = [...nonCsf, ...csfPairs];

  const controlPolicyPairs = mergePairs(
    readJsonArray<Pair>(FILES.controlPolicyPairs),
    crosswalk.newControls.flatMap((c) => c.policies.map((p) => ({ A: c.id, B: p.id }))),
  );
  const controlTaskPairs = mergePairs(
    readJsonArray<Pair>(FILES.controlTaskPairs),
    crosswalk.newControls.flatMap((c) => c.tasks.map((t) => ({ A: c.id, B: t.id }))),
  );

  return { frameworks, requirements, controls, tasks, controlRequirementPairs, controlPolicyPairs, controlTaskPairs };
}

export interface ApplyResult {
  changedFiles: string[];
}

export function applyCsfCrosswalk({ dryRun }: { dryRun: boolean }): ApplyResult {
  const state = computeSeedState();
  const outputs: Array<[string, unknown[]]> = [
    [FILES.frameworks, state.frameworks],
    [FILES.requirements, state.requirements],
    [FILES.controls, state.controls],
    [FILES.tasks, state.tasks],
    [FILES.controlRequirementPairs, state.controlRequirementPairs],
    [FILES.controlPolicyPairs, state.controlPolicyPairs],
    [FILES.controlTaskPairs, state.controlTaskPairs],
  ];
  const changedFiles: string[] = [];
  for (const [filePath, rows] of outputs) {
    const next = serializeJsonArray(rows);
    const current = fs.readFileSync(filePath, 'utf8');
    if (current === next) continue;
    changedFiles.push(filePath);
    if (!dryRun) writeJsonArray({ filePath, rows });
  }
  return { changedFiles };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--check');
  const result = applyCsfCrosswalk({ dryRun });
  console.log(dryRun ? 'Would change:' : 'Changed:', result.changedFiles.length ? result.changedFiles : '(nothing)');
  process.exit(dryRun && result.changedFiles.length > 0 ? 1 : 0);
}

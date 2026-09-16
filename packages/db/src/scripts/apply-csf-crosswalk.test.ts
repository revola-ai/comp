import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { computeSeedState } from './apply-csf-crosswalk';
import {
  CSF_FRAMEWORK_ID,
  PRIMITIVES_DIR,
  RELATIONS_DIR,
  loadCrosswalk,
  loadCsfCore,
  readJsonArray,
} from './csf-crosswalk';

type Framework = { id: string; visible: boolean };
type Requirement = {
  id: string;
  frameworkId: string;
  name: string;
  identifier: string;
  description: string;
  requirementFamily?: string;
  sortOrder?: number;
};
type ControlTemplate = { id: string; name: string; description: string };
type PolicyTemplate = { id: string; name: string; content: unknown };
type TaskTemplate = { id: string; name: string; description: string };
type Pair = { A: string; B: string };

const core = loadCsfCore();
const crosswalk = loadCrosswalk();
const state = computeSeedState();
const csfIds = new Set(crosswalk.subcategories.map((s) => s.requirementId));

function tiptapText(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => tiptapText(n, out));
  else if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') out.push(record.text);
    Object.values(record).forEach((v) => tiptapText(v, out));
  }
  return out;
}

describe('crosswalk coverage', () => {
  it('maps every official subcategory exactly once', () => {
    const ids = crosswalk.subcategories.map((s) => s.id);
    expect(new Set(ids).size).toBe(106);
    expect(ids.sort()).toEqual(core.subcategories.map((s) => s.id).sort());
  });

  it('references controls, policies and tasks that exist with exactly the recorded names', () => {
    const controls = new Map(state.controls.map((c) => [c.id, c]));
    const policies = new Map(
      readJsonArray<PolicyTemplate>(
        path.join(PRIMITIVES_DIR, 'FrameworkEditorPolicyTemplate.json'),
      ).map((p) => [p.id, p]),
    );
    const tasks = new Map(state.tasks.map((t) => [t.id, t]));
    for (const s of crosswalk.subcategories) {
      for (const ref of s.controls) expect(controls.get(ref.id)?.name).toBe(ref.name);
    }
    for (const nc of crosswalk.newControls) {
      for (const ref of nc.policies) expect(policies.get(ref.id)?.name).toBe(ref.name);
      for (const ref of nc.tasks) expect(tasks.get(ref.id)?.name).toBe(ref.name);
    }
    for (const link of crosswalk.csfLinks.policies) {
      expect(controls.has(link.controlTemplateId)).toBe(true);
      expect(policies.has(link.policyTemplateId)).toBe(true);
    }
    for (const link of crosswalk.csfLinks.tasks) {
      expect(controls.has(link.controlTemplateId)).toBe(true);
      expect(tasks.has(link.taskTemplateId)).toBe(true);
    }
  });

  it('leaves no CSF control without a policy and a task', () => {
    const policyOf = new Map<string, Set<string>>();
    const taskOf = new Map<string, Set<string>>();
    const add = ({ map, a, b }: { map: Map<string, Set<string>>; a: string; b: string }) => {
      if (!map.has(a)) map.set(a, new Set());
      map.get(a)!.add(b);
    };
    state.controlPolicyPairs.forEach((p) => add({ map: policyOf, a: p.A, b: p.B }));
    state.controlTaskPairs.forEach((p) => add({ map: taskOf, a: p.A, b: p.B }));
    crosswalk.csfLinks.policies.forEach((l) =>
      add({ map: policyOf, a: l.controlTemplateId, b: l.policyTemplateId }),
    );
    crosswalk.csfLinks.tasks.forEach((l) =>
      add({ map: taskOf, a: l.controlTemplateId, b: l.taskTemplateId }),
    );
    const used = new Set(crosswalk.subcategories.flatMap((s) => s.controls.map((c) => c.id)));
    for (const id of used) {
      expect(policyOf.get(id)?.size ?? 0).toBeGreaterThan(0);
      expect(taskOf.get(id)?.size ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('generated seed files', () => {
  it('committed files equal the generator output (no hand edits)', () => {
    const committed = {
      frameworks: readJsonArray<Framework>(
        path.join(PRIMITIVES_DIR, 'FrameworkEditorFramework.json'),
      ),
      requirements: readJsonArray<Requirement>(
        path.join(PRIMITIVES_DIR, 'FrameworkEditorRequirement.json'),
      ),
      controls: readJsonArray<ControlTemplate>(
        path.join(PRIMITIVES_DIR, 'FrameworkEditorControlTemplate.json'),
      ),
      tasks: readJsonArray<TaskTemplate>(
        path.join(PRIMITIVES_DIR, 'FrameworkEditorTaskTemplate.json'),
      ),
      controlRequirementPairs: readJsonArray<Pair>(
        path.join(
          RELATIONS_DIR,
          '_FrameworkEditorControlTemplateToFrameworkEditorRequirement.json',
        ),
      ),
      controlPolicyPairs: readJsonArray<Pair>(
        path.join(
          RELATIONS_DIR,
          '_FrameworkEditorControlTemplateToFrameworkEditorPolicyTemplate.json',
        ),
      ),
      controlTaskPairs: readJsonArray<Pair>(
        path.join(
          RELATIONS_DIR,
          '_FrameworkEditorControlTemplateToFrameworkEditorTaskTemplate.json',
        ),
      ),
    };
    expect(committed).toEqual({
      frameworks: state.frameworks,
      requirements: state.requirements,
      controls: state.controls,
      tasks: state.tasks,
      controlRequirementPairs: state.controlRequirementPairs,
      controlPolicyPairs: state.controlPolicyPairs,
      controlTaskPairs: state.controlTaskPairs,
    });
    expect(state.frameworks.find((f) => f.id === CSF_FRAMEWORK_ID)?.visible).toBe(true);
  });

  it('keeps the 1453 pre-existing non-CSF requirement links untouched', () => {
    const committed = JSON.parse(
      fs.readFileSync(
        path.join(
          RELATIONS_DIR,
          '_FrameworkEditorControlTemplateToFrameworkEditorRequirement.json',
        ),
        'utf8',
      ),
    ) as Pair[];
    const nonCsfCommitted = committed.filter((p) => !csfIds.has(p.B));
    const nonCsfGenerated = state.controlRequirementPairs.filter((p) => !csfIds.has(p.B));
    expect(nonCsfCommitted).toHaveLength(1453);
    expect(nonCsfGenerated).toEqual(nonCsfCommitted);
    expect(state.controlRequirementPairs.length - nonCsfGenerated.length).toBe(172);
  });

  it('writes NIST text, category name, Function name and order into the 106 rows', () => {
    const byId = new Map(core.subcategories.map((s) => [s.id, s]));
    const csfRows = state.requirements.filter((r) => r.frameworkId === CSF_FRAMEWORK_ID);
    expect(csfRows).toHaveLength(106);
    for (const row of csfRows) {
      const sub = byId.get(row.identifier)!;
      expect(row.description).toBe(sub.text);
      expect(row.name).toBe(core.categories[sub.category]!.name);
      expect(row.requirementFamily).toBe(core.functions[sub.function]!.name);
    }
    const order = csfRows.sort((a, b) => a.sortOrder! - b.sortOrder!).map((r) => r.identifier);
    expect(order).toEqual(core.subcategories.map((s) => s.id));
  });

  it('every quoted span in a rationale is an exact substring of a text belonging to a mapped control', () => {
    const controls = new Map(state.controls.map((c) => [c.id, c]));
    const policies = new Map(
      readJsonArray<PolicyTemplate>(
        path.join(PRIMITIVES_DIR, 'FrameworkEditorPolicyTemplate.json'),
      ).map((p) => [p.id, p]),
    );
    const tasks = new Map(state.tasks.map((t) => [t.id, t]));
    const policyIdsOf = (id: string) => [
      ...state.controlPolicyPairs.filter((p) => p.A === id).map((p) => p.B),
      ...crosswalk.csfLinks.policies
        .filter((l) => l.controlTemplateId === id)
        .map((l) => l.policyTemplateId),
    ];
    const taskIdsOf = (id: string) => [
      ...state.controlTaskPairs.filter((p) => p.A === id).map((p) => p.B),
      ...crosswalk.csfLinks.tasks
        .filter((l) => l.controlTemplateId === id)
        .map((l) => l.taskTemplateId),
    ];
    for (const s of crosswalk.subcategories) {
      const texts: string[] = [];
      for (const ref of s.controls) {
        const c = controls.get(ref.id)!;
        texts.push(c.name, c.description);
        for (const pid of policyIdsOf(c.id)) {
          const p = policies.get(pid)!;
          texts.push(p.name, tiptapText(p.content).join(' '));
        }
        for (const tid of taskIdsOf(c.id)) {
          const t = tasks.get(tid)!;
          texts.push(t.name, t.description);
        }
      }
      for (const quoted of s.rationale.match(/"([^"]+)"/g) ?? []) {
        const span = quoted.slice(1, -1);
        expect(texts.some((t) => t.includes(span))).toBe(true);
      }
    }
  });
});

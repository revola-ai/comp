# NIST CSF 2.0 Enablement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NIST CSF 2.0 selectable in this self-hosted Comp instance with all 106 subcategories mapped to controls that carry policies and evidence tasks, driven by a committed crosswalk file and reproducible seed.

**Architecture:** A crosswalk JSON is the source of truth; a generator rewrites the CSF rows of the seed files from it; a new seed step syncs framework-scoped editor links (authoritative for CSF, insert-only baseline for other frameworks); one pure manifest builder in `packages/db` is used by both the API's publish path and the seed's version backfill; the instance-level backfill derives links from each instance's pinned manifest.

**Tech Stack:** Bun 1.4, TypeScript, Prisma 7 (Postgres), `bun:test`, NestJS (API), Turbo.

**Spec:** `docs/specs/2026-09-15-nist-csf-2-crosswalk-design.md` (revision 4). The plan argues from the spec; read both.

## Global Constraints

- Branch `revola/csf-2.0`. Conventional commits (`<type>(<scope>): <description>`), never `--no-verify`, never `git stash`.
- Package manager `bun` only. Node 22 via `nvm use` (Prisma rejects Node 23).
- Max 300 lines per file; no `as any`; no `@ts-ignore`; zod for runtime validation; early returns; named parameters for functions with 2+ arguments.
- No em dashes in any file.
- `packages/db` tests use `bun:test` against the local database and must keep the existing destructive-test guard (`DATABASE_URL` must contain `localhost`, `127.0.0.1` or `test`, and not `prod`/`staging`).
- Database tests run against this machine's seeded database (`postgresql://postgres:postgres@127.0.0.1:5432/comp`); they must be idempotent and must not delete the organization `org_6aa9b0797c69fd27a4fc05ad` or its SOC 2 instance.
- The stack is stopped while implementing: `scripts/local-run.sh stop`; start containers only: `bun docker:up` in `packages/db` (Postgres) when a task needs the database.
- Ids for new templates are deterministic: prefix + first 24 hex characters of `sha256(name)`, matching the shape of existing ids (`frk_ct_683f42c71eea99f22f9df060`).
- CSF framework id: `frk_6820090a1653380dd386c5eb`. SOC 2 framework id: `frk_683f377429b8408d1c85f9bd`.

---

## File map

Created:

- `packages/db/prisma/seed/crosswalks/nist-csf-2.0-core.json` - parsed official NIST core (106 subcategories: id, category, function, text, sp800_53, iso27001; categories; functions).
- `packages/db/prisma/seed/crosswalks/nist-csf-2.0.json` - the crosswalk (per subcategory: requirementId, controls, rationale; new controls; new tasks; CSF-only links).
- `packages/db/src/framework-manifest/manifest.types.ts` - `FrameworkManifest` and related types (moved from the API).
- `packages/db/src/framework-manifest/build-manifest.ts` - `manifestFrameworkQuery(frameworkId)` and pure `buildManifestFromFramework(framework)`.
- `packages/db/src/framework-manifest/build-manifest.test.ts` - unit tests (no database).
- `packages/db/src/framework-manifest/index.ts` - barrel.
- `packages/db/src/scripts/csf-crosswalk.ts` - crosswalk file loading and validation (shared by generator, seed and tests).
- `packages/db/src/scripts/apply-csf-crosswalk.ts` - generator (rewrites seed JSON files).
- `packages/db/src/scripts/apply-csf-crosswalk.test.ts` - static tests (no database).
- `packages/db/prisma/seed/sync-framework-scoped-links.ts` - seed step: non-CSF baseline population, CSF authoritative sync, instance-level backfill from pinned manifest.
- `packages/db/src/scripts/csf-seed.spec.ts` - database tests.

Modified:

- `packages/db/prisma/seed/primitives/FrameworkEditorFramework.json` - CSF `visible: true`.
- `packages/db/prisma/seed/primitives/FrameworkEditorRequirement.json` - 106 CSF rows rewritten.
- `packages/db/prisma/seed/primitives/FrameworkEditorControlTemplate.json` - 5 new rows.
- `packages/db/prisma/seed/primitives/FrameworkEditorTaskTemplate.json` - 10 new rows.
- `packages/db/prisma/seed/relations/_FrameworkEditorControlTemplateToFrameworkEditorRequirement.json` - CSF rows.
- `packages/db/prisma/seed/relations/_FrameworkEditorControlTemplateToFrameworkEditorPolicyTemplate.json` - links for the 5 new controls.
- `packages/db/prisma/seed/relations/_FrameworkEditorControlTemplateToFrameworkEditorTaskTemplate.json` - links for the 5 new controls.
- `packages/db/prisma/seed/frameworkEditorSchemas.ts` - requirement schema gains `requirementFamily`, `sortOrder`.
- `packages/db/prisma/seed/seed.ts` - calls the new seed step; instance backfill replaced.
- `packages/db/src/scripts/backfill-framework-versions.ts` - uses the shared builder.
- `packages/db/src/index.ts` - exports `framework-manifest`.
- `packages/db/package.json` - `test`, `crosswalk:csf` scripts.
- `apps/api/src/framework-editor-versions/framework-manifest-builder.ts` - thin wrapper over the shared builder.
- `apps/api/src/frameworks/framework-versioning/manifest.types.ts` - re-export from `@trycompai/db`.
- `docs/self-hosting-local.md` - CSF section.

---

### Task 1: Commit the official NIST core and the crosswalk file

**Files:**
- Create: `packages/db/prisma/seed/crosswalks/nist-csf-2.0-core.json`
- Create: `packages/db/prisma/seed/crosswalks/nist-csf-2.0.json`
- Create: `packages/db/src/scripts/csf-crosswalk.ts`
- Test: `packages/db/src/scripts/csf-crosswalk.test.ts`

**Interfaces:**
- Consumes: `.local/sources/csf-2.0-core.json` (parsed NIST export, produced during design) and `.local/csf-crosswalk-source.py` (authoring source, validated by `.local/gen-csf-spec.py`).
- Produces: `loadCrosswalk(): Crosswalk`, `loadCsfCore(): CsfCore`, `CROSSWALK_PATH`, `CORE_PATH`, `CSF_FRAMEWORK_ID`, `mintTemplateId({ prefix, name })`, and the `Crosswalk` type below.

- [ ] **Step 1: Copy the parsed NIST core into the repo**

```bash
mkdir -p packages/db/prisma/seed/crosswalks
python3 - <<'PY'
import json
d = json.load(open('.local/sources/csf-2.0-core.json'))
out = {
  'source': d['source'],
  'functions': d['functions'],
  'categories': d['categories'],
  'subcategories': [{k: s[k] for k in ('id', 'category', 'function', 'text', 'sp800_53', 'iso27001')} for s in d['subcategories']],
}
json.dump(out, open('packages/db/prisma/seed/crosswalks/nist-csf-2.0-core.json', 'w'), indent=2, ensure_ascii=False)
print(len(out['subcategories']), 'subcategories written')
PY
```

Expected: `106 subcategories written`. Implementation Examples are deliberately dropped.

- [ ] **Step 2: Write the failing loader test**

`packages/db/src/scripts/csf-crosswalk.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { loadCrosswalk, loadCsfCore, mintTemplateId, CSF_FRAMEWORK_ID } from './csf-crosswalk';

describe('csf-crosswalk loaders', () => {
  it('loads the official core with 106 subcategories in six functions', () => {
    const core = loadCsfCore();
    expect(core.subcategories).toHaveLength(106);
    expect(Object.keys(core.functions).sort()).toEqual(['DE', 'GV', 'ID', 'PR', 'RC', 'RS']);
    expect(Object.keys(core.categories)).toHaveLength(22);
  });

  it('loads a crosswalk that covers exactly the official subcategory ids', () => {
    const core = loadCsfCore();
    const crosswalk = loadCrosswalk();
    expect(crosswalk.frameworkId).toBe(CSF_FRAMEWORK_ID);
    const official = core.subcategories.map((s) => s.id).sort();
    const mapped = crosswalk.subcategories.map((s) => s.id).sort();
    expect(mapped).toEqual(official);
  });

  it('mints deterministic ids of the same shape as existing template ids', () => {
    const a = mintTemplateId({ prefix: 'frk_ct', name: 'Risk Appetite & Tolerance' });
    const b = mintTemplateId({ prefix: 'frk_ct', name: 'Risk Appetite & Tolerance' });
    expect(a).toBe(b);
    expect(a).toMatch(/^frk_ct_[0-9a-f]{24}$/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/db && bun test src/scripts/csf-crosswalk.test.ts`
Expected: FAIL, cannot resolve `./csf-crosswalk`.

- [ ] **Step 4: Write the loader module**

`packages/db/src/scripts/csf-crosswalk.ts`:

```ts
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const CSF_FRAMEWORK_ID = 'frk_6820090a1653380dd386c5eb';

const SEED_DIR = path.resolve(__dirname, '..', '..', 'prisma', 'seed');
export const CROSSWALK_PATH = path.join(SEED_DIR, 'crosswalks', 'nist-csf-2.0.json');
export const CORE_PATH = path.join(SEED_DIR, 'crosswalks', 'nist-csf-2.0-core.json');
export const PRIMITIVES_DIR = path.join(SEED_DIR, 'primitives');
export const RELATIONS_DIR = path.join(SEED_DIR, 'relations');

const subcategorySchema = z.object({
  id: z.string().regex(/^[A-Z]{2}\.[A-Z]{2}-\d{2}$/),
  category: z.string(),
  function: z.string(),
  text: z.string().min(1),
  sp800_53: z.array(z.string()),
  iso27001: z.array(z.string()),
});

const coreSchema = z.object({
  source: z.string(),
  functions: z.record(z.object({ name: z.string(), text: z.string() })),
  categories: z.record(z.object({ name: z.string(), function: z.string(), text: z.string() })),
  subcategories: z.array(subcategorySchema),
});

const controlRefSchema = z.object({ id: z.string(), name: z.string() });
const policyRefSchema = z.object({ id: z.string(), name: z.string() });
const taskRefSchema = z.object({ id: z.string(), name: z.string() });

const crosswalkSchema = z.object({
  frameworkId: z.literal(CSF_FRAMEWORK_ID),
  source: z.string(),
  subcategories: z.array(
    z.object({
      id: z.string(),
      requirementId: z.string().startsWith('frk_rq_'),
      controls: z.array(controlRefSchema).min(1),
      rationale: z.string().min(1),
    }),
  ),
  newControls: z.array(
    z.object({
      id: z.string().startsWith('frk_ct_'),
      name: z.string(),
      description: z.string(),
      policies: z.array(policyRefSchema).min(1),
      tasks: z.array(taskRefSchema).min(1),
    }),
  ),
  newTasks: z.array(
    z.object({
      id: z.string().startsWith('frk_tt_'),
      name: z.string(),
      description: z.string(),
      frequency: z.enum(['monthly', 'quarterly', 'yearly']),
      department: z.enum(['none', 'admin', 'gov', 'hr', 'it', 'itsm', 'qms']),
    }),
  ),
  csfLinks: z.object({
    policies: z.array(z.object({ controlTemplateId: z.string(), policyTemplateId: z.string() })),
    tasks: z.array(z.object({ controlTemplateId: z.string(), taskTemplateId: z.string() })),
  }),
});

export type CsfCore = z.infer<typeof coreSchema>;
export type Crosswalk = z.infer<typeof crosswalkSchema>;

export function loadCsfCore(): CsfCore {
  return coreSchema.parse(JSON.parse(fs.readFileSync(CORE_PATH, 'utf8')));
}

export function loadCrosswalk(): Crosswalk {
  return crosswalkSchema.parse(JSON.parse(fs.readFileSync(CROSSWALK_PATH, 'utf8')));
}

export function mintTemplateId({ prefix, name }: { prefix: 'frk_ct' | 'frk_tt'; name: string }): string {
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

export function readJsonArray<T>(filePath: string): T[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${filePath} is not a JSON array`);
  return parsed as T[];
}

export function writeJsonArray(filePath: string, rows: unknown[]): void {
  fs.writeFileSync(filePath, `${JSON.stringify(rows, null, 2)}\n`);
}
```

- [ ] **Step 5: Emit the crosswalk JSON from the authoring source**

One-off tool, run from the repository root; it is not committed (it lives in gitignored `.local/`). It mints the new ids with the same rule as `mintTemplateId`.

```bash
cat > .local/emit-crosswalk-json.py <<'PY'
import hashlib, importlib.util, json
spec = importlib.util.spec_from_file_location('src', '.local/csf-crosswalk-source.py')
src = importlib.util.module_from_spec(spec); spec.loader.exec_module(src)
core = json.load(open('packages/db/prisma/seed/crosswalks/nist-csf-2.0-core.json'))
req = json.load(open('packages/db/prisma/seed/primitives/FrameworkEditorRequirement.json'))
import re
req_by_sub = {re.match(r'^([A-Z]{2}\.[A-Z]{2}-\d\d)', r['name']).group(1): r['id'] for r in req if r['frameworkId'] == 'frk_6820090a1653380dd386c5eb'}
mint = lambda prefix, name: f"{prefix}_{hashlib.sha256(name.encode()).hexdigest()[:24]}"
new_task_id = {name: mint('frk_tt', name) for name in src.NEW_TASKS}
ctrl_id = {k: (mint('frk_ct', v[1]) if v[0] == 'NEW' else v[0]) for k, v in src.C.items()}
ctrl_name = {k: v[1] for k, v in src.C.items()}
def task_ref(ref):
    if ref.startswith('NEW:'):
        return {'id': new_task_id[ref[4:]], 'name': ref[4:]}
    tid, name = src.TASK[ref]; return {'id': tid, 'name': name}
def pol_ref(key):
    pid, name = src.POL[key]; return {'id': pid, 'name': name}
out = {
  'frameworkId': 'frk_6820090a1653380dd386c5eb',
  'source': core['source'],
  'subcategories': [
    {'id': sid, 'requirementId': req_by_sub[sid],
     'controls': [{'id': ctrl_id[k], 'name': ctrl_name[k]} for k in keys], 'rationale': why}
    for sid, (keys, why) in src.M.items()],
  'newControls': [
    {'id': ctrl_id[k], 'name': nc['name'], 'description': nc['description'],
     'policies': [pol_ref(p) for p in nc['policies']], 'tasks': [task_ref(t) for t in nc['tasks']]}
    for k, nc in src.NEW_CONTROLS.items()],
  'newTasks': [
    {'id': new_task_id[name], 'name': name, 'description': d, 'frequency': f, 'department': dep}
    for name, (d, f, dep) in src.NEW_TASKS.items()],
  'csfLinks': {
    'policies': [{'controlTemplateId': ctrl_id[k], 'policyTemplateId': src.POL[p][0]} for k, add in src.CSF_LINKS.items() for p in add['policies']],
    'tasks': [{'controlTemplateId': ctrl_id[k], 'taskTemplateId': task_ref(t)['id']} for k, add in src.CSF_LINKS.items() for t in add['tasks']],
  },
}
json.dump(out, open('packages/db/prisma/seed/crosswalks/nist-csf-2.0.json', 'w'), indent=2, ensure_ascii=False)
print(len(out['subcategories']), 'subcategories,', len(out['newControls']), 'new controls,', len(out['newTasks']), 'new tasks,', len(out['csfLinks']['policies']) + len(out['csfLinks']['tasks']), 'csf links')
PY
python3 .local/gen-csf-spec.py && python3 .local/emit-crosswalk-json.py
```

Expected: `OK {...}` from the validator, then `106 subcategories, 5 new controls, 10 new tasks, 26 csf links`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/db && bun test src/scripts/csf-crosswalk.test.ts`
Expected: 3 pass.

- [ ] **Step 7: Commit**

```bash
git add packages/db/prisma/seed/crosswalks packages/db/src/scripts/csf-crosswalk.ts packages/db/src/scripts/csf-crosswalk.test.ts
git commit -m "feat(db): add NIST CSF 2.0 official core and crosswalk file"
```

---

### Task 2: Static tests and the generator

**Files:**
- Create: `packages/db/src/scripts/apply-csf-crosswalk.ts`
- Test: `packages/db/src/scripts/apply-csf-crosswalk.test.ts`
- Modify: `packages/db/prisma/seed/frameworkEditorSchemas.ts:64-89`
- Modify: `packages/db/package.json` (scripts)
- Modify (by running the generator): the six seed JSON files listed in the file map.

**Interfaces:**
- Consumes: `loadCrosswalk`, `loadCsfCore`, `readJsonArray`, `writeJsonArray`, `PRIMITIVES_DIR`, `RELATIONS_DIR`, `CSF_FRAMEWORK_ID` from Task 1.
- Produces: `applyCsfCrosswalk({ dryRun }): ApplyResult` where `ApplyResult = { changedFiles: string[] }`; `computeSeedState(): SeedState` (the in-memory result the generator would write, used by tests).

- [ ] **Step 1: Extend the requirement zod schema**

In `packages/db/prisma/seed/frameworkEditorSchemas.ts`, inside `FrameworkEditorRequirementSchema` after the `description` line, add:

```ts
  requirementFamily: z.string().optional(),
  sortOrder: z.number().int().optional(),
```

- [ ] **Step 2: Write the failing static tests**

`packages/db/src/scripts/apply-csf-crosswalk.test.ts`:

```ts
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
    const policies = new Map(readJsonArray<PolicyTemplate>(path.join(PRIMITIVES_DIR, 'FrameworkEditorPolicyTemplate.json')).map((p) => [p.id, p]));
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
    const add = (map: Map<string, Set<string>>, a: string, b: string) => {
      if (!map.has(a)) map.set(a, new Set());
      map.get(a)!.add(b);
    };
    state.controlPolicyPairs.forEach((p) => add(policyOf, p.A, p.B));
    state.controlTaskPairs.forEach((p) => add(taskOf, p.A, p.B));
    crosswalk.csfLinks.policies.forEach((l) => add(policyOf, l.controlTemplateId, l.policyTemplateId));
    crosswalk.csfLinks.tasks.forEach((l) => add(taskOf, l.controlTemplateId, l.taskTemplateId));
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
      requirements: readJsonArray<Requirement>(path.join(PRIMITIVES_DIR, 'FrameworkEditorRequirement.json')),
      controls: readJsonArray<ControlTemplate>(path.join(PRIMITIVES_DIR, 'FrameworkEditorControlTemplate.json')),
      tasks: readJsonArray<TaskTemplate>(path.join(PRIMITIVES_DIR, 'FrameworkEditorTaskTemplate.json')),
      controlRequirementPairs: readJsonArray<Pair>(path.join(RELATIONS_DIR, '_FrameworkEditorControlTemplateToFrameworkEditorRequirement.json')),
      controlPolicyPairs: readJsonArray<Pair>(path.join(RELATIONS_DIR, '_FrameworkEditorControlTemplateToFrameworkEditorPolicyTemplate.json')),
      controlTaskPairs: readJsonArray<Pair>(path.join(RELATIONS_DIR, '_FrameworkEditorControlTemplateToFrameworkEditorTaskTemplate.json')),
    };
    expect(committed).toEqual({
      requirements: state.requirements,
      controls: state.controls,
      tasks: state.tasks,
      controlRequirementPairs: state.controlRequirementPairs,
      controlPolicyPairs: state.controlPolicyPairs,
      controlTaskPairs: state.controlTaskPairs,
    });
  });

  it('does not touch relation rows of other frameworks', () => {
    const original = JSON.parse(fs.readFileSync(path.join(RELATIONS_DIR, '_FrameworkEditorControlTemplateToFrameworkEditorRequirement.json'), 'utf8')) as Pair[];
    const nonCsfBefore = original.filter((p) => !csfIds.has(p.B));
    const nonCsfAfter = state.controlRequirementPairs.filter((p) => !csfIds.has(p.B));
    expect(nonCsfAfter).toEqual(nonCsfBefore);
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
    const policies = new Map(readJsonArray<PolicyTemplate>(path.join(PRIMITIVES_DIR, 'FrameworkEditorPolicyTemplate.json')).map((p) => [p.id, p]));
    const tasks = new Map(state.tasks.map((t) => [t.id, t]));
    const policyIdsOf = (id: string) => [
      ...state.controlPolicyPairs.filter((p) => p.A === id).map((p) => p.B),
      ...crosswalk.csfLinks.policies.filter((l) => l.controlTemplateId === id).map((l) => l.policyTemplateId),
    ];
    const taskIdsOf = (id: string) => [
      ...state.controlTaskPairs.filter((p) => p.A === id).map((p) => p.B),
      ...crosswalk.csfLinks.tasks.filter((l) => l.controlTemplateId === id).map((l) => l.taskTemplateId),
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/db && bun test src/scripts/apply-csf-crosswalk.test.ts`
Expected: FAIL, cannot resolve `./apply-csf-crosswalk`.

- [ ] **Step 4: Write the generator**

`packages/db/src/scripts/apply-csf-crosswalk.ts`:

```ts
import path from 'node:path';
import {
  CSF_FRAMEWORK_ID,
  PRIMITIVES_DIR,
  RELATIONS_DIR,
  loadCrosswalk,
  loadCsfCore,
  readJsonArray,
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
    const next = `${JSON.stringify(rows, null, 2)}\n`;
    const current = readJsonArray<unknown>(filePath);
    if (`${JSON.stringify(current, null, 2)}\n` === next) continue;
    changedFiles.push(filePath);
    if (!dryRun) writeJsonArray(filePath, rows);
  }
  return { changedFiles };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--check');
  const result = applyCsfCrosswalk({ dryRun });
  console.log(dryRun ? 'Would change:' : 'Changed:', result.changedFiles.length ? result.changedFiles : '(nothing)');
  process.exit(dryRun && result.changedFiles.length > 0 ? 1 : 0);
}
```

Note on file formatting: the existing seed JSON files use 2-space indentation; confirm with `head -c 200 packages/db/prisma/seed/primitives/FrameworkEditorFramework.json` before running. If they differ, adjust `JSON.stringify(rows, null, 2)` to match so the "no hand edits" test compares like with like.

- [ ] **Step 5: Add the package scripts**

In `packages/db/package.json` `scripts`, add:

```json
"crosswalk:csf": "bun src/scripts/apply-csf-crosswalk.ts",
"crosswalk:csf:check": "bun src/scripts/apply-csf-crosswalk.ts --check",
"test": "bun test src"
```

- [ ] **Step 6: Run the generator, then the tests**

Run: `cd packages/db && bun run crosswalk:csf && bun test src/scripts/apply-csf-crosswalk.test.ts`
Expected: generator prints seven changed files (or fewer if some were already equal); 6 tests pass.

Then verify idempotence: `bun run crosswalk:csf:check` exits 0 and prints `(nothing)`.

- [ ] **Step 7: Spot-check the rewritten data**

```bash
cd packages/db && python3 - <<'PY'
import json
req = [r for r in json.load(open('prisma/seed/primitives/FrameworkEditorRequirement.json')) if r['frameworkId'] == 'frk_6820090a1653380dd386c5eb']
print(len(req), req[0]['identifier'], '|', req[0]['name'], '|', req[0]['requirementFamily'], '|', req[0]['sortOrder'])
fw = [f for f in json.load(open('prisma/seed/primitives/FrameworkEditorFramework.json')) if f['id'] == 'frk_6820090a1653380dd386c5eb'][0]
print('visible', fw['visible'])
pairs = json.load(open('prisma/seed/relations/_FrameworkEditorControlTemplateToFrameworkEditorRequirement.json'))
print('csf links', sum(1 for p in pairs if p['B'] in {r['id'] for r in req}))
PY
```

Expected: `106 <identifier> | <NIST category name> | <NIST Function name> | <integer 0-105>` for whichever CSF row is first in file order (for `RS.AN-08` the name is `Incident Analysis` and the family `Respond`), then `visible True`, then `csf links 172`.

- [ ] **Step 8: Commit**

```bash
git add packages/db
git commit -m "feat(db): generate NIST CSF 2.0 seed rows and control mappings from the crosswalk"
```

---

### Task 3: One pure manifest builder shared by the API and the seed

**Files:**
- Create: `packages/db/src/framework-manifest/manifest.types.ts`
- Create: `packages/db/src/framework-manifest/build-manifest.ts`
- Create: `packages/db/src/framework-manifest/index.ts`
- Test: `packages/db/src/framework-manifest/build-manifest.test.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `apps/api/src/frameworks/framework-versioning/manifest.types.ts` (becomes a re-export)
- Modify: `apps/api/src/framework-editor-versions/framework-manifest-builder.ts` (becomes a wrapper)
- Modify: `packages/db/src/scripts/backfill-framework-versions.ts:9-25,100-175`

**Interfaces:**
- Produces: `manifestFrameworkQuery(frameworkId: string)` returning the Prisma `findUnique` argument object; `buildManifestFromFramework(framework: ManifestFrameworkSource): FrameworkManifest`; the `ManifestFrameworkSource` structural type; all manifest types.
- Consumers: API builder wrapper (Task 3), backfill (Task 3), seed step (Task 4), database tests (Task 4).

- [ ] **Step 1: Move the manifest types**

`packages/db/src/framework-manifest/manifest.types.ts`: copy the full contents of `apps/api/src/frameworks/framework-versioning/manifest.types.ts` verbatim, replacing the header comment with:

```ts
// Shape of FrameworkVersion.manifest. Produced only by buildManifestFromFramework
// (build-manifest.ts); consumed by the API's publish path and the seed backfill.
```

- [ ] **Step 2: Write the failing builder test**

`packages/db/src/framework-manifest/build-manifest.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { buildManifestFromFramework, type ManifestFrameworkSource } from './build-manifest';

const policyA = { id: 'frk_pt_a', name: 'Policy A', description: null, content: { type: 'doc' }, frequency: 'yearly', department: 'gov' };
const policyB = { id: 'frk_pt_b', name: 'Policy B', description: null, content: { type: 'doc' }, frequency: null, department: null };
const taskZ = { id: 'frk_tt_z', name: 'Task Z', description: 'z', frequency: 'yearly', department: 'it' };
const taskY = { id: 'frk_tt_y', name: 'Task Y', description: 'y', frequency: null, department: null };

function source(): ManifestFrameworkSource {
  return {
    id: 'frk_x',
    name: 'X',
    version: '2.0',
    description: 'desc',
    requirements: [
      {
        id: 'frk_rq_2',
        identifier: 'GV.OC-02',
        name: 'Organizational Context',
        description: 'second',
        requirementFamily: 'Govern',
        sortOrder: 1,
        controlTemplates: [
          {
            id: 'frk_ct_b',
            name: 'B',
            description: 'b',
            controlFamily: null,
            requirements: [{ id: 'frk_rq_2' }, { id: 'frk_rq_other_framework' }],
            frameworkPolicyLinks: [{ policyTemplate: policyB }, { policyTemplate: policyA }],
            frameworkTaskLinks: [{ taskTemplate: taskZ }, { taskTemplate: taskY }],
            frameworkDocumentLinks: [{ formType: 'network-diagram' }, { formType: 'meeting' }],
          },
        ],
      },
      {
        id: 'frk_rq_1',
        identifier: 'GV.OC-01',
        name: 'Organizational Context',
        description: 'first',
        requirementFamily: 'Govern',
        sortOrder: 0,
        controlTemplates: [
          {
            id: 'frk_ct_b',
            name: 'B',
            description: 'b',
            controlFamily: null,
            requirements: [{ id: 'frk_rq_2' }, { id: 'frk_rq_1' }],
            frameworkPolicyLinks: [{ policyTemplate: policyA }, { policyTemplate: policyB }],
            frameworkTaskLinks: [{ taskTemplate: taskY }, { taskTemplate: taskZ }],
            frameworkDocumentLinks: [{ formType: 'meeting' }, { formType: 'network-diagram' }],
          },
        ],
      },
    ],
  };
}

describe('buildManifestFromFramework', () => {
  it('keeps requirement order as given and drops requirement ids from other frameworks', () => {
    const manifest = buildManifestFromFramework(source());
    expect(manifest.requirements.map((r) => r.id)).toEqual(['frk_rq_2', 'frk_rq_1']);
    expect(manifest.requirements[0]).toEqual({
      id: 'frk_rq_2',
      identifier: 'GV.OC-02',
      name: 'Organizational Context',
      description: 'second',
      requirementFamily: 'Govern',
      sortOrder: 1,
    });
    expect(manifest.controls[0]!.requirementIds).toEqual(['frk_rq_1', 'frk_rq_2']);
  });

  it('dedupes controls, policies and tasks and sorts every array by id', () => {
    const manifest = buildManifestFromFramework(source());
    expect(manifest.controls).toHaveLength(1);
    expect(manifest.controls[0]!.policyIds).toEqual(['frk_pt_a', 'frk_pt_b']);
    expect(manifest.controls[0]!.taskIds).toEqual(['frk_tt_y', 'frk_tt_z']);
    expect(manifest.controls[0]!.documentTypes).toEqual(['meeting', 'network-diagram']);
    expect(manifest.policies.map((p) => p.id)).toEqual(['frk_pt_a', 'frk_pt_b']);
    expect(manifest.tasks.map((t) => t.id)).toEqual(['frk_tt_y', 'frk_tt_z']);
  });

  it('is deterministic: two builds of the same source are deep-equal', () => {
    expect(buildManifestFromFramework(source())).toEqual(buildManifestFromFramework(source()));
  });

  it('records the framework header', () => {
    expect(buildManifestFromFramework(source()).framework).toEqual({
      id: 'frk_x',
      name: 'X',
      catalogVersion: '2.0',
      description: 'desc',
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/db && bun test src/framework-manifest/build-manifest.test.ts`
Expected: FAIL, cannot resolve `./build-manifest`.

- [ ] **Step 4: Write the builder**

`packages/db/src/framework-manifest/build-manifest.ts`:

```ts
import type { FrameworkManifest, ManifestControl, ManifestPolicy, ManifestTask } from './manifest.types';

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
      if (!controls.has(ct.id)) {
        controls.set(ct.id, {
          id: ct.id,
          name: ct.name,
          description: ct.description,
          controlFamily: ct.controlFamily || null,
          requirementIds: sortedIds(ct.requirements.map((r) => r.id).filter((id) => ownRequirementIds.has(id))),
          policyIds: sortedIds(policyTemplates.map((p) => p.id)),
          taskIds: sortedIds(taskTemplates.map((t) => t.id)),
          documentTypes: sortedIds(ct.frameworkDocumentLinks.map((link) => link.formType)),
        });
      }
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
```

`packages/db/src/framework-manifest/index.ts`:

```ts
export * from './manifest.types';
export { buildManifestFromFramework, manifestFrameworkQuery, type ManifestFrameworkSource } from './build-manifest';
```

Append to `packages/db/src/index.ts`:

```ts
export * from './framework-manifest';
```

- [ ] **Step 5: Run the builder tests**

Run: `cd packages/db && bun test src/framework-manifest/build-manifest.test.ts`
Expected: 4 pass.

Note: `ManifestPolicy.frequency`/`department` are `string | null` in the manifest types while Prisma returns enum types; the structural interface above uses the manifest types, and TypeScript accepts a Prisma enum value where a `string | null` is expected. If `bun run check-types` in `packages/db` reports an incompatibility on the `frameworkPolicyLinks` shape, widen the field in `ManifestFrameworkSource` to `Array<{ policyTemplate: { id: string; name: string; description: string | null; content: unknown; frequency: string | null; department: string | null } }>` (same members, spelled out) rather than casting.

- [ ] **Step 6: Point the API at the shared builder**

Replace the entire contents of `apps/api/src/frameworks/framework-versioning/manifest.types.ts` with:

```ts
export type {
  FrameworkManifest,
  ManifestControl,
  ManifestPolicy,
  ManifestRequirement,
  ManifestTask,
} from '@trycompai/db';
```

Replace the entire contents of `apps/api/src/framework-editor-versions/framework-manifest-builder.ts` with:

```ts
import { NotFoundException } from '@nestjs/common';
import { db } from '@db';
import { buildManifestFromFramework, manifestFrameworkQuery, type FrameworkManifest } from '@trycompai/db';

export async function buildManifestForFramework(frameworkId: string): Promise<FrameworkManifest> {
  const framework = await db.frameworkEditorFramework.findUnique(manifestFrameworkQuery(frameworkId));
  if (!framework) throw new NotFoundException('Framework not found');
  return buildManifestFromFramework(framework);
}
```

Build the db package so the API resolves the new export: `cd packages/db && bun run build`.

- [ ] **Step 7: Run the API's existing tests for the builder and versions service**

Run: `cd apps/api && bunx jest src/framework-editor-versions --passWithNoTests`
Expected: PASS. If a spec asserted array order from the old builder (unsorted), update the expectation to sorted-by-id order; that is the intended behaviour change.

- [ ] **Step 8: Switch the backfill to the shared builder**

In `packages/db/src/scripts/backfill-framework-versions.ts`:

1. Replace the imports and the `FrameworkWithTemplates` type (lines 1-23) with:

```ts
import { Prisma } from '@prisma/client';
import { db } from '../client';
import { buildManifestFromFramework, manifestFrameworkQuery } from '../framework-manifest';

export interface BackfillResult {
  versionsCreated: number;
  instancesBackfilled: number;
}
```

2. Replace the `db.frameworkEditorFramework.findMany({ include: {...} })` call at the top of `backfillFrameworkVersions` with:

```ts
  const frameworkIds = await db.frameworkEditorFramework.findMany({ select: { id: true } });
  const frameworks = [];
  for (const { id } of frameworkIds) {
    const framework = await db.frameworkEditorFramework.findUnique(manifestFrameworkQuery(id));
    if (framework) frameworks.push(framework);
  }
```

3. Replace `const manifest = buildManifestFromFramework(framework);` (existing call to the local function) so it now calls the imported function; delete the local `buildManifestFromFramework` and `dedupeById` functions (lines ~100-175).

- [ ] **Step 9: Typecheck and run the existing backfill spec**

Run: `cd packages/db && bun run check-types && bun docker:up && bun test src/scripts/backfill-framework-versions.spec.ts`
Expected: typecheck clean; spec passes. (The spec clears and recreates versions on the local database, then Task 6's rollout recreates the state; that is acceptable because the CSF rollout deletes and recreates the CSF version anyway. Do not run this spec against any database you cannot reseed.)

- [ ] **Step 10: Commit**

```bash
git add packages/db/src apps/api/src/frameworks/framework-versioning/manifest.types.ts apps/api/src/framework-editor-versions/framework-manifest-builder.ts
git commit -m "refactor(db): share one manifest builder between the API and the version backfill"
```

---

### Task 4: Seed step for scoped links and manifest-derived instance links

**Files:**
- Create: `packages/db/prisma/seed/sync-framework-scoped-links.ts`
- Test: `packages/db/src/scripts/csf-seed.spec.ts`
- Modify: `packages/db/prisma/seed/seed.ts:310-376`

**Interfaces:**
- Consumes: `loadCrosswalk`, `CSF_FRAMEWORK_ID` (Task 1); `manifestFrameworkQuery`, `buildManifestFromFramework`, `FrameworkManifest` (Task 3).
- Produces: `syncFrameworkScopedEditorLinks({ prisma })`, `syncCsfCrosswalk({ prisma })`, `backfillInstanceLinksFromManifests({ prisma })`, each returning a small count object described in the code.

- [ ] **Step 1: Write the failing database tests**

`packages/db/src/scripts/csf-seed.spec.ts`:

```ts
import { beforeAll, describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { db } from '../client';
import { buildManifestFromFramework, manifestFrameworkQuery, type FrameworkManifest } from '../framework-manifest';
import { CSF_FRAMEWORK_ID, loadCrosswalk } from './csf-crosswalk';

const dbUrl = process.env.DATABASE_URL ?? '';
if (
  dbUrl.includes('prod') ||
  dbUrl.includes('staging') ||
  (!dbUrl.includes('test') && !dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1'))
) {
  throw new Error(`Refusing to run destructive tests. DATABASE_URL must target a local/test DB; got: ${dbUrl}`);
}

const SOC2_FRAMEWORK_ID = 'frk_683f377429b8408d1c85f9bd';
const SEED = path.resolve(__dirname, '..', '..', 'prisma', 'seed', 'seed.ts');

function runSeed(): void {
  execSync(`bun ${SEED}`, { stdio: 'pipe', env: process.env });
}

async function scopedLinkSets(frameworkId: string) {
  const [policies, tasks] = await Promise.all([
    db.frameworkEditorControlPolicyTemplateLink.findMany({ where: { frameworkId }, select: { controlTemplateId: true, policyTemplateId: true } }),
    db.frameworkEditorControlTaskTemplateLink.findMany({ where: { frameworkId }, select: { controlTemplateId: true, taskTemplateId: true } }),
  ]);
  return {
    policies: policies.map((l) => `${l.controlTemplateId}|${l.policyTemplateId}`).sort(),
    tasks: tasks.map((l) => `${l.controlTemplateId}|${l.taskTemplateId}`).sort(),
  };
}

async function requirementControlPairs(frameworkId: string) {
  const rows = await db.frameworkEditorRequirement.findMany({
    where: { frameworkId },
    select: { id: true, controlTemplates: { select: { id: true } } },
  });
  return rows.flatMap((r) => r.controlTemplates.map((c) => `${r.id}|${c.id}`)).sort();
}

describe('CSF seed', () => {
  beforeAll(() => {
    runSeed();
  });

  it('8: the CSF 1.0.0 manifest has 106 ordered requirements, each with controls that carry policies and tasks', async () => {
    const version = await db.frameworkVersion.findUnique({
      where: { frameworkId_version: { frameworkId: CSF_FRAMEWORK_ID, version: '1.0.0' } },
    });
    expect(version).not.toBeNull();
    const manifest = version!.manifest as unknown as FrameworkManifest;
    expect(manifest.requirements).toHaveLength(106);
    expect(manifest.requirements.map((r) => r.sortOrder)).toEqual([...Array(106).keys()]);
    for (const r of manifest.requirements) {
      expect(r.identifier).toMatch(/^[A-Z]{2}\.[A-Z]{2}-\d{2}$/);
      expect(r.requirementFamily).toBeTruthy();
      expect(manifest.controls.some((c) => c.requirementIds.includes(r.id))).toBe(true);
    }
    for (const c of manifest.controls) {
      expect(c.policyIds.length).toBeGreaterThan(0);
      expect(c.taskIds.length).toBeGreaterThan(0);
    }
  });

  it('9: the shared builder reproduces the stored CSF manifest exactly', async () => {
    const version = await db.frameworkVersion.findUnique({
      where: { frameworkId_version: { frameworkId: CSF_FRAMEWORK_ID, version: '1.0.0' } },
    });
    const framework = await db.frameworkEditorFramework.findUnique(manifestFrameworkQuery(CSF_FRAMEWORK_ID));
    expect(buildManifestFromFramework(framework!)).toEqual(version!.manifest as unknown as FrameworkManifest);
  });

  it('11: scoped-link population is idempotent and SOC 2 scoped links equal its global links', async () => {
    const before = await scopedLinkSets(SOC2_FRAMEWORK_ID);
    runSeed();
    const after = await scopedLinkSets(SOC2_FRAMEWORK_ID);
    expect(after).toEqual(before);
    const version = await db.frameworkVersion.findFirst({ where: { frameworkId: SOC2_FRAMEWORK_ID }, orderBy: { publishedAt: 'desc' } });
    const manifest = version!.manifest as unknown as FrameworkManifest;
    const fromManifest = {
      policies: manifest.controls.flatMap((c) => c.policyIds.map((p) => `${c.id}|${p}`)).sort(),
      tasks: manifest.controls.flatMap((c) => c.taskIds.map((t) => `${c.id}|${t}`)).sort(),
    };
    expect(after).toEqual(fromManifest);
  });

  it('10: the crosswalk is authoritative for CSF mappings and scoped links', async () => {
    const crosswalk = loadCrosswalk();
    const soc2Before = await scopedLinkSets(SOC2_FRAMEWORK_ID);
    const soc2PairsBefore = await requirementControlPairs(SOC2_FRAMEWORK_ID);
    const expectedPairs = crosswalk.subcategories.flatMap((s) => s.controls.map((c) => `${s.requirementId}|${c.id}`)).sort();
    expect(await requirementControlPairs(CSF_FRAMEWORK_ID)).toEqual(expectedPairs);

    // Case A: a control used by several requirements loses one of them; scoped rows stay.
    const shared = crosswalk.subcategories.filter((s) => s.controls.some((c) => c.id === 'frk_ct_683f47cc2faa426603d6bee8'));
    expect(shared.length).toBeGreaterThan(1);
    const victim = shared[0]!;
    await db.frameworkEditorRequirement.update({
      where: { id: victim.requirementId },
      data: { controlTemplates: { connect: { id: 'frk_ct_683f42c71eea99f22f9df060' } } },
    });
    runSeed();
    expect(await requirementControlPairs(CSF_FRAMEWORK_ID)).toEqual(expectedPairs);
    const csfLinks = await scopedLinkSets(CSF_FRAMEWORK_ID);
    expect(csfLinks.tasks.some((l) => l.startsWith('frk_ct_683f47cc2faa426603d6bee8|'))).toBe(true);

    // Case B: an extra scoped row not in the crosswalk is removed by the seed.
    await db.frameworkEditorControlTaskTemplateLink.create({
      data: { frameworkId: CSF_FRAMEWORK_ID, controlTemplateId: 'frk_ct_683f47cc2faa426603d6bee8', taskTemplateId: 'frk_tt_68406903839203801ac8041a' },
    });
    runSeed();
    const afterB = await scopedLinkSets(CSF_FRAMEWORK_ID);
    expect(afterB.tasks).not.toContain('frk_ct_683f47cc2faa426603d6bee8|frk_tt_68406903839203801ac8041a');
    expect(await scopedLinkSets(SOC2_FRAMEWORK_ID)).toEqual(soc2Before);
    expect(await requirementControlPairs(SOC2_FRAMEWORK_ID)).toEqual(soc2PairsBefore);
  });

  it('12: pinned instances get exactly the links their manifest implies', async () => {
    const instances = await db.frameworkInstance.findMany({
      where: { currentVersionId: { not: null } },
      select: { id: true, organizationId: true, currentVersion: { select: { manifest: true } } },
    });
    for (const instance of instances) {
      const manifest = instance.currentVersion!.manifest as unknown as FrameworkManifest;
      const controls = await db.control.findMany({ where: { organizationId: instance.organizationId }, select: { id: true, controlTemplateId: true } });
      const tasks = await db.task.findMany({ where: { organizationId: instance.organizationId }, select: { id: true, taskTemplateId: true } });
      const expected = new Set<string>();
      for (const mc of manifest.controls) {
        for (const control of controls.filter((c) => c.controlTemplateId === mc.id)) {
          for (const task of tasks.filter((t) => t.taskTemplateId && mc.taskIds.includes(t.taskTemplateId))) {
            expected.add(`${control.id}|${task.id}`);
          }
        }
      }
      const actual = await db.frameworkControlTaskLink.findMany({ where: { frameworkInstanceId: instance.id }, select: { controlId: true, taskId: true } });
      expect(new Set(actual.map((l) => `${l.controlId}|${l.taskId}`))).toEqual(expected);
    }
  });
});
```

Test 10 relies on the fact that "Security Incident Management" (`frk_ct_683f47cc2faa426603d6bee8`) is mapped by many CSF subcategories and that "Asset Inventory" (`frk_ct_683f42c71eea99f22f9df060`) is not mapped to the victim requirement; both hold in the committed crosswalk (check with `grep -c 683f47cc2faa426603d6bee8 packages/db/prisma/seed/crosswalks/nist-csf-2.0.json`, expected 23).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/db && bun test src/scripts/csf-seed.spec.ts`
Expected: FAIL. Test 8 fails because the stored CSF manifest has 0 controls (the seed has not yet been changed); tests 10-12 fail on scoped links being empty.

- [ ] **Step 3: Write the seed step module**

`packages/db/prisma/seed/sync-framework-scoped-links.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import { CSF_FRAMEWORK_ID, loadCrosswalk } from '../../src/scripts/csf-crosswalk';

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

function pairKey(a: string, b: string): string {
  return `${a}|${b}`;
}

function splitKey(key: string): [string, string] {
  const [a, b] = key.split('|');
  if (!a || !b) throw new Error(`Malformed pair key: ${key}`);
  return [a, b];
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
    control.policyTemplates.forEach((p) => targetPolicies.add(pairKey(control.id, p.id)));
    control.taskTemplates.forEach((t) => targetTasks.add(pairKey(control.id, t.id)));
  }
  crosswalk.csfLinks.policies.forEach((l) => targetPolicies.add(pairKey(l.controlTemplateId, l.policyTemplateId)));
  crosswalk.csfLinks.tasks.forEach((l) => targetTasks.add(pairKey(l.controlTemplateId, l.taskTemplateId)));

  const existingPolicies = await prisma.frameworkEditorControlPolicyTemplateLink.findMany({
    where: { frameworkId: CSF_FRAMEWORK_ID },
    select: { id: true, controlTemplateId: true, policyTemplateId: true },
  });
  const existingTasks = await prisma.frameworkEditorControlTaskTemplateLink.findMany({
    where: { frameworkId: CSF_FRAMEWORK_ID },
    select: { id: true, controlTemplateId: true, taskTemplateId: true },
  });

  const stalePolicyIds = existingPolicies.filter((l) => !targetPolicies.has(pairKey(l.controlTemplateId, l.policyTemplateId))).map((l) => l.id);
  const staleTaskIds = existingTasks.filter((l) => !targetTasks.has(pairKey(l.controlTemplateId, l.taskTemplateId))).map((l) => l.id);
  await prisma.frameworkEditorControlPolicyTemplateLink.deleteMany({ where: { id: { in: stalePolicyIds } } });
  await prisma.frameworkEditorControlTaskTemplateLink.deleteMany({ where: { id: { in: staleTaskIds } } });

  const havePolicies = new Set(existingPolicies.map((l) => pairKey(l.controlTemplateId, l.policyTemplateId)));
  const haveTasks = new Set(existingTasks.map((l) => pairKey(l.controlTemplateId, l.taskTemplateId)));
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
```

`packages/db/prisma/seed/instance-links-from-manifests.ts`:

```ts
import { EvidenceFormType, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { FrameworkManifest } from '../../src/framework-manifest';

const formTypeSchema = z.nativeEnum(EvidenceFormType);

function pairKey(a: string, b: string): string {
  return `${a}|${b}`;
}

function splitKey(key: string): [string, string] {
  const [a, b] = key.split('|');
  if (!a || !b) throw new Error(`Malformed pair key: ${key}`);
  return [a, b];
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
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
    const controlsByTemplate = groupBy(controls, (c) => c.controlTemplateId!);
    const policiesByTemplate = groupBy(policies, (p) => p.policyTemplateId!);
    const tasksByTemplate = groupBy(tasks, (t) => t.taskTemplateId!);

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
          rows.forEach((p) => targetPolicy.add(pairKey(control.id, p.id)));
        }
        for (const tid of mc.taskIds) {
          const rows = tasksByTemplate.get(tid) ?? [];
          if (rows.length === 0) skippedTemplates += 1;
          rows.forEach((t) => targetTask.add(pairKey(control.id, t.id)));
        }
        (mc.documentTypes ?? []).forEach((formType) => targetDoc.add(pairKey(control.id, formType)));
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
  const have = new Set(existing.map((l) => pairKey(l.controlId, l.policyId)));
  await prisma.frameworkControlPolicyLink.deleteMany({ where: { id: { in: existing.filter((l) => !target.has(pairKey(l.controlId, l.policyId))).map((l) => l.id) } } });
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
  const have = new Set(existing.map((l) => pairKey(l.controlId, l.taskId)));
  await prisma.frameworkControlTaskLink.deleteMany({ where: { id: { in: existing.filter((l) => !target.has(pairKey(l.controlId, l.taskId))).map((l) => l.id) } } });
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
  const have = new Set(existing.map((l) => pairKey(l.controlId, l.formType)));
  await prisma.frameworkControlDocumentTypeLink.deleteMany({ where: { id: { in: existing.filter((l) => !target.has(pairKey(l.controlId, l.formType))).map((l) => l.id) } } });
  await prisma.frameworkControlDocumentTypeLink.createMany({
    data: [...target].filter((k) => !have.has(k)).map((k) => {
      const [controlId, formType] = splitKey(k);
      return { frameworkInstanceId: instanceId, controlId, formType: formTypeSchema.parse(formType) };
    }),
    skipDuplicates: true,
  });
}
```

The two files share `pairKey`/`splitKey`; if the cleanup pass in Task 5 prefers one definition, move them to `packages/db/prisma/seed/pair-key.ts` and import from there.

- [ ] **Step 4: Wire the seed**

In `packages/db/prisma/seed/seed.ts`:

1. Add imports at the top:

```ts
import { syncCsfCrosswalk, syncFrameworkScopedEditorLinks } from './sync-framework-scoped-links';
import { backfillInstanceLinksFromManifests } from './instance-links-from-manifests';
```

2. Rename the existing `backfillFrameworkScopedLinks` to `backfillUnpinnedInstanceLinks` and change its first line to only select unpinned instances:

```ts
  const fis = await prisma.frameworkInstance.findMany({ where: { currentVersionId: null }, select: { id: true } });
```

3. In `main()`, replace the block from `await seedJsonFiles('relations');` through `console.log('Framework-scoped link backfill complete.');` with:

```ts
    await seedJsonFiles('relations');

    console.log('Scoped editor links:', await syncFrameworkScopedEditorLinks({ prisma }));
    console.log('CSF crosswalk sync:', await syncCsfCrosswalk({ prisma }));

    const { backfillFrameworkVersions } = await import('../../src/scripts/backfill-framework-versions');
    console.log('FrameworkVersion backfill:', await backfillFrameworkVersions());

    console.log('Instance links from manifests:', await backfillInstanceLinksFromManifests({ prisma }));
    await backfillUnpinnedInstanceLinks();
    console.log('Unpinned instance link backfill complete.');
```

Order matters: scoped links before the version backfill (the builder reads scoped links), CSF sync after the baseline (so its deletions are authoritative), instance links after versions exist.

- [ ] **Step 5: Delete the stale CSF version on this machine, then run the seed and the tests**

The stored CSF `1.0.0` has 0 controls and is unreferenced (spec 5.7 preconditions). Verify, then delete:

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -d comp -Atc "select v.id, (select count(*) from \"FrameworkInstance\" i where i.\"currentVersionId\"=v.id), (select count(*) from \"FrameworkSyncOperation\" s where s.\"fromVersionId\"=v.id or s.\"toVersionId\"=v.id) from \"FrameworkVersion\" v where v.\"frameworkId\"='frk_6820090a1653380dd386c5eb';"
```

Expected: one row, both counts `0`. Then:

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -d comp -c "delete from \"FrameworkVersion\" where \"frameworkId\"='frk_6820090a1653380dd386c5eb' and version='1.0.0';"
cd packages/db && bun test src/scripts/csf-seed.spec.ts
```

Expected: 5 pass (the `beforeAll` runs the seed).

- [ ] **Step 6: Run the whole package test suite and typecheck**

Run: `cd packages/db && bun run test && bun run check-types`
Expected: all pass; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat(db): seed framework-scoped editor links, sync the CSF crosswalk, and derive instance links from pinned manifests"
```

---

### Task 5: Quality gates and docs

**Files:**
- Modify: `docs/self-hosting-local.md` (Frameworks section)
- Modify: `apps/api` and `packages/db` as lint/typecheck require

- [ ] **Step 1: Root typecheck and lint**

Run: `bun run typecheck` at the repository root, then `cd packages/db && bun run lint` and `cd apps/api && bunx eslint src/framework-editor-versions src/frameworks/framework-versioning`.
Expected: clean. Fix anything reported in files this plan touched; do not reformat untouched upstream files.

- [ ] **Step 2: Run the cleanup skill**

Invoke the repo's `cleanup` skill over `git diff --name-only revola/self-host...HEAD` and apply its findings (no redundant casts, no dead code, helpers extracted where a pattern repeats across `sync-framework-scoped-links.ts` and `instance-links-from-manifests.ts`).

- [ ] **Step 3: Update the self-hosting doc**

Replace the `## Frameworks` section of `docs/self-hosting-local.md` with:

```markdown
## Frameworks

The seed ships SOC 2 and NIST CSF 2.0, both visible and mapped to the control library.
CSF 2.0 is defined by `packages/db/prisma/seed/crosswalks/nist-csf-2.0.json` (subcategory to control mapping, new templates, CSF-only policy/task links) and the official core text in `nist-csf-2.0-core.json`.

- Change a mapping: edit the crosswalk JSON, run `bun run crosswalk:csf` in `packages/db`, run `bun run db:seed` (the seed reconciles CSF to the file), then publish a new version from the framework editor and sync organizations.
- `bun run crosswalk:csf:check` fails when the committed seed files differ from the crosswalk; CI runs it through `bun run test`.
- The design and the full per-subcategory rationale are in `docs/specs/2026-09-15-nist-csf-2-crosswalk-design.md`.
```

- [ ] **Step 4: Commit**

```bash
git add docs/self-hosting-local.md packages/db apps/api
git commit -m "chore(csf): quality gates and self-hosting docs for the CSF 2.0 crosswalk"
```

---

### Task 6: Rollout on this machine and acceptance

**Files:** none (operational). Record outputs in `.local/rollout-2026-09-15.txt`.

- [ ] **Step 1: Record SOC 2 instance edge sets before**

```bash
mkdir -p .local && PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -d comp -Atc "
select 'P', \"controlId\"||'|'||\"policyId\" from \"FrameworkControlPolicyLink\" where \"frameworkInstanceId\"='frm_6aa9b0791d35af29c6305e45'
union all select 'T', \"controlId\"||'|'||\"taskId\" from \"FrameworkControlTaskLink\" where \"frameworkInstanceId\"='frm_6aa9b0791d35af29c6305e45'
union all select 'D', \"controlId\"||'|'||\"formType\" from \"FrameworkControlDocumentTypeLink\" where \"frameworkInstanceId\"='frm_6aa9b0791d35af29c6305e45' order by 1,2" > .local/soc2-edges-before.txt; wc -l .local/soc2-edges-before.txt
```

Expected: `148` lines (63 + 76 + 9).

- [ ] **Step 2: Build and start the stack**

```bash
scripts/local-run.sh build && scripts/local-run.sh start
```

Expected: api, app and both Trigger workers running (`scripts/local-run.sh status`).

- [ ] **Step 3: Add CSF to the organization in the app**

In the browser at http://localhost:3000, Overview, Add Framework, select NIST CSF 2.0, confirm. Then verify:

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -d comp -Atc "
select 'csf_instance', i.id, i.\"currentVersionId\" from \"FrameworkInstance\" i where i.\"organizationId\"='org_6aa9b0797c69fd27a4fc05ad' and i.\"frameworkId\"='frk_6820090a1653380dd386c5eb';
select 'csf_requirements_with_controls', count(distinct rm.\"requirementId\") from \"RequirementMap\" rm join \"FrameworkInstance\" i on i.id=rm.\"frameworkInstanceId\" where i.\"frameworkId\"='frk_6820090a1653380dd386c5eb' and rm.\"archivedAt\" is null;
select 'org_totals', (select count(*) from \"Control\" where \"organizationId\"='org_6aa9b0797c69fd27a4fc05ad'), (select count(*) from \"Policy\" where \"organizationId\"='org_6aa9b0797c69fd27a4fc05ad'), (select count(*) from \"Task\" where \"organizationId\"='org_6aa9b0797c69fd27a4fc05ad');
select 'dup_controls_by_template', count(*) from (select \"controlTemplateId\" from \"Control\" where \"organizationId\"='org_6aa9b0797c69fd27a4fc05ad' and \"controlTemplateId\" is not null group by 1 having count(*)>1) d;" | tee -a .local/rollout-2026-09-15.txt
```

Expected: a CSF instance pinned to a version; `csf_requirements_with_controls` = 106; org totals greater than 35/25/26 by the number of templates the organization did not already have; `dup_controls_by_template` = 0.

- [ ] **Step 4: Re-run the seed and compare SOC 2 edges after**

```bash
cd packages/db && bun run db:seed && cd ../.. && PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -d comp -Atc "
select 'P', \"controlId\"||'|'||\"policyId\" from \"FrameworkControlPolicyLink\" where \"frameworkInstanceId\"='frm_6aa9b0791d35af29c6305e45'
union all select 'T', \"controlId\"||'|'||\"taskId\" from \"FrameworkControlTaskLink\" where \"frameworkInstanceId\"='frm_6aa9b0791d35af29c6305e45'
union all select 'D', \"controlId\"||'|'||\"formType\" from \"FrameworkControlDocumentTypeLink\" where \"frameworkInstanceId\"='frm_6aa9b0791d35af29c6305e45' order by 1,2" > .local/soc2-edges-after.txt; diff .local/soc2-edges-before.txt .local/soc2-edges-after.txt && echo "SOC 2 edge sets identical"
```

Expected: `SOC 2 edge sets identical`.

- [ ] **Step 5: Visual acceptance**

In the app: the CSF framework page lists 106 requirements grouped by Function in the order Govern, Identify, Protect, Detect, Respond, Recover; open GV.OC-01 and a shared requirement such as PR.AA-01; confirm Access Rights shows the same evidence status under SOC 2 (CC6.x) and under CSF. Take screenshots into `.local/`.

- [ ] **Step 6: Record and finish**

Append the acceptance query outputs and the diff result to `.local/rollout-2026-09-15.txt`. No commit; report the results.

import fs from 'node:fs';
import path from 'node:path';
import { PRIMITIVES_DIR, readJsonArray, serializeJsonArray, writeJsonArray } from './csf-crosswalk';
import {
  SOC2_LEGACY_FRAMEWORK_ID,
  SOC2_LIVE_FRAMEWORK_ID,
  loadSoc2Core,
  loadSoc2Crosswalk,
  type Soc2Core,
  type Soc2Crosswalk,
} from './soc2-tsc';

type Requirement = {
  id: string;
  frameworkId: string;
  name: string;
  identifier: string;
  description: string;
  requirementFamily?: string;
  sortOrder?: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

const REQUIREMENTS_FILE = path.join(PRIMITIVES_DIR, 'FrameworkEditorRequirement.json');
const SEED_TIMESTAMP = '2026-10-12 00:00:00.000';

function withFields({
  row,
  fields,
}: {
  row: Requirement;
  fields: Partial<Requirement>;
}): Requirement {
  const unchanged = Object.entries(fields).every(
    ([key, value]) => row[key as keyof Requirement] === value,
  );
  return unchanged ? row : { ...row, ...fields, updatedAt: SEED_TIMESTAMP };
}

/**
 * Requirement seed rows with "SOC 2" 1.0.0 set exactly to the crosswalk (official identifier,
 * series as name, official text, family and order; retired records removed) and the live
 * "SOC 2" 1 names set to the official criterion text. Every other row is untouched.
 */
export function computeSoc2Requirements({
  requirements,
  core,
  crosswalk,
}: {
  requirements: Requirement[];
  core: Soc2Core;
  crosswalk: Soc2Crosswalk;
}): Requirement[] {
  const officialById = new Map(core.criteria.map((criterion) => [criterion.id, criterion]));
  const managedIds = new Set([
    ...crosswalk.criteria.map((c) => c.requirementId),
    ...crosswalk.retired.map((r) => r.requirementId),
  ]);
  const existingById = new Map(requirements.map((r) => [r.id, r]));

  const legacyRows = crosswalk.criteria.map((criterion, index) => {
    const official = officialById.get(criterion.id);
    if (!official) throw new Error(`Crosswalk criterion ${criterion.id} is not in the core`);
    const fields = {
      identifier: criterion.id,
      name: official.series,
      description: official.text,
      requirementFamily: official.family,
      sortOrder: index,
    };
    const existing = existingById.get(criterion.requirementId);
    if (existing) return withFields({ row: existing, fields });
    return {
      id: criterion.requirementId,
      frameworkId: SOC2_LEGACY_FRAMEWORK_ID,
      ...fields,
      createdAt: SEED_TIMESTAMP,
      updatedAt: SEED_TIMESTAMP,
    };
  });

  const output: Requirement[] = [];
  let legacyEmitted = false;
  for (const row of requirements) {
    if (row.frameworkId === SOC2_LEGACY_FRAMEWORK_ID) {
      if (!managedIds.has(row.id)) {
        throw new Error(`SOC 2 1.0.0 requirement ${row.id} is not in the crosswalk`);
      }
      if (!legacyEmitted) output.push(...legacyRows);
      legacyEmitted = true;
      continue;
    }
    if (row.frameworkId === SOC2_LIVE_FRAMEWORK_ID) {
      const official = officialById.get(row.identifier);
      if (!official) throw new Error(`SOC 2 1 requirement ${row.id} has unknown ${row.identifier}`);
      output.push(withFields({ row, fields: { name: official.text } }));
      continue;
    }
    output.push(row);
  }
  if (!legacyEmitted) output.push(...legacyRows);
  return output;
}

export function applySoc2Tsc({ dryRun }: { dryRun: boolean }): { changedFiles: string[] } {
  const rows = computeSoc2Requirements({
    requirements: readJsonArray<Requirement>(REQUIREMENTS_FILE),
    core: loadSoc2Core(),
    crosswalk: loadSoc2Crosswalk(),
  });
  if (fs.readFileSync(REQUIREMENTS_FILE, 'utf8') === serializeJsonArray(rows)) {
    return { changedFiles: [] };
  }
  if (!dryRun) writeJsonArray({ filePath: REQUIREMENTS_FILE, rows });
  return { changedFiles: [REQUIREMENTS_FILE] };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--check');
  const result = applySoc2Tsc({ dryRun });
  console.log(
    dryRun ? 'Would change:' : 'Changed:',
    result.changedFiles.length ? result.changedFiles : '(nothing)',
  );
  process.exit(dryRun && result.changedFiles.length > 0 ? 1 : 0);
}

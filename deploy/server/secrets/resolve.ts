import type { ProductionTarget } from '../../../packages/db/src/production-target.ts';
import { isSourceFile, PRODUCTION_ONLY_FILE, type SecretKeySpec, type SourceFile } from './keys.ts';
import { valueProblems } from './values.ts';

// Resolves each key of comp/production/config from its source file, checks that every other
// place holding the same value agrees, and runs the value checks. Ported from the parked
// sync-secrets-plan.ts (revola/aws-infra). Messages name keys and files, never values.

export type SourceValues = Partial<Record<SourceFile, Readonly<Record<string, string>>>>;

type Location = Readonly<{ file: SourceFile; name: string }>;

/**
 * Other places the same value lives, which must agree with the source. A production-only key
 * has no companions: a laptop file holding the same name holds the laptop's own value.
 */
function companions({
  spec,
  name,
  sources,
}: {
  spec: SecretKeySpec;
  name: string;
  sources: SourceValues;
}): Location[] {
  const files = Object.keys(sources).filter(isSourceFile);
  const aliases = spec.aliases ?? [];
  if (spec.fileSpecific || spec.file === PRODUCTION_ONLY_FILE) return [...aliases];
  const sameName = files
    .filter((file) => file !== spec.file && !spec.differsIn?.includes(file))
    .map((file) => ({ file, name }));
  return [...sameName, ...aliases];
}

/** The production-only file may hold only the keys read from it (a typo is caught here). */
function productionFileProblems({
  secretKeys,
  sources,
}: {
  secretKeys: Readonly<Record<string, SecretKeySpec>>;
  sources: SourceValues;
}): string[] {
  const readFromIt = new Set(
    Object.entries(secretKeys)
      .filter(([, spec]) => spec.file === PRODUCTION_ONLY_FILE)
      .map(([key, spec]) => spec.name ?? key),
  );
  const unread = Object.keys(sources[PRODUCTION_ONLY_FILE] ?? {})
    .filter((name) => !readFromIt.has(name))
    .sort();
  if (unread.length === 0) return [];
  return [
    `${PRODUCTION_ONLY_FILE} holds ${unread.join(', ')}, which push-secrets does not read from it; remove them`,
  ];
}

/** A production-only value must differ from the laptops' value of the same name (names only). */
function laptopCopyProblems({
  key,
  spec,
  name,
  value,
  sources,
}: {
  key: string;
  spec: SecretKeySpec;
  name: string;
  value: string;
  sources: SourceValues;
}): string[] {
  if (spec.file !== PRODUCTION_ONLY_FILE) return [];
  return Object.keys(sources)
    .filter(isSourceFile)
    .filter((file) => file !== PRODUCTION_ONLY_FILE && sources[file]?.[name] === value)
    .map(
      (file) => `${key} in ${PRODUCTION_ONLY_FILE} equals its value in ${file}; production needs its own value`,
    );
}

/** A value holding another key's `KEY=` is two lines glued together (a missing line break). */
function gluedLineProblems({
  key,
  file,
  value,
  keys,
}: {
  key: string;
  file: SourceFile;
  value: string;
  keys: readonly string[];
}): string[] {
  if (!keys.some((other) => value.includes(`${other}=`))) return [];
  return [
    `${key} in ${file} holds another KEY=VALUE pair, as if two lines were glued together; put each on its own line`,
  ];
}

function resolveKey({
  key,
  spec,
  sources,
  target,
  keys,
}: {
  key: string;
  spec: SecretKeySpec;
  sources: SourceValues;
  target: ProductionTarget;
  keys: readonly string[];
}): { value?: string; problems: string[]; notes: string[] } {
  const file = sources[spec.file];
  const primary = spec.name ?? key;
  const fallback = spec.fallbackName;
  const usesFallback = fallback !== undefined && !file?.[primary] && Boolean(file?.[fallback]);
  const name = usesFallback ? fallback : primary;
  const notes = usesFallback ? [`${key}: ${spec.file} has no ${primary}; using its ${name}`] : [];
  const value = file?.[name];
  if (value === undefined || value === '') {
    const shown = name === key ? key : `${key} (${name})`;
    return { problems: [`${shown} not found in ${spec.file}; add it there`], notes };
  }
  const disagreeing = companions({ spec, name, sources }).filter((place) => {
    const other = sources[place.file]?.[place.name];
    return other !== undefined && other !== '' && other !== value;
  });
  const problems = disagreeing.map((place) => {
    const suffix = place.name === name ? '' : ` (${place.name})`;
    return `${key} disagrees between ${spec.file} and ${place.file}${suffix}`;
  });
  problems.push(...gluedLineProblems({ key, file: spec.file, value, keys }));
  problems.push(...laptopCopyProblems({ key, spec, name, value, sources }));
  problems.push(...valueProblems({ key, value, target }));
  return problems.length === 0 ? { value, problems, notes } : { problems, notes };
}

export function resolveDesired({
  secretKeys,
  sources,
  target,
}: {
  secretKeys: Readonly<Record<string, SecretKeySpec>>;
  sources: SourceValues;
  target: ProductionTarget;
}): { values: Record<string, string>; problems: string[]; notes: string[] } {
  const values: Record<string, string> = {};
  const problems: string[] = [];
  const notes: string[] = [];
  for (const [key, spec] of Object.entries(secretKeys)) {
    const resolved = resolveKey({ key, spec, sources, target, keys: Object.keys(secretKeys) });
    problems.push(...resolved.problems);
    notes.push(...resolved.notes);
    if (resolved.value !== undefined) values[key] = resolved.value;
  }
  const { TRIGGER_SECRET_KEY_API: apiKey, TRIGGER_SECRET_KEY_APP: appKey } = values;
  if (apiKey !== undefined && apiKey === appKey) {
    problems.push(
      'TRIGGER_SECRET_KEY_API and TRIGGER_SECRET_KEY_APP are the same key; each Trigger.dev project has its own prod key',
    );
  }
  problems.push(...productionFileProblems({ secretKeys, sources }));
  return { values, problems, notes };
}

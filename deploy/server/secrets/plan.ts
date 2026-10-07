// The names-only diff of a push against the current comp/production/config: which keys are
// added, changed and removed, and how many stay. Values are compared in memory and never
// printed, not even as a digest.

export type PushPlan = Readonly<{
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: number;
  problems: string[];
}>;

/** Keys that can never change once the secret holds them, and why. */
const NEVER_CHANGED: Readonly<Record<string, string>> = Object.freeze({
  ENCRYPTION_KEY: 'it encrypts stored credentials, so it never changes once set',
  SECRET_KEY: 'it signs every session and verification token, so it never changes once set',
});

export function planPush({
  desired,
  current,
}: {
  desired: Readonly<Record<string, string>>;
  current: Readonly<Record<string, string>> | undefined;
}): PushPlan {
  const before = current ?? {};
  const added = Object.keys(desired).filter((key) => !(key in before)).sort();
  const removed = Object.keys(before).filter((key) => !(key in desired)).sort();
  const changed = Object.keys(desired)
    .filter((key) => key in before && before[key] !== desired[key])
    .sort();
  const problems: string[] = [];
  for (const [key, reason] of Object.entries(NEVER_CHANGED)) {
    if (!(key in before)) continue;
    if (!(key in desired)) {
      problems.push(`${key} would be removed; ${reason}`);
      continue;
    }
    if (before[key] !== desired[key]) {
      problems.push(
        `${key} would change; ${reason} (restore the value the secret holds in its source file)`,
      );
    }
  }
  const unchanged = Object.keys(desired).length - added.length - changed.length;
  return { added, changed, removed, unchanged, problems };
}

function group({ label, keys }: { label: string; keys: readonly string[] }): string {
  return keys.length === 0 ? `${label}: none` : `${label} (${keys.length}): ${keys.join(', ')}`;
}

/** The plan as name-only lines. */
export function formatPlan({ plan }: { plan: PushPlan }): string[] {
  return [
    group({ label: 'added', keys: plan.added }),
    group({ label: 'changed', keys: plan.changed }),
    group({ label: 'removed', keys: plan.removed }),
    `unchanged: ${plan.unchanged}`,
  ];
}

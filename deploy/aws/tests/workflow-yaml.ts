// A GitHub Actions workflow's triggers, whichever way the YAML parser keys them. YAML 1.1
// parsers (Bun 1.3.4's Bun.YAML, for one) read the bare key `on` as the boolean true,
// so the triggers land under "true"; YAML 1.2 parsers keep "on".

export type Triggers = Record<string, { inputs?: Record<string, { required?: boolean }> } | null>;

export function workflowTriggers(workflow: Record<string, unknown>): Triggers {
  const triggers = workflow.on ?? workflow.true;
  if (!triggers || typeof triggers !== 'object') {
    throw new Error('the workflow has no triggers (neither "on" nor "true")');
  }
  return triggers as Triggers;
}

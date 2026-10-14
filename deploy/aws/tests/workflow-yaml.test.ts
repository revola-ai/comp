import { describe, expect, test } from 'bun:test';
import { workflowTriggers } from './workflow-yaml.ts';

describe('workflowTriggers', () => {
  test('reads the triggers under the key "on" (YAML 1.2 parsers)', () => {
    expect(workflowTriggers({ on: { workflow_dispatch: {} } })).toEqual({ workflow_dispatch: {} });
  });

  test('reads the triggers under the key "true" (YAML 1.1 parsers, e.g. Bun 1.3.4)', () => {
    expect(workflowTriggers({ true: { workflow_dispatch: {} } })).toEqual({
      workflow_dispatch: {},
    });
  });

  test('throws when the workflow has no triggers', () => {
    expect(() => workflowTriggers({ jobs: {} })).toThrow(/no triggers/);
  });
});

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The fork never releases a device agent on push, and a manual release needs this
// deployment's https revola.ai URLs: upstream's workflow built agents pointing at
// upstream's portal and API on every push touching packages/device-agent.

const REPO_ROOT = join(import.meta.dir, '../../..');
const WORKFLOW = join(REPO_ROOT, '.github/workflows/device-agent-release.yml');

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Workflow = {
  on: Record<string, { inputs?: Record<string, { required?: boolean }> } | null>;
  jobs: { 'detect-version': { steps: Step[] } } & Record<string, { steps: Step[] }>;
};

const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as Workflow;

// The variables electron-vite build and electron-builder packaging require.
const { BUILD_URL_NAMES } = (await import(
  join(REPO_ROOT, 'packages/device-agent/src/build-config/build-urls.cjs')
)) as { BUILD_URL_NAMES: readonly string[] };

/** Runs the version step's script with the given inputs; returns its exit code and outputs. */
function runVersionStep({ portalUrl, apiUrl }: { portalUrl: string; apiUrl: string }) {
  const step = workflow.jobs['detect-version'].steps.find((s) => s.name === 'Compute next version');
  const dir = mkdtempSync(join(tmpdir(), 'device-agent-release-'));
  const output = join(dir, 'output');
  const result = spawnSync('bash', ['-e', '-c', step?.run ?? 'exit 99'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      PORTAL_URL: portalUrl,
      API_URL: apiUrl,
      CHANNEL: 'staging',
      GITHUB_OUTPUT: output,
      GITHUB_RUN_NUMBER: '1',
    },
  });
  let outputs = '';
  try {
    outputs = readFileSync(output, 'utf8');
  } catch {
    outputs = '';
  }
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, outputs, stdout: result.stdout };
}

describe('device agent release workflow', () => {
  test('runs only on manual dispatch with required portal and API URL inputs', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    const inputs = workflow.on.workflow_dispatch?.inputs ?? {};
    expect(inputs.portal_url?.required).toBe(true);
    expect(inputs.api_url?.required).toBe(true);
  });

  test('names no upstream host', () => {
    expect(readFileSync(WORKFLOW, 'utf8')).not.toMatch(/trycomp\.ai|trust\.inc/i);
  });

  test('fails fast unless both URLs are https on a revola.ai host', () => {
    const revola = 'https://portal.comp.revola.ai';
    for (const [portalUrl, apiUrl] of [
      ['https://portal.trycomp.ai', 'https://api.comp.revola.ai'],
      [revola, 'http://api.comp.revola.ai'],
      [revola, 'https://api.comp.revola.ai.evil.example'],
      [revola, ''],
    ] as const) {
      const { status, outputs } = runVersionStep({ portalUrl, apiUrl });
      expect(status).toBe(1);
      expect(outputs).not.toContain('portal_url=');
    }
  });

  test('derives the update feed from the given portal', () => {
    const { status, outputs } = runVersionStep({
      portalUrl: 'https://portal.comp.revola.ai/',
      apiUrl: 'https://api.comp.revola.ai',
    });
    expect(status).toBe(0);
    expect(outputs).toContain('portal_url=https://portal.comp.revola.ai\n');
    expect(outputs).toContain(
      'auto_update_url=https://portal.comp.revola.ai/api/device-agent/updates\n',
    );
    expect(outputs).toContain('is_prerelease=true\n');
  });

  test('passes every build URL to each build and package step', () => {
    const steps = Object.entries(workflow.jobs).flatMap(([job, { steps }]) =>
      steps
        .filter((step) => /bun run (build|package:)/.test(step.run ?? ''))
        .map((step) => ({ id: `${job}: ${step.name}`, env: Object.keys(step.env ?? {}) })),
    );
    expect(steps.length).toBe(6);
    for (const { id, env } of steps) {
      expect({ id, missing: BUILD_URL_NAMES.filter((name) => !env.includes(name)) }).toEqual({
        id,
        missing: [],
      });
    }
  });
});

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The fork never publishes the security questionnaire extension on push, and a manual
// release needs this deployment's https revola.ai URLs: upstream's workflow built it
// against api.trycomp.ai and app.trycomp.ai on every push to `release`.

const REPO_ROOT = join(import.meta.dir, '../../..');
const WORKFLOW = join(REPO_ROOT, '.github/workflows/security-questionnaire-extension-release.yml');

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Workflow = {
  on: Record<string, { inputs?: Record<string, { required?: boolean }> } | null>;
  env?: Record<string, string>;
  jobs: { release: { steps: Step[] } };
};

const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as Workflow;
const steps = workflow.jobs.release.steps;
const VALIDATE = 'Validate deployment URLs';

/** Runs the URL validation step; returns its exit code and what it exported. */
function runValidation({ apiUrl, appUrl }: { apiUrl: string; appUrl: string }) {
  const step = steps.find((s) => s.name === VALIDATE);
  const dir = mkdtempSync(join(tmpdir(), 'extension-release-'));
  const githubEnv = join(dir, 'env');
  const result = spawnSync('bash', ['-e', '-c', step?.run ?? 'exit 99'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, API_URL: apiUrl, APP_URL: appUrl, GITHUB_ENV: githubEnv },
  });
  let exported = '';
  try {
    exported = readFileSync(githubEnv, 'utf8');
  } catch {
    exported = '';
  }
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, exported };
}

describe('security questionnaire extension release workflow', () => {
  test('runs only on manual dispatch with required API and app URL inputs', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    const inputs = workflow.on.workflow_dispatch?.inputs ?? {};
    expect(inputs.api_url?.required).toBe(true);
    expect(inputs.app_url?.required).toBe(true);
  });

  test('names no upstream host and sets no build URL at workflow level', () => {
    expect(readFileSync(WORKFLOW, 'utf8')).not.toMatch(/trycomp\.ai|trust\.inc/i);
    expect(workflow.env ?? {}).not.toHaveProperty('WXT_PUBLIC_API_BASE_URL');
    expect(workflow.env ?? {}).not.toHaveProperty('WXT_PUBLIC_APP_BASE_URL');
  });

  test('validates the URLs before anything else runs', () => {
    expect(steps[0]?.name).toBe(VALIDATE);
    expect(steps[0]?.env).toEqual({
      API_URL: '${{ inputs.api_url }}',
      APP_URL: '${{ inputs.app_url }}',
    });
  });

  test('fails fast unless both URLs are https on a revola.ai host', () => {
    const app = 'https://app.comp.revola.ai';
    for (const [apiUrl, appUrl] of [
      ['https://api.trycomp.ai', app],
      ['http://api.comp.revola.ai', app],
      ['https://api.comp.revola.ai.evil.example', app],
      ['https://api.comp.revola.ai', ''],
    ] as const) {
      const { status, exported } = runValidation({ apiUrl, appUrl });
      expect(status).toBe(1);
      expect(exported).toBe('');
    }
  });

  test('exports the validated URLs for the build and the manifest check', () => {
    const { status, exported } = runValidation({
      apiUrl: 'https://api.comp.revola.ai/',
      appUrl: 'https://app.comp.revola.ai',
    });
    expect(status).toBe(0);
    expect(exported).toBe(
      'WXT_PUBLIC_API_BASE_URL=https://api.comp.revola.ai\nWXT_PUBLIC_APP_BASE_URL=https://app.comp.revola.ai\n',
    );
    const check = steps.find((s) => s.name === 'Verify manifest version');
    expect(check?.run).toContain('process.env.WXT_PUBLIC_API_BASE_URL');
  });
});

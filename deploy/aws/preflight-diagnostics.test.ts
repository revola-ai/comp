import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { config } from './config.ts';
import { runPreflight } from './preflight.ts';
import { AWS_STUB, failureMessage, install, useStubbedTools } from './tests/preflight-stubs.ts';

setDefaultTimeout(30_000);
useStubbedTools();

describe('preflight failure diagnostics', () => {
  test('a failed AWS call reports the first line of its stderr, trimmed', async () => {
    const body = AWS_STUB.replace(
      '[ -n "$STUB_ACCOUNT" ] || exit 255;',
      '[ -n "$STUB_ACCOUNT" ] || { echo "  An error occurred (ExpiredToken): the token expired  " >&2; echo "second line" >&2; exit 255; };',
    );
    install({ tool: 'aws', body });
    delete process.env.STUB_ACCOUNT;
    const message = await failureMessage(['aws']);
    expect(message).toContain('aws sts get-caller-identity failed');
    expect(message).toContain('An error occurred (ExpiredToken): the token expired');
    expect(message).not.toContain('second line');
  });

  test('a failed route-table read reports its stderr', async () => {
    const body = AWS_STUB.replace(
      '  "ec2 describe-route-tables")',
      '  "ec2 describe-route-tables") echo "UnauthorizedOperation: not allowed" >&2; exit 254 ;;\n  "unused")',
    );
    install({ tool: 'aws', body });
    const message = await failureMessage(['aws']);
    expect(message).toContain('could not read the route table');
    expect(message).toContain('UnauthorizedOperation: not allowed');
  });

  test('a missing Trigger.dev login reports the CLI stderr', async () => {
    install({
      tool: 'bun',
      body: '#!/bin/sh\necho "Error: You must login first (code 401)" >&2\nexit 1\n',
    });
    const message = await failureMessage(['trigger']);
    expect(message).toContain('Trigger.dev is not logged in');
    expect(message).toContain('Error: You must login first (code 401)');
  });

  test('an unavailable buildx reports its stderr', async () => {
    install({
      tool: 'docker',
      body: '#!/bin/sh\necho "docker: unknown command: docker buildx" >&2\nexit 1\n',
    });
    const message = await failureMessage(['docker']);
    expect(message).toContain('docker buildx is unavailable');
    expect(message).toContain('docker: unknown command: docker buildx');
  });

  test('a tool that writes more stderr than a pipe holds does not stall preflight', async () => {
    install({
      tool: 'docker',
      body: `#!/bin/sh
i=0
while [ "$i" -lt 4000 ]; do
  printf '%s\\n' "warning: ${'x'.repeat(64)}" >&2
  i=$((i + 1))
done
exit 0
`,
    });
    const started = Date.now();
    await runPreflight({ needs: ['docker'] });
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

describe('preflight region', () => {
  test('honours AWS_DEFAULT_REGION when AWS_REGION is unset', async () => {
    process.env.STUB_REGION = 'us-west-2';
    process.env.AWS_DEFAULT_REGION = config.region;
    await runPreflight({ needs: ['aws'] });
  });

  test('AWS_REGION wins over AWS_DEFAULT_REGION', async () => {
    process.env.AWS_REGION = 'us-west-2';
    process.env.AWS_DEFAULT_REGION = config.region;
    expect(await failureMessage(['aws'])).toContain('wrong AWS region us-west-2');
  });

  test('a wrong AWS_DEFAULT_REGION is named', async () => {
    process.env.AWS_DEFAULT_REGION = 'eu-west-1';
    expect(await failureMessage(['aws'])).toContain(
      `wrong AWS region eu-west-1, expected ${config.region}`,
    );
  });
});

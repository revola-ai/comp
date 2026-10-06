import { afterEach, beforeEach } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.ts';
import { runPreflight } from '../preflight.ts';

// Every external tool is a fake executable on a PATH that contains nothing else.
// Behaviour is steered by STUB_* variables; every call is appended to calls.log.
export const AWS_STUB = `#!/bin/sh
echo "aws $*" >> "$STUB_DIR/calls.log"
case "$1 $2" in
  "sts get-caller-identity") [ -n "$STUB_ACCOUNT" ] || exit 255; echo "$STUB_ACCOUNT" ;;
  "configure get") [ -n "$STUB_REGION" ] || exit 1; echo "$STUB_REGION" ;;
  "ec2 describe-route-tables")
    for arg in "$@"; do
      case "$arg" in
        Name=association.subnet-id,Values=*)
          subnet="\${arg#*Values=}"
          # PATH holds only the stubs, so use shell builtins (no cat).
          [ -f "$STUB_DIR/rt-$subnet.json" ] && { IFS= read -r line < "$STUB_DIR/rt-$subnet.json"; echo "$line"; exit 0; } ;;
      esac
    done
    echo '{"RouteTables":[]}' ;;
  *) echo "unexpected aws call: $*" >&2; exit 2 ;;
esac
`;
const BUN_STUB = `#!/bin/sh
echo "bun $*" >> "$STUB_DIR/calls.log"
case "$*" in
  *whoami*) [ "$STUB_TRIGGER" = "out" ] && { echo "not logged in" >&2; exit 1; } ;;
esac
exit 0
`;
const PLAIN_STUB = (name: string) =>
  `#!/bin/sh\necho "${name} $*" >> "$STUB_DIR/calls.log"\nexit 0\n`;

export const NAT_ROUTES = {
  RouteTables: [
    {
      Routes: [
        { DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local', State: 'active' },
        {
          DestinationCidrBlock: '0.0.0.0/0',
          NatGatewayId: 'nat-0123456789abcdef0',
          State: 'active',
        },
      ],
    },
  ],
};

const saved = { ...process.env };
let stubDir = '';

/** The directory holding the fake tools for the running test. */
export function stubDirectory(): string {
  return stubDir;
}

export function install({ tool, body }: { tool: string; body: string }): void {
  const file = join(stubDir, tool);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

export function calls(): string {
  try {
    return readFileSync(join(stubDir, 'calls.log'), 'utf8');
  } catch {
    return '';
  }
}

/** Registers the per-test fake tools and a clean environment for the calling test file. */
export function useStubbedTools(): void {
  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), 'preflight-'));
    install({ tool: 'aws', body: AWS_STUB });
    install({ tool: 'bun', body: BUN_STUB });
    for (const tool of ['git', 'curl', 'docker']) install({ tool, body: PLAIN_STUB(tool) });
    for (const subnet of config.subnetIds) {
      writeFileSync(join(stubDir, `rt-${subnet}.json`), JSON.stringify(NAT_ROUTES));
    }
    process.env = {
      HOME: saved.HOME ?? '',
      PATH: stubDir,
      STUB_DIR: stubDir,
      STUB_ACCOUNT: config.accountId,
      STUB_REGION: config.region,
      CLOUDFLARE_API_TOKEN: 'cf-token-value',
    };
  });

  afterEach(() => {
    process.env = { ...saved };
    rmSync(stubDir, { recursive: true, force: true });
  });
}

export async function failureMessage(
  needs: Parameters<typeof runPreflight>[0]['needs'],
): Promise<string> {
  try {
    await runPreflight({ needs });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('runPreflight resolved but was expected to fail');
}

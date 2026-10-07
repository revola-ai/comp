#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

// A stateful stand-in for the aws CLI, for the push-secrets tests: the TypeScript sibling of
// deploy/server/tests/fake_aws.py, held to the same contract. It answers only the calls
// push-secrets makes (sts get-caller-identity; secretsmanager get-secret-value, create-secret,
// put-secret-value), keeps the secret in the JSON file $FAKE_AWS_STATE, appends every argv as
// one JSON line to $FAKE_AWS_LOG, ignores --query (each operation answers with the text
// push-secrets asks for) and fails like the CLI: "An error occurred (<Code>) when calling the
// <Operation> operation: <message>" on stderr, exit 254. A call without --region us-east-2 is a
// test bug and fails with 255. Nothing here talks to AWS.
//
// Knobs (environment):
//   FAKE_AWS_ACCOUNT   the account get-caller-identity reports (default 455986776194)
//   FAKE_AWS_DENY      "<service> <operation>" that fails with AccessDeniedException
//   FAKE_AWS_BLOCK     "<service> <operation>" that, once it has read its paramfile, writes
//                      {pid, ppid, path} to $FAKE_AWS_STATE.blocked and never returns

const stateSchema = z.object({
  secret: z
    .object({
      name: z.string(),
      value: z.string().nullable(),
      tags: z.array(z.string()),
      versions: z.number(),
    })
    .nullable()
    .default(null),
  writes: z
    .array(
      z.object({
        operation: z.string(),
        path: z.string(),
        fileMode: z.number(),
        dirMode: z.number(),
      }),
    )
    .default([]),
});
export type FakeAwsState = z.infer<typeof stateSchema>;

const argv = process.argv.slice(2);
const env = z
  .object({ FAKE_AWS_LOG: z.string(), FAKE_AWS_STATE: z.string() })
  .parse(process.env);
appendFileSync(env.FAKE_AWS_LOG, `${JSON.stringify(['aws', ...argv])}\n`);

const state = stateSchema.parse(
  existsSync(env.FAKE_AWS_STATE) ? JSON.parse(readFileSync(env.FAKE_AWS_STATE, 'utf8')) : {},
);

function fail({ code, operation, message }: { code: string; operation: string; message: string }): never {
  process.stderr.write(`\nAn error occurred (${code}) when calling the ${operation} operation: ${message}\n`);
  process.exit(254);
}

function out(text: string): never {
  writeFileSync(env.FAKE_AWS_STATE, JSON.stringify(state, null, 1));
  process.stdout.write(`${text}\n`);
  process.exit(0);
}

function option(name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === undefined) {
    process.stderr.write(`fake aws: ${argv.slice(0, 2).join(' ')} needs ${name}\n`);
    process.exit(255);
  }
  return value;
}

/** Reads a file:// parameter the way the CLI does, recording its modes at call time. */
function readParamFile(operation: string): string {
  const reference = option('--secret-string');
  if (!reference.startsWith('file://')) {
    process.stderr.write('fake aws: --secret-string must be a file:// reference\n');
    process.exit(255);
  }
  const path = reference.slice('file://'.length);
  state.writes.push({
    operation,
    path,
    fileMode: statSync(path).mode & 0o777,
    dirMode: statSync(dirname(path)).mode & 0o777,
  });
  const contents = readFileSync(path, 'utf8');
  if (process.env.FAKE_AWS_BLOCK === `${argv[0]} ${operation}`) {
    writeFileSync(`${env.FAKE_AWS_STATE}.blocked`, JSON.stringify({ pid: process.pid, ppid: process.ppid, path }));
    // Sleeps (at most 10 minutes) until a signal ends this process; it has no handlers.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600_000);
    process.exit(255);
  }
  return contents;
}

const [service, operation] = argv;
if (option('--region') !== 'us-east-2') {
  process.stderr.write('fake aws: every call must name --region us-east-2\n');
  process.exit(255);
}
if (process.env.FAKE_AWS_DENY === `${service} ${operation}`) {
  fail({
    code: 'AccessDeniedException',
    operation: operation ?? '',
    message: 'User is not authorized to perform this action',
  });
}

if (service === 'sts' && operation === 'get-caller-identity') {
  out(process.env.FAKE_AWS_ACCOUNT ?? '455986776194');
}

const NOT_FOUND = "Secrets Manager can't find the specified secret.";

if (service === 'secretsmanager' && operation === 'get-secret-value') {
  option('--secret-id');
  if (state.secret === null) fail({ code: 'ResourceNotFoundException', operation: 'GetSecretValue', message: NOT_FOUND });
  if (state.secret.value === null) {
    fail({
      code: 'ResourceNotFoundException',
      operation: 'GetSecretValue',
      message: "Secrets Manager can't find the specified secret value for staging label: AWSCURRENT",
    });
  }
  out(state.secret.value);
}

if (service === 'secretsmanager' && operation === 'create-secret') {
  const name = option('--name');
  if (state.secret !== null) {
    fail({ code: 'ResourceExistsException', operation: 'CreateSecret', message: `The operation failed because the secret ${name} already exists.` });
  }
  const value = readParamFile(operation);
  state.secret = { name, value, tags: argv.slice(argv.indexOf('--tags') + 1, argv.indexOf('--tags') + 2), versions: 1 };
  out('fake-version-1');
}

if (service === 'secretsmanager' && operation === 'put-secret-value') {
  option('--secret-id');
  if (state.secret === null) fail({ code: 'ResourceNotFoundException', operation: 'PutSecretValue', message: NOT_FOUND });
  state.secret.value = readParamFile(operation);
  state.secret.versions += 1;
  out(`fake-version-${state.secret.versions}`);
}

process.stderr.write(`fake aws: unexpected call ${argv.slice(0, 2).join(' ')}\n`);
process.exit(255);

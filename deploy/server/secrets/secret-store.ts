import { z } from 'zod';
import { aws, AwsError, type AwsRunner } from './aws-cli.ts';
import { withPrivateFile } from './private-file.ts';

// comp/production/config through the AWS CLI. The current value is read from the CLI's stdout
// into memory, only to diff it. The new value goes through a 0600 file in a private 0700
// directory (--secret-string file://<path>), never an argument, a pipe or the terminal. The
// first push creates the secret (default aws/secretsmanager key, tag Project=comp); later
// pushes put a new version.

export const SECRET_ID = 'comp/production/config';
const DESCRIPTION = 'Comp production config (deploy/server/push-secrets.ts)';
const TAGS = 'Key=Project,Value=comp';
const FILE_PLACEHOLDER = 'file://<0600 file in a private temporary directory>';

/** absent: no secret yet (create); empty: a secret with no current value (put); present. */
export type SecretState =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'empty' }>
  | Readonly<{ kind: 'present'; values: Readonly<Record<string, string>> }>;

export type SecretStore = Readonly<{
  read: () => Promise<SecretState>;
  /** The command a write runs, as printed before the question. */
  describeWrite: (args: { create: boolean }) => string;
  write: (args: { json: string; create: boolean }) => Promise<{ versionId: string }>;
}>;

const secretJsonSchema = z.record(z.string(), z.string());

function writeArgs({ create, file }: { create: boolean; file: string }): string[] {
  const value = ['--secret-string', file, '--query', 'VersionId', '--output', 'text'];
  if (!create) return ['secretsmanager', 'put-secret-value', '--secret-id', SECRET_ID, ...value];
  return [
    ...['secretsmanager', 'create-secret', '--name', SECRET_ID],
    ...['--description', DESCRIPTION, '--tags', TAGS],
    ...value,
  ];
}

export function awsSecretStore({ run }: { run: AwsRunner }): SecretStore {
  return {
    read: async () => {
      let text: string;
      try {
        text = await aws({
          run,
          args: [
            ...['secretsmanager', 'get-secret-value', '--secret-id', SECRET_ID],
            ...['--query', 'SecretString', '--output', 'text'],
          ],
        });
      } catch (error) {
        if (!(error instanceof AwsError)) throw error;
        // A secret without a current version yet has no AWSCURRENT label.
        if (error.stderr.includes('AWSCURRENT')) return { kind: 'empty' };
        if (error.stderr.includes('ResourceNotFoundException')) return { kind: 'absent' };
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`${SECRET_ID} does not hold a JSON object of strings`);
      }
      const values = secretJsonSchema.safeParse(parsed);
      if (!values.success) throw new Error(`${SECRET_ID} does not hold a JSON object of strings`);
      return { kind: 'present', values: values.data };
    },
    describeWrite: ({ create }) =>
      ['aws', ...writeArgs({ create, file: FILE_PLACEHOLDER }), '--region', 'us-east-2'].join(' '),
    write: ({ json, create }) =>
      withPrivateFile({
        prefix: 'comp-secret-',
        contents: json,
        work: async (file) => {
          const versionId = await aws({ run, args: writeArgs({ create, file: `file://${file}` }) });
          return { versionId: versionId.trim() };
        },
      }),
  };
}

import { spawnSync } from 'node:child_process';

export type CommandEnv = Record<string, string | undefined>;

export type RunCommand = (call: { command: string; args: string[]; env: CommandEnv }) => number;

// Runs a command in the foreground with inherited stdio and returns its exit code
// (1 when it could not start or was killed by a signal).
export const runCommand: RunCommand = ({ command, args, env }) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) {
    console.error(`could not start ${command}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
};

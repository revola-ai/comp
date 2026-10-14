import { binaryForRuntime, BuildContext, BuildExtension, BuildManifest } from '@trigger.dev/build';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  assertWorkspaceDbBuilt,
  vendorWorkspaceDb,
} from '../../packages/db/scripts/vendor-db-for-trigger';
import { resolvePrismaSchemaPath } from './prismaSchemaPaths';

export type PrismaExtensionOptions = {
  version?: string;
  migrate?: boolean;
  directUrlEnvVarName?: string;
};

// @trycompai/db stays external (resolved at runtime from node_modules), but it is the
// fork's own build, vendored from packages/db by vendorWorkspaceDb, never npm's
// upstream package.
const WORKSPACE_DB = '@trycompai/db';

type ExtendedBuildContext = BuildContext & { workspaceDir?: string };

// apps/<name> sits two levels below the repository root. context.workspaceDir is not
// used: in a git worktree it can point at the main checkout.
function repoRootOf(context: BuildContext): string {
  return resolve(context.workingDir, '..', '..');
}

export function prismaExtension(options: PrismaExtensionOptions = {}): PrismaExtension {
  return new PrismaExtension(options);
}

export class PrismaExtension implements BuildExtension {
  moduleExternals: string[];
  public readonly name = 'PrismaExtension';
  private _resolvedSchemaPath?: string;

  constructor(private options: PrismaExtensionOptions) {
    this.moduleExternals = ['@prisma/client', WORKSPACE_DB];
  }

  externalsForTarget(target: BuildContext['target']) {
    if (target === 'dev') {
      return [];
    }
    return this.moduleExternals;
  }

  async onBuildStart(context: BuildContext) {
    if (context.target === 'dev') {
      return;
    }

    // Errors thrown in onBuildComplete are only logged by the CLI, so the
    // missing-build check runs here, where it stops the deploy.
    assertWorkspaceDbBuilt({ repoRoot: repoRootOf(context) });

    const resolution = resolvePrismaSchemaPath(context as ExtendedBuildContext);

    if (!resolution.path) {
      context.logger.debug(
        'Prisma schema not found during build start, likely before dependencies are installed.',
        { searched: resolution.searched },
      );
      return;
    }

    this._resolvedSchemaPath = resolution.path;
    context.logger.debug(`Resolved prisma schema to ${resolution.path}`);
    await this.ensureLocalPrismaClient(context as ExtendedBuildContext, resolution.path);
  }

  async onBuildComplete(context: BuildContext, manifest: BuildManifest) {
    if (context.target === 'dev') {
      return;
    }

    if (!this._resolvedSchemaPath || !existsSync(this._resolvedSchemaPath)) {
      const resolution = resolvePrismaSchemaPath(context as ExtendedBuildContext);

      if (!resolution.path) {
        throw new Error(
          [
            'PrismaExtension could not find the prisma schema. Make sure packages/db is built',
            '(run bun run build in packages/db).',
            'Searched the following locations:',
            ...resolution.searched.map((candidate) => ` - ${candidate}`),
          ].join('\n'),
        );
      }

      this._resolvedSchemaPath = resolution.path;
    }

    assert(this._resolvedSchemaPath, 'Resolved schema path is not set');
    const schemaPath = this._resolvedSchemaPath;

    await this.ensureLocalPrismaClient(context as ExtendedBuildContext, schemaPath);

    context.logger.debug('Looking for @prisma/client in the externals', {
      externals: manifest.externals,
    });

    const prismaExternal = manifest.externals?.find(
      (external) => external.name === '@prisma/client',
    );
    const version = prismaExternal?.version ?? this.options.version;

    if (!version) {
      throw new Error(
        `PrismaExtension could not determine the version of @prisma/client. It's possible that the @prisma/client was not used in the project. If this isn't the case, please provide a version in the PrismaExtension options.`,
      );
    }

    context.logger.debug(
      `PrismaExtension is generating the Prisma client for version ${version} from the workspace schema`,
    );

    const commands: string[] = [];
    const env: Record<string, string | undefined> = {};

    // Copy the prisma schema from the published package to the build output path
    // Copy the entire schema directory (multi-file schema)
    const sourceDir = dirname(schemaPath);
    const schemaDestinationDir = join(manifest.outputPath, 'prisma', 'schema');
    context.logger.debug(
      `Copying the prisma schema directory from ${sourceDir} to ${schemaDestinationDir}`,
    );
    await mkdir(schemaDestinationDir, { recursive: true });
    await cp(sourceDir, schemaDestinationDir, { recursive: true });

    // Patch schema.prisma to use prisma-client-js (populates @prisma/client at runtime)
    commands.push(
      `sed -i 's/provider.*=.*"prisma-client"/provider = "prisma-client-js"/' ./prisma/schema/schema.prisma && sed -i '/output.*=.*"/d' ./prisma/schema/schema.prisma`,
    );

    // Generate client from the multi-file schema directory
    commands.push(
      `${binaryForRuntime(manifest.runtime)} node_modules/prisma/build/index.js generate --schema=./prisma/schema`,
    );

    if (this.options.migrate) {
      context.logger.warn(
        'PrismaExtension never migrates during a deploy; production migrations ship with release.sh migrate',
      );
    }

    // Set up environment variables
    env.DATABASE_URL = manifest.deploy.env?.DATABASE_URL;

    if (this.options.directUrlEnvVarName) {
      env[this.options.directUrlEnvVarName] =
        manifest.deploy.env?.[this.options.directUrlEnvVarName] ??
        process.env[this.options.directUrlEnvVarName];
      if (!env[this.options.directUrlEnvVarName]) {
        context.logger.warn(
          `prismaExtension could not resolve the ${this.options.directUrlEnvVarName} environment variable. Make sure you add it to your environment variables or provide it as an environment variable to the deploy CLI command. See our docs for more info: https://trigger.dev/docs/deploy-environment-variables`,
        );
      }
    } else {
      env.DIRECT_URL = manifest.deploy.env?.DIRECT_URL;
      env.DIRECT_DATABASE_URL = manifest.deploy.env?.DIRECT_DATABASE_URL;
    }

    if (!env.DATABASE_URL) {
      context.logger.warn(
        'prismaExtension could not resolve the DATABASE_URL environment variable. Make sure you add it to your environment variables. See our docs for more info: https://trigger.dev/docs/deploy-environment-variables',
      );
    }

    // Vendor the fork's @trycompai/db into the build output and drop the npm entry the
    // externals collector recorded for it; its runtime dependencies are installed instead.
    const { dependencies: dbDependencies } = vendorWorkspaceDb({
      repoRoot: repoRootOf(context),
      outputPath: manifest.outputPath,
    });
    manifest.externals = (manifest.externals ?? []).filter(
      (external) => external.name !== WORKSPACE_DB,
    );
    const dependencies = { ...dbDependencies, prisma: version };

    context.logger.debug('Adding the prisma layer with the following commands', {
      commands,
      env,
      dependencies,
    });

    context.addLayer({
      id: 'prisma',
      commands,
      dependencies,
      build: {
        env,
      },
    });
  }

  private async ensureLocalPrismaClient(
    context: ExtendedBuildContext,
    schemaSourcePath: string,
  ): Promise<void> {
    // schemaSourcePath points to a file inside the schema directory.
    // Copy the entire directory (multi-file schema) to the local prisma/schema/ dir.
    const sourceDir = dirname(schemaSourcePath);
    const localSchemaDir = resolve(context.workingDir, 'prisma', 'schema');

    await mkdir(localSchemaDir, { recursive: true });
    await cp(sourceDir, localSchemaDir, { recursive: true });

    // Patch schema.prisma to use prisma-client-js (default output → @prisma/client)
    const localSchemaFile = resolve(localSchemaDir, 'schema.prisma');
    const { readFileSync, writeFileSync } = await import('node:fs');
    let schemaContent = readFileSync(localSchemaFile, 'utf8');
    schemaContent = schemaContent
      .replace(/provider\s*=\s*"prisma-client"/g, 'provider = "prisma-client-js"')
      .replace(/\s*output\s*=\s*"[^"]*"\n?/g, '\n');
    writeFileSync(localSchemaFile, schemaContent);

    const clientEntryPoint = resolve(context.workingDir, 'node_modules/.prisma/client/default.js');

    if (existsSync(clientEntryPoint) && !process.env.TRIGGER_PRISMA_FORCE_GENERATE) {
      context.logger.debug('Prisma client already generated locally, skipping regenerate.');
      return;
    }

    const prismaBinary = this.resolvePrismaBinary(context.workingDir);

    if (!prismaBinary) {
      context.logger.debug(
        'Prisma CLI not available yet, skipping local generate until install finishes.',
      );
      return;
    }

    context.logger.log('Prisma client missing. Generating before Trigger indexing.');
    await this.runPrismaGenerate(context, prismaBinary, localSchemaDir);
  }

  private runPrismaGenerate(
    context: ExtendedBuildContext,
    prismaBinary: string,
    schemaPath: string,
  ): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(prismaBinary, ['generate', `--schema=${schemaPath}`], {
        cwd: context.workingDir,
        env: {
          ...process.env,
          PRISMA_HIDE_UPDATE_MESSAGE: '1',
        },
      });

      child.stdout?.on('data', (data: Buffer) => {
        context.logger.debug(data.toString().trim());
      });

      child.stderr?.on('data', (data: Buffer) => {
        context.logger.warn(data.toString().trim());
      });

      child.on('error', (error) => {
        rejectPromise(error);
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolvePromise();
        } else {
          rejectPromise(new Error(`prisma generate exited with code ${code}`));
        }
      });
    });
  }

  private resolvePrismaBinary(workingDir: string): string | undefined {
    const binDir = resolve(workingDir, 'node_modules', '.bin');
    const executable = process.platform === 'win32' ? 'prisma.cmd' : 'prisma';
    const binaryPath = resolve(binDir, executable);

    if (!existsSync(binaryPath)) {
      return undefined;
    }

    return binaryPath;
  }
}

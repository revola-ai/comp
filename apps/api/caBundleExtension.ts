import type {
  BuildContext,
  BuildExtension,
  BuildManifest,
} from '@trigger.dev/build';
import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

// The public Supabase root CA, committed once for every runtime (the ECS images carry
// the same file at /app/certs/supabase-ca.crt). The workers verify the database with it
// through DATABASE_SSL_CA, which the production connection policy requires.
const CA_SOURCE_FROM_REPO_ROOT = 'deploy/aws/certs/supabase-ca.crt';
const CA_DEST_REL = 'certs/supabase-ca.crt';
const CA_RUNTIME_PATH = `/app/${CA_DEST_REL}`;

// apps/<name> sits two levels below the repository root. context.workspaceDir is not
// used: in a git worktree it can point at the main checkout.
function caSourceOf(context: BuildContext): string {
  return resolve(context.workingDir, '..', '..', CA_SOURCE_FROM_REPO_ROOT);
}

export function caBundleExtension(): BuildExtension {
  return {
    name: 'CABundleExtension',
    onBuildStart: (context) => {
      if (context.target === 'dev') return;
      // Checked here because errors in onBuildComplete are only logged by the CLI.
      const source = caSourceOf(context);
      if (!existsSync(source)) {
        throw new Error(
          `CABundleExtension: ${CA_SOURCE_FROM_REPO_ROOT} not found at ${source}`,
        );
      }
      // Real OS env vars at task spawn time:
      //   addLayer.deploy.env -> manifest.deploy.sync.env -> syncEnvVarsWithServer ->
      //   the worker env, before Node's TLS init. DATABASE_SSL_CA drives
      //   buildPgAdapterOptions; NODE_EXTRA_CA_CERTS lets other TLS clients trust it too.
      context.addLayer({
        id: 'ca-bundle-env',
        deploy: {
          env: {
            DATABASE_SSL_CA: CA_RUNTIME_PATH,
            NODE_EXTRA_CA_CERTS: CA_RUNTIME_PATH,
          },
          override: true,
        },
      });
    },
    onBuildComplete: async (context: BuildContext, manifest: BuildManifest) => {
      if (context.target === 'dev') return;
      const dest = join(manifest.outputPath, CA_DEST_REL);
      await mkdir(dirname(dest), { recursive: true });
      await cp(caSourceOf(context), dest);
      context.logger.log(`Copied the Supabase CA to ${CA_DEST_REL}`);
    },
  };
}

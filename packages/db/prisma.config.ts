import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { enforcePrismaCliGuard } from './scripts/prisma-cli-guard';

// Refuses `migrate dev`, `migrate reset`, `migrate deploy`, `migrate resolve`, `db push`,
// `db seed`, `db execute` and `studio` against the shared production database unless
// COMP_I_AM_TOUCHING_PROD=1 (runs after the dotenv load, so it checks the URL this
// command uses, and any `--url` that overrides it).
enforcePrismaCliGuard();

export default defineConfig({
  schema: 'prisma/schema',
  datasource: {
    url: process.env.DATABASE_URL!,
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'bun prisma/seed/seed.ts',
  },
});

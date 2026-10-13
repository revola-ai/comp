// Runs SQL against a throwaway in-memory Postgres (PGlite) for specs that need
// real database behaviour: triggers, foreign-key cascades, migration SQL.
// PGlite is ESM and loads its WebAssembly through dynamic import, which jest's
// CommonJS runtime cannot do, so specs run this file with plain node:
//
//   execFileSync(process.execPath, [runner], { input: JSON.stringify(job) })
//
// job = { setup: string[], scenarios: { [name]: string[] } }
// `setup` scripts run once, in order (multi-statement scripts are fine). Each
// scenario then runs its statements one by one inside BEGIN ... ROLLBACK, so
// scenarios start from the same state. Prints, as JSON, for each scenario the
// rows of its last statement, or the first error message.
import { PGlite } from '@electric-sql/pglite';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const job = await readStdin();
const pg = new PGlite();
try {
  for (const script of job.setup) await pg.exec(script);
  const results = {};
  for (const [name, statements] of Object.entries(job.scenarios)) {
    await pg.query('BEGIN');
    try {
      let rows = [];
      for (const statement of statements) {
        rows = (await pg.query(statement)).rows;
      }
      results[name] = { rows };
    } catch (error) {
      results[name] = {
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await pg.query('ROLLBACK');
    }
  }
  process.stdout.write(JSON.stringify(results));
} finally {
  await pg.close();
}

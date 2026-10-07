import { main } from '../../push-secrets.ts';
import { TARGET } from './fixtures.ts';

// push-secrets.ts exactly as the operator runs it, except that the database URLs are checked
// against the fixtures' fake production project instead of packages/db/production-target.json.
// There is no flag or variable for this: only a test entry point can swap the target.

process.exit(await main({ argv: process.argv.slice(2), target: TARGET }));

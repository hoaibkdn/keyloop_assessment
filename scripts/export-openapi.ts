// Writes docs/openapi.json from the live route schemas, so the spec can never drift from the code.
import { writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db/pool.js';

const pool = createPool('postgres://unused@localhost/unused'); // pg connects lazily; never used here
const app = await buildApp({ pool, logger: false });
await app.ready();
await writeFile('docs/openapi.json', JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close();
await pool.end();
console.log('wrote docs/openapi.json');

import pg from 'pg';
import { runMigrations } from '../store/migrations';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL, e.g. postgres://localhost:5432/bi');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url });
try {
  const applied = await runMigrations(pool);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'schema is up to date');
} finally {
  await pool.end();
}

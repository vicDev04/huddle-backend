import pg from 'pg';
export async function setup() {
  const url = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/huddle_test';
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('drop schema public cascade; create schema public;');
  await c.end();
  process.env.DATABASE_URL = url;
  const { migrate } = await import('../src/migrate.js');
  const { pool } = await import('../src/db.js');
  await migrate(() => {});
  await pool.end();
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(log = console.log) {
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock(777)');
    await c.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await c.query('select name from schema_migrations')).rows.map((r) => r.name));
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('begin');
      try {
        await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await c.query('insert into schema_migrations (name) values ($1)', [f]);
        await c.query('commit');
        log(`migrated ${f}`);
      } catch (e) {
        await c.query('rollback');
        throw new Error(`migration ${f} failed: ${e.message}`);
      }
    }
  } finally {
    await c.query('select pg_advisory_unlock(777)').catch(() => {});
    c.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}

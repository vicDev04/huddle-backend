import pg from 'pg';

pg.types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD' string, no TZ shifting

const ssl = process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined;
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 10 });

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

import { buildApp } from './app.js';
import { migrate } from './migrate.js';
import { startJobs } from './jobs.js';

await migrate();
const app = await buildApp({ logger: true });
const { pool } = await import('./db.js');
const admin = (await pool.query("select is_admin from users where username = 'Huddle'")).rows[0];
if (!admin) app.log.warn('Admin account "Huddle" not found');
else if (!admin.is_admin) app.log.warn('Account "Huddle" exists but is not admin (it was created after migration 003)');
else app.log.info('Admin account "Huddle" found');
if (process.env.DISABLE_JOBS !== 'true') startJobs(app.log);
await app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });

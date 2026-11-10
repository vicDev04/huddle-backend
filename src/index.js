import { buildApp } from './app.js';
import { migrate } from './migrate.js';
import { startJobs } from './jobs.js';

await migrate();
const app = await buildApp({ logger: true });
if (process.env.DISABLE_JOBS !== 'true') startJobs(app.log);
await app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });

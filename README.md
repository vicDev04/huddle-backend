# Huddle backend

REST API for Huddle (Fastify + PostgreSQL). All routes are under `/api`.

## Run locally

```bash
npm install
cp .env.example .env        # then edit it
createdb huddle
export $(cat .env | xargs)
npm start                   # runs migrations, then starts the API on $PORT
```

`GET /api/health` should return `{"ok":true}`.

## Environment variables

| Name | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `JWT_SECRET` | yes in production | Long random string |
| `FRONTEND_ORIGINS` | yes | Comma-separated, exact strings (e.g. `capacitor://localhost`) |
| `GAME_TZ` | no | Default `Europe/Lisbon` |
| `PORT` | no | Railway sets it |
| `PGSSL` | no | `true` if your DB needs SSL (Railway's public URL). Not needed for the private URL |
| `DISABLE_JOBS` | no | `true` to turn off the in-process cron jobs |

## Migrations and seed

`migrations/*.sql` run in order on every start (`npm start`), or manually with `npm run migrate`. Each file runs once, tracked in `schema_migrations`.

- `001_init.sql`: schema.
- `002_seed_pt.sql`: Portuguese (pt-PT) Hive Mind questions and Hot Seat prompts. Idempotent: deactivates any other global questions/prompts and only inserts missing texts.

New schema changes go in a new numbered file. Don't edit old ones.

## Jobs (in-process, `GAME_TZ`)

- 00:05 daily: settle yesterday's unsettled Hive questions.
- 00:15 on the 1st: season close, awarding crew and global podium rewards.

Both are idempotent. Run only one API replica, or set `DISABLE_JOBS=true` on extra replicas.

## Tests

```bash
createdb huddle_test
TEST_DATABASE_URL=postgres://postgres@localhost:5432/huddle_test npm test
```

The test DB is wiped on every run.

## Deploy on Railway

1. Push this folder to a GitHub repo.
2. In the Railway project: **New → GitHub Repo →** pick the repo.
3. On the new service, open **Variables** and add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `JWT_SECRET` = a long random string
   - `FRONTEND_ORIGINS` = `http://localhost:5500,http://127.0.0.1:5500,https://localhost,capacitor://localhost` plus your web frontend origin, if any
   - `GAME_TZ` = `Europe/Lisbon`
4. Go to **Settings → Networking → Generate Domain**. Your base URL is `https://<domain>/api`.
5. Check it:
   ```bash
   curl https://<domain>/api/health
   curl -i -X OPTIONS -H "Origin: capacitor://localhost" -H "Access-Control-Request-Method: POST" \
     -H "Access-Control-Request-Headers: content-type" https://<domain>/api/auth/login
   ```
   The second command must return `access-control-allow-origin: capacitor://localhost`.

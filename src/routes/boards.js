import { pool } from '../db.js';
import { bad } from '../errors.js';
import { assertMember } from './groups.js';
import { loadUsers } from '../users.js';
import { today, seasonOf, daysLeft, SEASON_RE } from '../time.js';

const cache = new Map(); // season -> { at, rows }
export const clearGlobalCache = () => cache.clear();

function rank(rows) { // rows sorted desc by points; standard competition ranking
  let prev = null, r = 0;
  return rows.map((row, i) => { if (row.points !== prev) { r = i + 1; prev = row.points; } return { ...row, rank: r }; });
}
function seasonParam(req) {
  const s = req.query.season || seasonOf(today());
  if (!SEASON_RE.test(s)) throw bad('INVALID_SEASON', 'season must be YYYY-MM');
  return s;
}
const left = (season) => (season === seasonOf(today()) ? daysLeft(today()) : 0);

export async function groupPoints(db, groupId, season) {
  const { rows } = await db.query(
    `with pts as (
       select user_id, sum(amount)::int p, max(created_at) t from points_ledger
       where season = $1 and (group_id = $2 or source = 'mini_game') group by user_id)
     select m.user_id, coalesce(pts.p, 0) as points, pts.t from group_members m
     left join pts on pts.user_id = m.user_id where m.group_id = $2
     order by points desc, pts.t asc nulls last, m.joined_at`, [season, groupId]);
  return rank(rows.map((r) => ({ userId: r.user_id, points: r.points })));
}

export async function globalPoints(db, season, limit = 100) {
  const { rows } = await db.query(
    `select user_id, sum(amount)::int points, max(created_at) t from points_ledger
     where season = $1 and source = 'mini_game' group by user_id order by points desc, t asc limit $2`, [season, limit]);
  return rank(rows.map((r) => ({ userId: r.user_id, points: r.points })));
}

export default async function (app) {
  app.addHook('preHandler', app.auth);

  app.get('/leaderboards/group/:id', async (req) => {
    const season = seasonParam(req);
    await assertMember(pool, req.params.id, req.userId);
    const rows = await groupPoints(pool, req.params.id, season);
    const users = await loadUsers(pool, rows.map((r) => r.userId));
    return {
      season, daysLeft: left(season),
      rows: rows.map((r) => ({ rank: r.rank, user: users.get(r.userId), points: r.points, isMe: r.userId === req.userId })),
    };
  });

  app.get('/leaderboards/global', async (req) => {
    const season = seasonParam(req);
    let hit = cache.get(season);
    if (!hit || Date.now() - hit.at > 60000) {
      const rows = await globalPoints(pool, season);
      const users = await loadUsers(pool, rows.map((r) => r.userId));
      hit = { at: Date.now(), rows: rows.map((r) => ({ rank: r.rank, user: users.get(r.userId), points: r.points })) };
      cache.set(season, hit);
    }
    const out = hit.rows.map((r) => ({ ...r, isMe: r.user.id === req.userId }));
    if (!out.some((r) => r.isMe)) {
      const me = (await pool.query(
        `with t as (select user_id, sum(amount)::int p from points_ledger where season=$1 and source='mini_game' group by user_id)
         select coalesce((select p from t where user_id=$2), 0) as p,
                (select count(*)::int from t where p > coalesce((select p from t where user_id=$2), 0)) as above`, [season, req.userId])).rows[0];
      const users = await loadUsers(pool, [req.userId]);
      out.push({ rank: me.above + 1, user: users.get(req.userId), points: me.p, isMe: true });
    }
    return { season, daysLeft: left(season), rows: out };
  });
}

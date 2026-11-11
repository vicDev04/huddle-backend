import { pool } from '../db.js';
import { ApiError, bad } from '../errors.js';
import * as v from '../validate.js';
import { today, seasonOf } from '../time.js';
import { loadUser } from '../users.js';
import { streakFor } from '../game.js';
import { computeMetrics, listAchievements } from '../achievements.js';

const hidden = () => new ApiError(404, 'PROFILE_HIDDEN', 'Profiles are only visible for people in your crews.');

export default async function (app) {
  app.addHook('preHandler', app.auth);

  app.get('/me/achievements', async (req) => ({ items: await listAchievements(req.userId) }));

  app.get('/users/:id/profile', async (req) => {
    const id = req.params.id;
    const groupId = req.query.groupId;
    if (groupId !== undefined && (typeof groupId !== 'string' || !v.UUID_RE.test(groupId))) throw bad('VALIDATION_ERROR', 'groupId must be a crew id');
    if (!v.UUID_RE.test(id)) throw hidden();
    const target = (await pool.query('select is_admin from users where id = $1', [id])).rows[0];
    if (!target) throw hidden();
    const crews = (await pool.query(
      `select g.id, g.name from groups g
       join group_members a on a.group_id = g.id and a.user_id = $1
       join group_members b on b.group_id = g.id and b.user_id = $2
       order by g.created_at`, [id, req.userId])).rows;
    if (id !== req.userId && !crews.length) {
      const me = (await pool.query('select is_admin from users where id = $1', [req.userId])).rows[0];
      if (me?.is_admin !== true) throw hidden();
    }
    const day = today();
    const [user, m, streak, season, achievements, trophies] = await Promise.all([
      loadUser(pool, id),
      computeMetrics(pool, id),
      streakFor(pool, id, day),
      pool.query('select coalesce(sum(amount),0)::int as p from points_ledger where user_id = $1 and season = $2', [id, seasonOf(day)]),
      pool.query('select achievement_id, unlocked_at from user_achievements where user_id = $1 order by unlocked_at desc, achievement_id', [id]),
      pool.query(
        `select r.season, r.scope, r.rank, r.title, g.name as group_name
         from season_rewards r left join groups g on g.id = r.group_id
         where r.user_id = $1 order by r.season desc, r.rank, r.created_at desc`, [id]),
    ]);
    return {
      user: { ...user, isAdmin: target.is_admin === true },
      stats: {
        streak, bestStreak: m.bestStreak, seasonPoints: season.rows[0].p,
        gamesPlayed: m.gamesPlayed, hiveReads: m.hiveReads, crowned: m.crowned,
      },
      achievements: achievements.rows.map((r) => ({ id: r.achievement_id, unlockedAt: r.unlocked_at })),
      trophies: trophies.rows.map((r) => ({
        season: r.season, scope: r.scope, rank: r.rank, title: r.title, groupName: r.scope === 'global' ? null : r.group_name,
      })),
      crews: crews.map((c) => ({ id: c.id, name: c.name })),
    };
  });
}

import { pool, tx } from './db.js';
import { addDays } from './time.js';

// The authority for achievements. The app only has a display copy.
export const ACHIEVEMENTS = [
  { id: 'first_steps', target: 1, coins: 20, title: null, metric: 'daysPlayed' },
  { id: 'streak_3', target: 3, coins: 30, title: null, metric: 'bestStreak' },
  { id: 'streak_7', target: 7, coins: 80, title: 'title_onfire', metric: 'bestStreak' },
  { id: 'streak_30', target: 30, coins: 300, title: 'title_unstoppable', metric: 'bestStreak' },
  { id: 'perfect_game', target: 1, coins: 100, title: 'title_flawless', metric: 'perfectGames' },
  { id: 'games_10', target: 10, coins: 50, title: null, metric: 'gamesPlayed' },
  { id: 'all_games', target: 8, coins: 150, title: 'title_gamemaster', metric: 'distinctGames' },
  { id: 'hive_reader', target: 10, coins: 80, title: 'title_mindreader', metric: 'hiveReads' },
  { id: 'hive_star', target: 5, coins: 60, title: null, metric: 'hiveStar' },
  { id: 'crowned_3', target: 3, coins: 100, title: 'title_roastchamp', metric: 'crowned' },
  { id: 'all_rounder', target: 5, coins: 80, title: 'title_allrounder', metric: 'allRounderDays' },
  { id: 'podium', target: 1, coins: 150, title: 'title_podium', metric: 'podiums' },
  { id: 'team_player', target: 3, coins: 120, title: 'title_teamplayer', metric: 'challengeClaims' },
  { id: 'crew_hopper', target: 3, coins: 40, title: null, metric: 'crews' },
];

export function longestRun(sortedDays) {
  let best = 0, run = 0, prev = null;
  for (const d of sortedDays) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return best;
}

// All-time metrics for one user.
export async function computeMetrics(db, userId) {
  const days = (await db.query('select distinct day from points_ledger where user_id = $1 order by day', [userId])).rows.map((r) => r.day);
  const r = (await db.query(
    `select
       (select count(*)::int from mini_game_plays where user_id = $1 and points = 100) as "perfectGames",
       (select count(*)::int from mini_game_plays where user_id = $1) as "gamesPlayed",
       (select count(distinct game_key)::int from mini_game_plays where user_id = $1) as "distinctGames",
       (select count(*)::int from points_ledger where user_id = $1 and source = 'hive' and amount = 13) as "hiveReads",
       (select count(*)::int from hive_results where $1 = any(majority_user_ids)) as "hiveStar",
       (select count(*)::int from points_ledger where user_id = $1 and source = 'hot_seat_crowned') as "crowned",
       (select count(*)::int from (
          select day from points_ledger where user_id = $1 group by day
          having count(*) filter (where source = 'hive') >= 3
             and count(*) filter (where source in ('hot_seat','hot_seat_judge')) >= 1
             and count(*) filter (where source = 'mini_game') >= 1) x) as "allRounderDays",
       (select count(*)::int from season_rewards where user_id = $1) as "podiums",
       (select count(*)::int from crew_challenge_claims where user_id = $1) as "challengeClaims",
       (select count(*)::int from group_members where user_id = $1) as "crews"`, [userId])).rows[0];
  return { ...r, daysPlayed: days.length, bestStreak: longestRun(days) };
}

// Unlocks every achievement the user's history earns. Rewards are paid exactly once, on insert.
export async function syncAchievements(userId, db = pool) {
  const m = await computeMetrics(db, userId);
  const have = new Set((await db.query('select achievement_id from user_achievements where user_id = $1', [userId])).rows.map((r) => r.achievement_id));
  const due = ACHIEVEMENTS.filter((a) => !have.has(a.id) && m[a.metric] >= a.target);
  if (!due.length) return m;
  await tx(async (c) => {
    for (const a of due) {
      const ins = await c.query(
        'insert into user_achievements (user_id, achievement_id) values ($1,$2) on conflict do nothing returning 1', [userId, a.id]);
      if (!ins.rowCount) continue;
      if (a.coins) await c.query('update users set coins = coins + $2 where id = $1', [userId, a.coins]);
      if (a.title) {
        await c.query(`insert into user_items (user_id, item_id, source) values ($1,$2,'achievement') on conflict do nothing`, [userId, a.title]);
      }
    }
  });
  return m;
}

// Never lets a sync failure break the action that triggered it.
export async function safeSync(log, ...userIds) {
  for (const id of new Set(userIds.filter(Boolean))) {
    try { await syncAchievements(id); } catch (e) { log?.error?.({ err: e, userId: id }, 'syncAchievements failed'); }
  }
}

export async function listAchievements(userId) {
  const m = await syncAchievements(userId);
  const at = new Map((await pool.query('select achievement_id, unlocked_at from user_achievements where user_id = $1', [userId])).rows
    .map((r) => [r.achievement_id, r.unlocked_at]));
  return ACHIEVEMENTS.map((a) => ({
    id: a.id, progress: Math.min(a.target, m[a.metric]), target: a.target, unlockedAt: at.get(a.id) || null,
  }));
}

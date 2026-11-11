import cron from 'node-cron';
import { pool, tx } from './db.js';
import { settleQuestion } from './game.js';
import { addDays, today, seasonOf, prevSeason, TZ } from './time.js';
import { groupPoints, globalPoints, clearGlobalCache } from './routes/boards.js';
import { SEASON_TITLES } from './items.js';

export async function nightlyClose(day = addDays(today(), -1)) {
  const rounds = (await pool.query('select group_id, hive_question_ids from daily_rounds where day = $1', [day])).rows;
  let settled = 0;
  for (const r of rounds) {
    for (const q of r.hive_question_ids) {
      if (await tx((c) => settleQuestion(c, r.group_id, day, q))) settled++;
    }
  }
  return settled;
}

const GROUP_TITLES = { 1: ['Crew Captain', 'deck_writer'], 2: ['First Mate', null], 3: ['Deckhand', null] };
const GLOBAL_TITLES = { 1: 'Global Legend', 2: 'Global Ace', 3: 'Global Contender' };

async function award(c, { season, scope, groupId, userId, rank, title, perk }) {
  // "where not exists" because the unique constraint treats NULL group_id (global) as distinct
  await c.query(
    `insert into season_rewards (season, scope, group_id, user_id, rank, title, perk)
     select $1::char(7),$2::varchar,$3::uuid,$4::uuid,$5::smallint,$6::varchar,$7::varchar where not exists (
       select 1 from season_rewards where season=$1::char(7) and scope=$2::varchar and group_id is not distinct from $3::uuid and user_id=$4::uuid)
     on conflict do nothing`, [season, scope, groupId, userId, rank, title, perk]);
  await c.query(`insert into user_items (user_id, item_id, source) values ($1,$2,'season') on conflict do nothing`,
    [userId, SEASON_TITLES[scope][rank]]);
}

export async function seasonClose(season = prevSeason(seasonOf(today()))) {
  return tx(async (c) => {
    await c.query('select pg_advisory_xact_lock(4242)');
    const groups = (await c.query(
      'select group_id from group_members group by group_id having count(*) >= 3')).rows.map((r) => r.group_id);
    for (const gid of groups) {
      const rows = (await groupPoints(c, gid, season)).filter((r) => r.points > 0 && r.rank <= 3);
      for (const r of rows) {
        const [title, perk] = GROUP_TITLES[r.rank];
        await award(c, { season, scope: 'group', groupId: gid, userId: r.userId, rank: r.rank, title, perk });
      }
    }
    const top = (await globalPoints(c, season, 50)).filter((r) => r.points > 0 && r.rank <= 3);
    for (const r of top) await award(c, { season, scope: 'global', groupId: null, userId: r.userId, rank: r.rank, title: GLOBAL_TITLES[r.rank], perk: null });
    clearGlobalCache();
  });
}

export function startJobs(log = console) {
  cron.schedule('5 0 * * *', () => nightlyClose().then((n) => log.info?.(`nightly close settled ${n}`)).catch((e) => log.error?.(e)), { timezone: TZ });
  cron.schedule('15 0 1 * *', () => seasonClose().then(() => log.info?.('season closed')).catch((e) => log.error?.(e)), { timezone: TZ });
}

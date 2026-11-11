import { addDays, dayIndex } from './time.js';
import { loadUsers } from './users.js';

export const CHALLENGE_TYPES = {
  show_up: {
    name: 'Show Up', unit: 'check-ins',
    description: 'Check in as a crew: {target} check-ins this week. Each person counts up to 5 days.',
    target: (m) => 4 * m,
    amount: (rows) => Math.min(5, new Set(rows.map((r) => r.day)).size),
  },
  hive_reads: {
    name: 'Read the Hive', unit: 'right guesses',
    description: "Guess the crew's top pick right {target} times this week.",
    target: (m) => 3 * m,
    amount: (rows) => rows.filter((r) => r.source === 'hive' && r.amount === 13).length,
  },
  arcade: {
    name: 'Arcade Week', unit: 'games',
    description: 'Play {target} daily games as a crew this week.',
    target: (m) => 5 * m,
    amount: (rows) => rows.filter((r) => r.source === 'mini_game').length,
  },
  roast: {
    name: 'Roast Week', unit: 'answers',
    description: 'Write {target} Hot Seat answers as a crew this week.',
    target: (m) => 5 * (m - 1),
    amount: (rows) => rows.filter((r) => r.source === 'hot_seat').length,
  },
};
const TYPES = ['show_up', 'hive_reads', 'arcade', 'roast'];
export const REWARD_COINS = 50;

// Monday of the week containing `day` (1970-01-01 was a Thursday).
export const mondayOf = (day) => addDays(day, -(((dayIndex(day) + 3) % 7) + 7) % 7);
export const challengeType = (monday) => TYPES[Math.floor(dayIndex(monday) / 7) % 4];

// Returns the challenge view for a crew, or null for crews with fewer than 2 members.
export async function buildChallenge(db, groupId, userId, day) {
  const members = (await db.query('select user_id from group_members where group_id = $1 order by joined_at', [groupId])).rows.map((r) => r.user_id);
  if (members.length < 2) return null;
  const week = mondayOf(day);
  const sunday = addDays(week, 6);
  const id = challengeType(week);
  const t = CHALLENGE_TYPES[id];
  const rows = (await db.query(
    `select user_id, day, source, amount from points_ledger
     where user_id = any($1::uuid[]) and day between $2 and $3 and (group_id = $4 or source = 'mini_game')`,
    [members, week, sunday, groupId])).rows;
  const users = await loadUsers(db, members);
  const contributions = members.map((uid) => ({ user: users.get(uid), amount: t.amount(rows.filter((r) => r.user_id === uid)) }))
    .sort((a, b) => b.amount - a.amount);
  const total = contributions.reduce((s, c) => s + c.amount, 0);
  const target = t.target(members.length);
  const claimed = (await db.query(
    'select 1 from crew_challenge_claims where group_id = $1 and week_start = $2 and user_id = $3', [groupId, week, userId])).rowCount > 0;
  return {
    id, week, name: t.name, description: t.description.replace('{target}', String(target)), unit: t.unit,
    progress: Math.min(total, target), target, completed: total >= target, claimed,
    eligible: rows.some((r) => r.user_id === userId),
    rewardCoins: REWARD_COINS, endsOn: sunday, daysLeft: dayIndex(sunday) - dayIndex(day) + 1,
    contributions,
  };
}

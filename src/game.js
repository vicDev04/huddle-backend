import { pool, tx } from './db.js';
import { addDays, dayIndex } from './time.js';
import { addPoints } from './ledger.js';
import { loadUsers } from './users.js';

export const MINI_GAMES = {
  reaction: { name: 'Reflex Run', tagline: 'Five rounds. Tap the instant the pad turns green.' },
  pattern: { name: 'Echo Grid', tagline: 'Repeat the glowing pattern. It grows every round.' },
  maths: { name: 'Brain Sprint', tagline: '30 seconds of quick sums. Wrong taps cost points.' },
  stroop: { name: 'Ink Trap', tagline: 'Tap the colour of the ink, not the word.' },
  scramble: { name: 'Word Shuffle', tagline: '45 seconds. Unscramble as many words as you can.' },
  memory: { name: 'Pair Up', tagline: 'Find all eight pairs in as few flips as possible.' },
  highlow: { name: 'Higher or Lower', tagline: '30 seconds. Will the next number be higher or lower?' },
  spotter: { name: 'Odd Tile', tagline: '30 seconds. Tap the tile that is a slightly different shade.' },
};
const KEYS = ['reaction', 'pattern', 'maths', 'stroop', 'scramble', 'memory', 'highlow', 'spotter'];
export const miniKey = (day) => KEYS[((dayIndex(day) % KEYS.length) + KEYS.length) % KEYS.length];

export const PACKS = ['classic', 'spicy', 'office', 'family', 'couples'];
// Pack in force on game day `day` for a groups row.
export const packInForce = (g, day) => (g.pack_from == null || day >= g.pack_from ? g.pack : g.pack_prev || g.pack);

const seq = async (fns) => { const out = []; for (const f of fns) out.push(await f()); return out; };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const selectRound = async (db, groupId, day, lock = false) =>
  (await db.query(`select * from daily_rounds where group_id = $1 and day = $2 ${lock ? 'for update' : ''}`, [groupId, day])).rows[0];

export async function ensureRound(groupId, day) {
  const existing = await selectRound(pool, groupId, day);
  if (existing) return existing;
  return tx(async (c) => {
    const again = await selectRound(c, groupId, day);
    if (again) return again;
    const members = (await c.query('select user_id from group_members where group_id = $1 order by joined_at', [groupId])).rows.map((r) => r.user_id);

    const g = (await c.query('select pack, pack_prev, pack_from from groups where id = $1', [groupId])).rows[0];
    const pack = packInForce(g, day);

    const seen = (await c.query(
      `select distinct unnest(hive_question_ids) as id from daily_rounds where group_id = $1 and day > $2`, [groupId, addDays(day, -45)]
    )).rows.map((r) => r.id);
    const qids = [];
    const custom = (await c.query(
      `select id from hive_questions where group_id = $1 and scheduled_day = $2 and is_active order by id limit 1`, [groupId, day]
    )).rows[0];
    if (custom) qids.push(custom.id);
    const fresh = (await c.query(
      `select id from hive_questions where group_id is null and is_active and pack = $3 and not (id = any($1::int[])) order by random() limit $2`,
      [[...seen, ...qids], 3 - qids.length, pack]
    )).rows.map((r) => r.id);
    qids.push(...fresh);
    if (qids.length < 3) { // pack running low: least-recently-used questions in the pack (never shown first, then oldest)
      const more = (await c.query(
        `select q.id from hive_questions q
           left join (select x.id, max(r.day) as d from daily_rounds r, unnest(r.hive_question_ids) as x(id)
                      where r.group_id = $1 group by x.id) u on u.id = q.id
         where q.group_id is null and q.is_active and q.pack = $2 and not (q.id = any($3::int[]))
         order by u.d nulls first, random() limit $4`,
        [groupId, pack, qids, 3 - qids.length]
      )).rows.map((r) => r.id);
      qids.push(...more);
    }

    const last = new Map((await c.query(
      `select hot_seat_subject_id as id, max(day) as d from daily_rounds where group_id = $1 group by 1`, [groupId]
    )).rows.map((r) => [r.id, r.d]));
    const subject = shuffle([...members]).sort((a, b) => (last.get(a) || '').localeCompare(last.get(b) || ''))[0];

    let prompt = (await c.query(
      `select id from hot_seat_prompts where is_active and pack = $3 and id not in
         (select hot_seat_prompt_id from daily_rounds where group_id = $1 and day > $2) order by random() limit 1`,
      [groupId, addDays(day, -20), pack]
    )).rows[0];
    if (!prompt) {
      prompt = (await c.query(
        `select p.id from hot_seat_prompts p
           left join (select hot_seat_prompt_id as id, max(day) as d from daily_rounds where group_id = $1 group by 1) u on u.id = p.id
         where p.is_active and p.pack = $2 order by u.d nulls first, random() limit 1`, [groupId, pack]
      )).rows[0];
    }
    if (!prompt) prompt = (await c.query('select id from hot_seat_prompts where is_active order by random() limit 1')).rows[0];

    await c.query(
      `insert into daily_rounds (group_id, day, member_ids, hive_question_ids, hot_seat_subject_id, hot_seat_prompt_id)
       values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
      [groupId, day, members, qids, subject, prompt.id]
    );
    return selectRound(c, groupId, day);
  });
}
export const lockRound = (c, groupId, day) => selectRound(c, groupId, day, true);

// Settle a hive question with whatever votes exist. Idempotent.
export async function settleQuestion(c, groupId, day, qid) {
  const votes = (await c.query('select * from hive_votes where group_id=$1 and day=$2 and question_id=$3', [groupId, day, qid])).rows;
  if (!votes.length) return false;
  const counts = new Map();
  for (const v of votes) counts.set(v.voted_user_id, (counts.get(v.voted_user_id) || 0) + 1);
  const top = Math.max(...counts.values());
  const majority = [...counts].filter(([, n]) => n === top).map(([id]) => id);
  const ins = await c.query(
    `insert into hive_results (group_id, day, question_id, majority_user_ids) values ($1,$2,$3,$4) on conflict do nothing returning 1`,
    [groupId, day, qid, majority]
  );
  if (!ins.rowCount) return false;
  for (const v of votes) {
    await addPoints(c, { userId: v.voter_id, groupId, day, source: 'hive', amount: 3 + (majority.includes(v.predicted_user_id) ? 10 : 0), ref: qid });
  }
  return true;
}

export async function buildHiveItem(db, round, qid, userId, users) {
  const [q, votes, res, pts] = await seq([
    () => db.query('select id, text, group_id from hive_questions where id = $1', [qid]),
    () => db.query('select voter_id, voted_user_id, predicted_user_id from hive_votes where group_id=$1 and day=$2 and question_id=$3', [round.group_id, round.day, qid]),
    () => db.query('select majority_user_ids from hive_results where group_id=$1 and day=$2 and question_id=$3', [round.group_id, round.day, qid]),
    () => db.query(`select coalesce(sum(amount),0)::int as p from points_ledger where user_id=$1 and group_id=$2 and day=$3 and source='hive' and ref=$4`,
      [userId, round.group_id, round.day, String(qid)]),
  ]);
  const question = q.rows[0];
  const mine = votes.rows.find((v) => v.voter_id === userId);
  let result = null;
  if (mine && res.rows[0]) {
    const counts = new Map();
    for (const v of votes.rows) counts.set(v.voted_user_id, (counts.get(v.voted_user_id) || 0) + 1);
    const majorityIds = res.rows[0].majority_user_ids;
    result = {
      tally: [...counts].sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ user: users.get(id) || null, count })),
      majorityIds,
      predictedRight: majorityIds.includes(mine.predicted_user_id),
      pointsEarned: pts.rows[0].p,
    };
  }
  return {
    id: String(question.id), text: question.text, custom: question.group_id != null,
    answered: !!mine, myVote: mine?.voted_user_id || null, myPrediction: mine?.predicted_user_id || null,
    votedCount: votes.rows.length, memberCount: round.member_ids.length, result,
  };
}

export async function buildHotSeat(db, round, userId, users) {
  const [prompt, answers, fav] = await seq([
    () => db.query('select text from hot_seat_prompts where id = $1', [round.hot_seat_prompt_id]),
    () => db.query('select id, author_id, text from hot_seat_answers where group_id=$1 and day=$2 order by created_at, id', [round.group_id, round.day]),
    () => db.query('select answer_id from hot_seat_favorites where group_id=$1 and day=$2', [round.group_id, round.day]),
  ]);
  const subject = users.get(round.hot_seat_subject_id);
  const isSubject = userId === round.hot_seat_subject_id;
  const favoriteId = fav.rows[0]?.answer_id || null;
  const mine = answers.rows.find((a) => a.author_id === userId);
  const canSee = isSubject || !!mine;
  let favAuthor = null;
  if (favoriteId) {
    const a = answers.rows.find((x) => x.id === favoriteId);
    favAuthor = users.get(a.author_id) || (await loadUsers(db, [a.author_id])).get(a.author_id) || null;
  }
  return {
    subject,
    prompt: prompt.rows[0].text.replaceAll('{name}', subject?.displayName || ''),
    isSubject,
    myAnswer: mine?.text || null,
    answerCount: answers.rows.length,
    answers: canSee ? answers.rows.map((a) => ({
      id: a.id, text: a.text, isMine: a.author_id === userId, isFavorite: a.id === favoriteId,
      author: a.id === favoriteId ? favAuthor : null,
    })) : [],
    favoriteId,
    canPick: isSubject && !favoriteId && answers.rows.length > 0,
  };
}

export async function roundUsers(db, round) {
  return loadUsers(db, [...round.member_ids, round.hot_seat_subject_id]);
}

export async function miniGameFor(db, userId, day) {
  const key = miniKey(day);
  const play = (await db.query('select points from mini_game_plays where user_id=$1 and day=$2', [userId, day])).rows[0];
  return { key, ...MINI_GAMES[key], date: day, seed: 'mini:' + day, played: !!play, points: play ? play.points : null };
}

export async function streakFor(db, userId, day) {
  const days = new Set((await db.query(
    'select distinct day from points_ledger where user_id=$1 and day <= $2 and day > $3', [userId, day, addDays(day, -400)]
  )).rows.map((r) => r.day));
  let d = days.has(day) ? day : addDays(day, -1);
  let n = 0;
  while (days.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

export function scoreMini(key, raw) {
  const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let p;
  if (key === 'reaction') {
    if (typeof raw.avgMs !== 'number' || !Number.isFinite(raw.avgMs) || raw.avgMs < 0 || raw.avgMs > 60000) return null;
    p = raw.avgMs < 120 ? 0 : (600 - raw.avgMs) / 4;
  } else if (key === 'pattern') {
    if (!isInt(raw.level, 0, 25)) return null;
    p = raw.level * 8;
  } else if (key === 'maths' || key === 'stroop') {
    if (!isInt(raw.correct, 0, 60) || !isInt(raw.wrong, 0, 1000)) return null;
    p = raw.correct * (key === 'maths' ? 7 : 5) - raw.wrong * 3;
  } else if (key === 'scramble') {
    if (!isInt(raw.solved, 0, 20) || !isInt(raw.skipped, 0, 60)) return null;
    p = raw.solved * 11 - raw.skipped * 2;
  } else if (key === 'memory') {
    if (!isInt(raw.moves, 0, 200) || !isInt(raw.ms, 0, 3600000)) return null;
    p = raw.moves < 8 || raw.ms < 3000 ? 0 : 100 - (raw.moves - 8) * 5 - Math.max(0, raw.ms / 1000 - 25);
  } else if (key === 'highlow') {
    if (!isInt(raw.correct, 0, 60) || !isInt(raw.wrong, 0, 1000)) return null;
    p = raw.correct * 5 - raw.wrong * 5;
  } else if (key === 'spotter') {
    if (!isInt(raw.correct, 0, 80) || !isInt(raw.wrong, 0, 1000)) return null;
    p = raw.correct * 6 - raw.wrong * 4;
  } else return null;
  return Math.round(Math.min(100, Math.max(0, p)));
}

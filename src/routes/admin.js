import { pool, tx } from '../db.js';
import { ApiError, bad, notFound } from '../errors.js';
import * as v from '../validate.js';
import { today } from '../time.js';

const TABLES = { hive: 'hive_questions', hot_seat: 'hot_seat_prompts' };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL_G = /[\u0000-\u001f\u007f-\u009f]/g;

function tableFor(type) {
  if (!Object.hasOwn(TABLES, type)) throw bad('INVALID_TYPE', 'type must be hive or hot_seat');
  return TABLES[type];
}

function cleanQuestion(type, raw) {
  if (typeof raw !== 'string') throw bad('VALIDATION_ERROR', 'text is required');
  const s = raw.replace(CONTROL_G, '').trim();
  if (s.length < 8 || s.length > 140) throw bad('INVALID_TEXT', 'text must be 8-140 characters');
  if (type === 'hot_seat' && !s.includes('{name}')) throw bad('MISSING_NAME_PLACEHOLDER', 'Hot Seat prompts must contain {name}');
  return s;
}

async function assertNotDuplicate(db, table, text, exceptId = null) {
  const { rowCount } = await db.query(
    `select 1 from ${table} where lower(text) = lower($1) and ($2::int is null or id <> $2)`, [text, exceptId]);
  if (rowCount) throw new ApiError(409, 'DUPLICATE', 'That question already exists');
}

async function loadItem(db, type, id) {
  const sql = type === 'hive'
    ? `select q.id, q.text, q.is_active, q.group_id, g.name as crew_name
       from hive_questions q left join groups g on g.id = q.group_id where q.id = $1`
    : 'select id, text, is_active, null::uuid as group_id, null::text as crew_name from hot_seat_prompts where id = $1';
  const row = (await db.query(sql, [id])).rows[0];
  return row ? toItem(row) : null;
}

const toItem = (r) => ({
  id: r.id, text: r.text, isActive: r.is_active,
  scope: r.group_id ? 'crew' : 'global', crewName: r.group_id ? r.crew_name : null,
});

export default async function (app) {
  app.addHook('preHandler', app.auth);
  // Checked against the DB on every request, so removing the flag takes effect immediately.
  app.addHook('preHandler', async (req) => {
    const { rows } = await pool.query('select is_admin from users where id = $1', [req.userId]);
    if (rows[0]?.is_admin !== true) throw new ApiError(403, 'FORBIDDEN', 'Admins only');
  });

  app.get('/stats', async () => {
    const day = today();
    const { rows } = await pool.query(
      `select
         (select count(*)::int from users) as users,
         (select count(*)::int from groups) as crews,
         (select count(distinct user_id)::int from points_ledger where day = $1) as "activeToday",
         (select count(*)::int from hive_votes where day = $1) as "hiveVotesToday",
         (select count(*)::int from hot_seat_answers where day = $1) as "hotSeatAnswersToday",
         (select count(*)::int from mini_game_plays where day = $1) as "miniGamePlaysToday",
         (select count(*)::int from hive_questions where is_active and group_id is null) as "hiveQuestionsActive",
         (select count(*)::int from hot_seat_prompts where is_active) as "hotSeatPromptsActive"`, [day]);
    return rows[0];
  });

  app.get('/questions', async (req) => {
    const type = req.query.type;
    tableFor(type);
    const sql = type === 'hive'
      ? `select q.id, q.text, q.is_active, q.group_id, g.name as crew_name
         from hive_questions q left join groups g on g.id = q.group_id order by q.is_active desc, q.id desc`
      : `select id, text, is_active, null::uuid as group_id, null::text as crew_name
         from hot_seat_prompts order by is_active desc, id desc`;
    return { items: (await pool.query(sql)).rows.map(toItem) };
  });

  app.post('/questions', async (req, reply) => {
    const b = v.body(req);
    const table = tableFor(b.type);
    const text = cleanQuestion(b.type, b.text);
    const id = await tx(async (c) => {
      await c.query(`lock table ${table} in share row exclusive mode`);
      await assertNotDuplicate(c, table, text);
      return (await c.query(`insert into ${table} (text, is_active) values ($1, true) returning id`, [text])).rows[0].id;
    });
    reply.code(201);
    return { item: await loadItem(pool, b.type, id) };
  });

  app.post('/questions/:type/:id', async (req) => {
    const { type } = req.params;
    const table = tableFor(type);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) throw notFound('Question not found');
    const b = v.body(req);
    if (b.isActive !== undefined && typeof b.isActive !== 'boolean') throw bad('VALIDATION_ERROR', 'isActive must be a boolean');
    const text = b.text !== undefined ? cleanQuestion(type, b.text) : undefined;
    await tx(async (c) => {
      const row = (await c.query(`select id from ${table} where id = $1 for update`, [id])).rows[0];
      if (!row) throw notFound('Question not found');
      if (text !== undefined) {
        await c.query(`lock table ${table} in share row exclusive mode`);
        await assertNotDuplicate(c, table, text, id);
        await c.query(`update ${table} set text = $2 where id = $1`, [id, text]);
      }
      if (b.isActive !== undefined) await c.query(`update ${table} set is_active = $2 where id = $1`, [id, b.isActive]);
    });
    return { item: await loadItem(pool, type, id) };
  });

  app.get('/hot-seat/answers', async (req) => {
    const day = req.query.day ?? today();
    if (typeof day !== 'string' || !DAY_RE.test(day) || Number.isNaN(Date.parse(day))) throw bad('INVALID_DAY', 'day must be YYYY-MM-DD');
    const { rows } = await pool.query(
      `select a.id, a.text, g.name as crew_name, au.display_name as author_display, au.username as author_username,
              su.display_name as subject_name, (f.answer_id is not null) as is_favorite, a.created_at
       from hot_seat_answers a
       join groups g on g.id = a.group_id
       join users au on au.id = a.author_id
       join daily_rounds r on r.group_id = a.group_id and r.day = a.day
       left join users su on su.id = r.hot_seat_subject_id
       left join hot_seat_favorites f on f.answer_id = a.id
       where a.day = $1
       order by a.created_at desc, a.id desc
       limit 200`, [day]);
    return {
      day,
      items: rows.map((r) => ({
        id: r.id, text: r.text, crewName: r.crew_name,
        authorName: `${r.author_display} (@${r.author_username})`,
        subjectName: r.subject_name, isFavorite: r.is_favorite, createdAt: r.created_at,
      })),
    };
  });

  app.post('/hot-seat/answers/:id/remove', async (req) => {
    const id = req.params.id;
    if (!v.UUID_RE.test(id)) throw notFound('Answer not found');
    await tx(async (c) => {
      const a = (await c.query('select id, group_id, day, author_id from hot_seat_answers where id = $1 for update', [id])).rows[0];
      if (!a) throw notFound('Answer not found');
      const round = (await c.query('select hot_seat_subject_id from daily_rounds where group_id=$1 and day=$2', [a.group_id, a.day])).rows[0];
      const fav = (await c.query('select 1 from hot_seat_favorites where group_id=$1 and day=$2 and answer_id=$3', [a.group_id, a.day, id])).rowCount > 0;
      const removed = [];
      const del = async (userId, source) => removed.push(...(await c.query(
        `delete from points_ledger where user_id=$1 and group_id=$2 and day=$3 and source=$4 returning user_id, amount`,
        [userId, a.group_id, a.day, source])).rows);
      await del(a.author_id, 'hot_seat');
      if (fav) {
        await del(a.author_id, 'hot_seat_crowned');
        if (round) await del(round.hot_seat_subject_id, 'hot_seat_judge');
        await c.query('delete from hot_seat_favorites where group_id=$1 and day=$2 and answer_id=$3', [a.group_id, a.day, id]);
      }
      await c.query('delete from hot_seat_answers where id = $1', [id]);
      // Take back the coins those ledger rows granted (ceil(amount/5) each), never below 0.
      const back = new Map();
      for (const r of removed) if (r.amount > 0) back.set(r.user_id, (back.get(r.user_id) || 0) + Math.ceil(r.amount / 5));
      for (const [uid, n] of back) await c.query('update users set coins = greatest(0, coins - $2) where id = $1', [uid, n]);
    });
    return { ok: true };
  });
}

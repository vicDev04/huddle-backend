import crypto from 'node:crypto';
import { pool, tx } from '../db.js';
import { ApiError, notFound } from '../errors.js';
import { loadUsers } from '../users.js';
import * as v from '../validate.js';
import { addDays, today } from '../time.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const newCode = () => Array.from(crypto.randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
export const MAX_MEMBERS = 12;
export const MAX_GROUPS = 10;

export async function assertMember(db, groupId, userId) {
  if (!v.UUID_RE.test(groupId)) throw notFound('Crew not found');
  const { rowCount } = await db.query('select 1 from group_members where group_id=$1 and user_id=$2', [groupId, userId]);
  if (!rowCount) throw notFound('Crew not found');
}

export async function loadGroups(db, groupIds) {
  if (!groupIds.length) return [];
  const groups = (await db.query('select id, name, invite_code from groups where id = any($1::uuid[]) order by created_at', [groupIds])).rows;
  const members = (await db.query('select group_id, user_id from group_members where group_id = any($1::uuid[]) order by joined_at', [groupIds])).rows;
  const users = await loadUsers(db, members.map((m) => m.user_id));
  return groups.map((g) => ({
    id: g.id, name: g.name, inviteCode: g.invite_code,
    members: members.filter((m) => m.group_id === g.id).map((m) => users.get(m.user_id)),
  }));
}

export default async function (app) {
  app.addHook('preHandler', app.auth);

  app.get('/groups', async (req) => {
    const ids = (await pool.query(
      'select m.group_id from group_members m join groups g on g.id = m.group_id where m.user_id=$1 order by g.created_at', [req.userId]
    )).rows.map((r) => r.group_id);
    return { groups: await loadGroups(pool, ids) };
  });

  app.post('/groups', async (req, reply) => {
    const b = v.body(req);
    const name = v.cleanText(b.name, 1, 30, 'name');
    const id = await tx(async (c) => {
      await c.query('select id from users where id=$1 for update', [req.userId]);
      const n = (await c.query('select count(*)::int n from group_members where user_id=$1', [req.userId])).rows[0].n;
      if (n >= MAX_GROUPS) throw new ApiError(409, 'TOO_MANY_CREWS', `You can be in at most ${MAX_GROUPS} crews`);
      for (let i = 0; i < 10; i++) {
        const r = await c.query(
          `insert into groups (name, invite_code, created_by) values ($1,$2,$3) on conflict (invite_code) do nothing returning id`,
          [name, newCode(), req.userId]);
        if (r.rowCount) {
          await c.query('insert into group_members (group_id, user_id) values ($1,$2)', [r.rows[0].id, req.userId]);
          return r.rows[0].id;
        }
      }
      throw new Error('Could not generate invite code');
    });
    reply.code(201);
    return { group: (await loadGroups(pool, [id]))[0] };
  });

  app.post('/groups/join', async (req) => {
    const b = v.body(req);
    const code = v.str(b.inviteCode, 'inviteCode').trim().toUpperCase();
    const id = await tx(async (c) => {
      const g = (await c.query('select id from groups where invite_code=$1 for update', [code])).rows[0];
      if (!g) throw notFound('No crew with that invite code');
      const already = (await c.query('select 1 from group_members where group_id=$1 and user_id=$2', [g.id, req.userId])).rowCount;
      if (already) return g.id;
      const size = (await c.query('select count(*)::int n from group_members where group_id=$1', [g.id])).rows[0].n;
      if (size >= MAX_MEMBERS) throw new ApiError(409, 'CREW_FULL', 'That crew is full');
      await c.query('select id from users where id=$1 for update', [req.userId]);
      const mine = (await c.query('select count(*)::int n from group_members where user_id=$1', [req.userId])).rows[0].n;
      if (mine >= MAX_GROUPS) throw new ApiError(409, 'TOO_MANY_CREWS', `You can be in at most ${MAX_GROUPS} crews`);
      await c.query('insert into group_members (group_id, user_id) values ($1,$2) on conflict do nothing', [g.id, req.userId]);
      return g.id;
    });
    return { group: (await loadGroups(pool, [id]))[0] };
  });

  app.post('/groups/:id/custom-question', async (req) => {
    const gid = req.params.id;
    await assertMember(pool, gid, req.userId);
    const text = v.cleanText(v.body(req).text, 8, 120);
    return tx(async (c) => {
      const perk = (await c.query(
        `select id from season_rewards where group_id=$1 and user_id=$2 and perk='deck_writer' and perk_used_at is null
         order by season limit 1 for update`, [gid, req.userId])).rows[0];
      if (!perk) throw new ApiError(403, 'NO_PERK', 'You need an unused Deck Writer perk for this crew');
      await c.query('select id from groups where id=$1 for update', [gid]);
      const taken = new Set((await c.query(
        'select scheduled_day from hive_questions where group_id=$1 and scheduled_day is not null', [gid])).rows.map((r) => r.scheduled_day));
      let day = addDays(today(), 1);
      while (taken.has(day)) day = addDays(day, 1);
      await c.query('insert into hive_questions (text, group_id, author_id, scheduled_day) values ($1,$2,$3,$4)', [text, gid, req.userId, day]);
      await c.query('update season_rewards set perk_used_at = now() where id=$1', [perk.id]);
      return { scheduledFor: day };
    });
  });
}

import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { ApiError, bad } from '../errors.js';
import { signToken } from '../token.js';
import { loadMe } from '../users.js';
import * as v from '../validate.js';
import { clearGlobalCache } from './boards.js';

const ROUNDS = process.env.NODE_ENV === 'test' ? 4 : 12;

export default async function (app) {
  app.post('/auth/register', async (req, reply) => {
    const b = v.body(req);
    const username = v.str(b.username, 'username');
    if (!v.USERNAME_RE.test(username)) throw bad('INVALID_USERNAME', 'Username must be 3-20 letters, numbers, _ or .');
    const password = v.str(b.password, 'password');
    if (password.length < 8 || password.length > 200) throw bad('WEAK_PASSWORD', 'Password must be at least 8 characters');
    const displayName = v.displayName(b.displayName);
    const avatar = v.avatar(b.avatar);
    const color = v.color(b.color);
    const hash = await bcrypt.hash(password, ROUNDS);
    let id;
    try {
      id = (await pool.query(
        'insert into users (username, password_hash, display_name, avatar, color) values ($1,$2,$3,$4,$5) returning id',
        [username, hash, displayName, avatar, color]
      )).rows[0].id;
    } catch (e) {
      if (e.code === '23505') throw new ApiError(409, 'USERNAME_TAKEN', 'That username is taken');
      throw e;
    }
    reply.code(201);
    return { token: signToken(id), user: await loadMe(pool, id) };
  });

  app.post('/auth/login', async (req) => {
    const b = v.body(req);
    const fail = new ApiError(401, 'INVALID_LOGIN', 'Wrong username or password');
    if (typeof b.username !== 'string' || typeof b.password !== 'string') throw fail;
    const row = (await pool.query('select id, password_hash from users where username = $1', [b.username])).rows[0];
    if (!row || !(await bcrypt.compare(b.password, row.password_hash))) throw fail;
    return { token: signToken(row.id), user: await loadMe(pool, row.id) };
  });

  app.get('/me', { preHandler: app.auth }, async (req) => ({ user: await loadMe(pool, req.userId) }));

  app.post('/me/profile', { preHandler: app.auth }, async (req) => {
    const b = v.body(req);
    const displayName = v.displayName(b.displayName);
    const avatar = v.avatar(b.avatar);
    const color = v.color(b.color);
    await pool.query('update users set display_name=$2, avatar=$3, color=$4 where id=$1', [req.userId, displayName, avatar, color]);
    clearGlobalCache();
    return { user: await loadMe(pool, req.userId) };
  });

  app.get('/me/rewards', { preHandler: app.auth }, async (req) => {
    const { rows } = await pool.query(
      `select r.id, r.season, r.scope, r.rank, r.title, r.group_id, g.name as group_name, r.perk, r.perk_used_at
       from season_rewards r left join groups g on g.id = r.group_id
       where r.user_id = $1 order by r.season desc, r.created_at desc`, [req.userId]);
    return {
      rewards: rows.map((r) => ({
        id: r.id, season: r.season, scope: r.scope, rank: r.rank, title: r.title,
        groupId: r.group_id, groupName: r.group_name, perk: r.perk, perkUsed: r.perk_used_at != null,
      })),
    };
  });
}

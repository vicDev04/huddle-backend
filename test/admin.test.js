import { describe, it, expect, beforeEach } from 'vitest';
import { call, register, crew, byId, pool, setNow } from './helpers.js';
import { ensureRound } from '../src/game.js';
import { seasonClose } from '../src/jobs.js';
import { clearGlobalCache } from '../src/routes/boards.js';

const DAY = '2026-11-10';
beforeEach(() => setNow(`${DAY}T12:00:00Z`));

async function makeAdmin(name = 'Admin') {
  const a = await register(name);
  await pool.query('update users set is_admin = true where id = $1', [a.user.id]);
  return a;
}

const ROUTES = [
  ['GET', '/api/admin/stats'],
  ['GET', '/api/admin/questions?type=hive'],
  ['POST', '/api/admin/questions', { type: 'hive', text: 'Quem é que nunca devia ver isto?' }],
  ['POST', '/api/admin/questions/hive/1', { isActive: false }],
  ['GET', '/api/admin/hot-seat/answers'],
  ['POST', '/api/admin/hot-seat/answers/00000000-0000-0000-0000-000000000000/remove', {}],
];

describe('admin access', () => {
  it('no token is 401, non-admin is 403 on every route', async () => {
    const u = await register('Pleb');
    for (const [m, url, body] of ROUTES) {
      expect((await call(m, url, { body })).status, url).toBe(401);
      const r = await call(m, url, { token: u.token, body });
      expect(r.status, url).toBe(403);
      expect(r.body).toEqual({ error: { code: 'FORBIDDEN', message: 'Admins only' } });
    }
  });
  it('removing the flag takes effect immediately', async () => {
    const a = await makeAdmin();
    expect((await call('GET', '/api/admin/stats', { token: a.token })).status).toBe(200);
    await pool.query('update users set is_admin = false where id = $1', [a.user.id]);
    expect((await call('GET', '/api/admin/stats', { token: a.token })).status).toBe(403);
  });
  it('the Huddle account is made admin by the migration (case-insensitive)', async () => {
    const r = await call('POST', '/api/auth/register', { body: { username: 'huddle', password: 'password123', displayName: 'H', avatar: 'a01', color: '#000000' } });
    await pool.query("update users set is_admin = true where username = 'Huddle'"); // same statement as 003_admin.sql
    expect((await call('GET', '/api/me', { token: r.body.token })).body.user.isAdmin).toBe(true);
  });
});

describe('isAdmin field', () => {
  it('is on the caller\'s own user only', async () => {
    const { group, members } = await crew(2);
    await pool.query('update users set is_admin = true where id = $1', [members[1].user.id]);
    const login = async () => (await call('GET', '/api/me', { token: members[1].token })).body.user;
    expect(await login()).toMatchObject({ isAdmin: true });
    expect((await call('GET', '/api/me', { token: members[0].token })).body.user.isAdmin).toBe(false);
    const p = await call('POST', '/api/me/profile', { token: members[0].token, body: { displayName: 'X', avatar: 'a01', color: '#000000' } });
    expect(p.body.user.isAdmin).toBe(false);

    const groups = (await call('GET', '/api/groups', { token: members[0].token })).body.groups;
    for (const m of groups[0].members) expect(m).not.toHaveProperty('isAdmin');
    const today = (await call('GET', `/api/groups/${group.id}/today`, { token: members[0].token })).body;
    expect(JSON.stringify(today)).not.toContain('isAdmin');
    const board = (await call('GET', `/api/leaderboards/group/${group.id}`, { token: members[0].token })).body;
    for (const r of board.rows) expect(r.user).not.toHaveProperty('isAdmin');
    clearGlobalCache();
    const g = (await call('GET', '/api/leaderboards/global', { token: members[0].token })).body;
    for (const r of g.rows) expect(r.user).not.toHaveProperty('isAdmin');
  });
  it('register and login return isAdmin', async () => {
    const r = await call('POST', '/api/auth/register', { body: { username: 'plain.user', password: 'password123', displayName: 'P', avatar: 'a01', color: '#000000' } });
    expect(r.body.user.isAdmin).toBe(false);
    const l = await call('POST', '/api/auth/login', { body: { username: 'plain.user', password: 'password123' } });
    expect(l.body.user.isAdmin).toBe(false);
  });
});

describe('admins are not players on the global board', () => {
  it('excludes admins from the global leaderboard and global rewards, not from crews', async () => {
    const { group, members } = await crew(3);
    const [a, b, c] = members;
    await pool.query('update users set is_admin = true where id = $1', [a.user.id]);
    for (const [u, amt, season, day] of [[a, 100, '2026-10', '2026-10-05'], [b, 40, '2026-10', '2026-10-05'], [a, 90, '2026-11', DAY], [b, 30, '2026-11', DAY]]) {
      await pool.query(`insert into points_ledger (user_id, group_id, season, day, source, amount, ref) values ($1,null,$2,$3,'mini_game',$4,$5)`,
        [u.user.id, season, day, amt, Math.random().toString()]);
    }
    clearGlobalCache();
    const g = (await call('GET', '/api/leaderboards/global', { token: c.token })).body;
    expect(g.rows.some((r) => r.user.id === a.user.id)).toBe(false);
    expect(g.rows.find((r) => r.user.id === b.user.id).points).toBe(30);
    const asAdmin = (await call('GET', '/api/leaderboards/global', { token: a.token })).body;
    expect(asAdmin.rows.some((r) => r.user.id === a.user.id)).toBe(false);
    const crewBoard = (await call('GET', `/api/leaderboards/group/${group.id}`, { token: c.token })).body;
    expect(crewBoard.rows[0].user.id).toBe(a.user.id);

    setNow('2026-11-01T01:00:00Z');
    await seasonClose();
    const globals = (await pool.query("select user_id from season_rewards where scope='global' and season='2026-10'")).rows.map((r) => r.user_id);
    expect(globals).not.toContain(a.user.id);
    expect(globals).toContain(b.user.id);
    const crewR = (await pool.query("select user_id from season_rewards where scope='group' and group_id=$1 and rank=1", [group.id])).rows;
    expect(crewR).toEqual([{ user_id: a.user.id }]);
  });
});

describe('question deck', () => {
  it('adds, edits, disables, and disabled questions are never dealt', async () => {
    const admin = await makeAdmin();
    const add = (body) => call('POST', '/api/admin/questions', { token: admin.token, body });
    const r = await add({ type: 'hive', text: '  Quem dança pior\u0007 na pista?  ' });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({ text: 'Quem dança pior na pista?', isActive: true, scope: 'global', crewName: null });
    const id = r.body.item.id;
    expect((await add({ type: 'hive', text: 'QUEM DANÇA PIOR NA PISTA?' })).body.error.code).toBe('DUPLICATE');
    expect((await add({ type: 'hive', text: 'curta' })).status).toBe(400);
    expect((await add({ type: 'nope', text: 'Quem é o mais lento?' })).status).toBe(400);

    const e = await call('POST', `/api/admin/questions/hive/${id}`, { token: admin.token, body: { text: 'Quem dança melhor na pista?' } });
    expect(e.body.item).toMatchObject({ id, text: 'Quem dança melhor na pista?', isActive: true });
    expect((await call('POST', '/api/admin/questions/hive/999999', { token: admin.token, body: { isActive: false } })).status).toBe(404);

    // disable every active global hive question except one; then disable that one too
    const list = (await call('GET', '/api/admin/questions?type=hive', { token: admin.token })).body.items;
    expect(list[0].isActive).toBe(true);
    const off = await call('POST', `/api/admin/questions/hive/${id}`, { token: admin.token, body: { isActive: false } });
    expect(off.body.item.isActive).toBe(false);
    const after = (await call('GET', '/api/admin/questions?type=hive', { token: admin.token })).body.items;
    expect(after.findIndex((q) => q.id === id)).toBeGreaterThan(after.findLastIndex((q) => q.isActive));

    for (let i = 0; i < 15; i++) {
      const { group } = await crew(2);
      const round = await ensureRound(group.id, DAY);
      expect(round.hive_question_ids).not.toContain(id);
    }
  });

  it('crew questions show crew scope', async () => {
    const admin = await makeAdmin();
    const { group, members } = await crew(1);
    await pool.query('insert into hive_questions (text, group_id, author_id, scheduled_day) values ($1,$2,$3,$4)', ['Pergunta da crew aqui?', group.id, members[0].user.id, '2026-11-20']);
    const items = (await call('GET', '/api/admin/questions?type=hive', { token: admin.token })).body.items;
    expect(items.find((q) => q.text === 'Pergunta da crew aqui?')).toMatchObject({ scope: 'crew', crewName: 'Test Crew' });
  });

  it('hot_seat prompts require {name}', async () => {
    const admin = await makeAdmin();
    const bad = await call('POST', '/api/admin/questions', { token: admin.token, body: { type: 'hot_seat', text: 'O que faria com um milhão?' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('MISSING_NAME_PLACEHOLDER');
    const ok = await call('POST', '/api/admin/questions', { token: admin.token, body: { type: 'hot_seat', text: 'O que faria {name} com um milhão?' } });
    expect(ok.status).toBe(201);
    expect(ok.body.item).toMatchObject({ scope: 'global', crewName: null });
    const edit = await call('POST', `/api/admin/questions/hot_seat/${ok.body.item.id}`, { token: admin.token, body: { text: 'Sem nome nenhum aqui' } });
    expect(edit.body.error.code).toBe('MISSING_NAME_PLACEHOLDER');
  });

  it('stats', async () => {
    const admin = await makeAdmin();
    const s = (await call('GET', '/api/admin/stats', { token: admin.token })).body;
    for (const k of ['users', 'crews', 'activeToday', 'hiveVotesToday', 'hotSeatAnswersToday', 'miniGamePlaysToday', 'hiveQuestionsActive', 'hotSeatPromptsActive']) expect(typeof s[k], k).toBe('number');
  });
});

describe('hot seat moderation', () => {
  it('lists answers with authors and removes one, clearing points and the favourite', async () => {
    const admin = await makeAdmin();
    const { group, members } = await crew(4);
    const t = (await call('GET', `/api/groups/${group.id}/today`, { token: members[0].token })).body;
    const subject = byId(members, t.hotSeat.subject.id);
    const [o1, o2] = members.filter((m) => m !== subject);
    await call('POST', `/api/groups/${group.id}/hot-seat/answers`, { token: o1.token, body: { text: 'Comprava um barco' } });
    await call('POST', `/api/groups/${group.id}/hot-seat/answers`, { token: o2.token, body: { text: 'Fugia para Marte' } });
    const subj = (await call('GET', `/api/groups/${group.id}/today`, { token: subject.token })).body.hotSeat;
    const crowned = subj.answers.find((a) => a.text === 'Comprava um barco');
    await call('POST', `/api/groups/${group.id}/hot-seat/favorite`, { token: subject.token, body: { answerId: crowned.id } });

    const list = (await call('GET', '/api/admin/hot-seat/answers', { token: admin.token })).body;
    expect(list.day).toBe(DAY);
    const item = list.items.find((i) => i.id === crowned.id);
    expect(item).toMatchObject({ text: 'Comprava um barco', crewName: 'Test Crew', subjectName: subject.user.displayName, isFavorite: true });
    expect(item.authorName).toMatch(/^P\d \(@u/);
    expect((await call('GET', '/api/admin/hot-seat/answers?day=nope', { token: admin.token })).status).toBe(400);

    const r = await call('POST', `/api/admin/hot-seat/answers/${crowned.id}/remove`, { token: admin.token });
    expect(r.body).toEqual({ ok: true });
    const pts = (await pool.query('select user_id, source from points_ledger where group_id=$1 order by source', [group.id])).rows;
    expect(pts).toEqual([{ user_id: o2.user.id, source: 'hot_seat' }]);
    const after = (await call('GET', `/api/groups/${group.id}/today`, { token: subject.token })).body.hotSeat;
    expect(after.favoriteId).toBeNull();
    expect(after.answers).toHaveLength(1);
    expect(after.canPick).toBe(true);
    expect((await call('POST', `/api/admin/hot-seat/answers/${crowned.id}/remove`, { token: admin.token })).status).toBe(404);
  });

  it('removing an uncrowned answer leaves the favourite and judge points', async () => {
    const admin = await makeAdmin();
    const { group, members } = await crew(4);
    const t = (await call('GET', `/api/groups/${group.id}/today`, { token: members[0].token })).body;
    const subject = byId(members, t.hotSeat.subject.id);
    const [o1, o2] = members.filter((m) => m !== subject);
    await call('POST', `/api/groups/${group.id}/hot-seat/answers`, { token: o1.token, body: { text: 'Resposta um' } });
    await call('POST', `/api/groups/${group.id}/hot-seat/answers`, { token: o2.token, body: { text: 'Resposta dois' } });
    const ans = (await call('GET', `/api/groups/${group.id}/today`, { token: subject.token })).body.hotSeat.answers;
    await call('POST', `/api/groups/${group.id}/hot-seat/favorite`, { token: subject.token, body: { answerId: ans[0].id } });
    await call('POST', `/api/admin/hot-seat/answers/${ans[1].id}/remove`, { token: admin.token });
    const pts = (await pool.query('select source from points_ledger where group_id=$1 order by source', [group.id])).rows.map((r) => r.source);
    expect(pts).toEqual(['hot_seat', 'hot_seat_crowned', 'hot_seat_judge']);
  });
});

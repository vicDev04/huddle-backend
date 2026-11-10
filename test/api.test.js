import fs from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import { call, register, crew, byId, pool, setNow } from './helpers.js';
import { miniKey } from '../src/game.js';
import { nightlyClose, seasonClose } from '../src/jobs.js';

const DAY = '2026-11-10';
beforeEach(() => setNow(`${DAY}T12:00:00Z`));

describe('CORS', () => {
  for (const origin of ['capacitor://localhost', 'https://localhost']) {
    it(`preflight from ${origin}`, async () => {
      const r = await call('OPTIONS', '/api/auth/login', {
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
      });
      expect(r.status).toBe(204);
      expect(r.headers['access-control-allow-origin']).toBe(origin);
      expect(r.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
      expect(r.headers['access-control-allow-headers']).toBe('Authorization, Content-Type');
      expect(r.headers.vary).toContain('Origin');
    });
  }
  it('echoes origin on real requests and ignores unknown origins', async () => {
    const ok = await call('GET', '/api/health', { headers: { origin: 'capacitor://localhost' } });
    expect(ok.headers['access-control-allow-origin']).toBe('capacitor://localhost');
    const no = await call('GET', '/api/health', { headers: { origin: 'https://evil.example' } });
    expect(no.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('auth, avatars and profile', () => {
  it('accepts builder codes and presets', async () => {
    expect((await register('A', { avatar: 'L.0.c.2.3.6.c.3.3.0.0.0.0.0' })).user.avatar).toBe('L.0.c.2.3.6.c.3.3.0.0.0.0.0');
    expect((await register('B', { avatar: 'a18' })).user.avatar).toBe('a18');
  });
  it('rejects garbage and over-long avatars', async () => {
    for (const avatar of ['😎', 'a19', 'a00', 'hello', 'L.0.0', 'L' + '.0'.repeat(14), 'L' + '.zzz'.repeat(13), 'x'.repeat(100)]) {
      const r = await call('POST', '/api/auth/register', { body: { username: 'zz_' + Math.random().toString(36).slice(2, 10), password: 'password123', displayName: 'X', avatar, color: '#000000' } });
      expect(r.status, avatar).toBe(400);
      expect(r.body.error.code).toBe('INVALID_AVATAR');
    }
  });
  it('still reads legacy emoji avatars', async () => {
    const { token, user } = await register('Old');
    await pool.query("update users set avatar='😎' where id=$1", [user.id]);
    expect((await call('GET', '/api/me', { token })).body.user.avatar).toBe('😎');
  });
  it('login works, wrong password is 401, duplicate username is 409', async () => {
    const r = await call('POST', '/api/auth/register', { body: { username: 'dup.user', password: 'password123', displayName: 'D', avatar: 'a02', color: '#123456' } });
    expect(r.status).toBe(201);
    expect(r.body.user).not.toHaveProperty('username');
    expect((await call('POST', '/api/auth/register', { body: { username: 'DUP.user', password: 'password123', displayName: 'D', avatar: 'a02', color: '#123456' } })).status).toBe(409);
    expect((await call('POST', '/api/auth/login', { body: { username: 'dup.user', password: 'password123' } })).status).toBe(200);
    expect((await call('POST', '/api/auth/login', { body: { username: 'dup.user', password: 'nope12345' } })).status).toBe(401);
    expect((await call('GET', '/api/me')).status).toBe(401);
  });
  it('POST /me/profile updates and returns UserPublic', async () => {
    const { token, user } = await register('Before');
    const r = await call('POST', '/api/me/profile', { token, body: { displayName: '  After  ', avatar: 'L.1.2.3.4.5.6.7.8.9.a.b.c.dz', color: '#ABCDEF' } });
    expect(r.status).toBe(200);
    expect(r.body.user).toEqual({ id: user.id, displayName: 'After', avatar: 'L.1.2.3.4.5.6.7.8.9.a.b.c.dz', color: '#ABCDEF', frame: null });
    expect((await call('GET', '/api/me', { token })).body.user.displayName).toBe('After');
    expect((await call('POST', '/api/me/profile', { token, body: { displayName: 'X', avatar: 'nope', color: '#ABCDEF' } })).body.error.code).toBe('INVALID_AVATAR');
    expect((await call('POST', '/api/me/profile', { token, body: { displayName: '', avatar: 'a01', color: '#ABCDEF' } })).status).toBe(400);
    expect((await call('POST', '/api/me/profile', { token, body: { displayName: 'X', avatar: 'a01' } })).status).toBe(400);
  });
});

describe('seed migration', () => {
  it('is idempotent and deactivates old content', async () => {
    await pool.query("insert into hive_questions (text) values ('Old English question?')");
    await pool.query("insert into hot_seat_prompts (text) values ('Old {name} prompt')");
    const sql = fs.readFileSync(new URL('../migrations/002_seed_pt.sql', import.meta.url), 'utf8');
    for (let i = 0; i < 2; i++) {
      const c = await pool.connect();
      try { await c.query('begin'); await c.query(sql); await c.query('commit'); } finally { c.release(); }
    }
    const q = (await pool.query("select count(*)::int n, count(distinct text)::int d, count(*) filter (where is_active)::int a from hive_questions where group_id is null")).rows[0];
    expect(q.n).toBe(51); expect(q.d).toBe(51); expect(q.a).toBe(50);
    const p = (await pool.query("select count(*)::int n, count(*) filter (where is_active)::int a from hot_seat_prompts")).rows[0];
    expect(p.n).toBe(21); expect(p.a).toBe(20);
  });
});

describe('crews and membership', () => {
  it('non-members get 404 everywhere', async () => {
    const { group } = await crew(2);
    const outsider = await register('Out');
    for (const [m, u] of [['GET', `/api/groups/${group.id}/today`], ['GET', `/api/leaderboards/group/${group.id}`], ['POST', `/api/groups/${group.id}/hot-seat/answers`], ['POST', `/api/groups/${group.id}/hive/1`], ['GET', '/api/groups/not-a-uuid/today']]) {
      expect((await call(m, u, { token: outsider.token, body: m === 'POST' ? { text: 'hello' } : undefined })).status, u).toBe(404);
    }
    expect((await call('POST', '/api/groups/join', { token: outsider.token, body: { inviteCode: 'ZZZZZZ' } })).status).toBe(404);
  });
  it('join is idempotent and capped at 12', async () => {
    const { group, members } = await crew(12);
    const again = await call('POST', '/api/groups/join', { token: members[1].token, body: { inviteCode: group.inviteCode } });
    expect(again.status).toBe(200);
    expect(again.body.group.members).toHaveLength(12);
    const extra = await register('Extra');
    expect((await call('POST', '/api/groups/join', { token: extra.token, body: { inviteCode: group.inviteCode } })).status).toBe(409);
  });
});

describe('today, hive mind and hot seat', () => {
  it('builds the today payload with Portuguese content', async () => {
    const { group, members } = await crew(3);
    const r = await call('GET', `/api/groups/${group.id}/today`, { token: members[0].token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ date: DAY, season: '2026-11', daysLeft: 21, streak: 0 });
    expect(r.body.members).toHaveLength(3);
    expect(r.body.hive).toHaveLength(3);
    expect(r.body.hive[0].text).toMatch(/^Quem/);
    expect(r.body.hotSeat.prompt).toContain(r.body.hotSeat.subject.displayName);
    expect(r.body.hotSeat.prompt).not.toContain('{name}');
    expect(r.body.miniGame).toMatchObject({ key: miniKey(DAY), date: DAY, seed: 'mini:' + DAY, played: false, points: null });
  });

  it('settles a question when everyone has voted and awards points', async () => {
    const { group, members } = await crew(3);
    const t = (await call('GET', `/api/groups/${group.id}/today`, { token: members[0].token })).body;
    const q = t.hive[0].id;
    const [a, b, c] = members;
    // a and b vote for b, c votes for a -> majority [b]. a predicts b (right), b predicts a (wrong), c predicts b (right)
    let r = await call('POST', `/api/groups/${group.id}/hive/${q}`, { token: a.token, body: { votedUserId: b.user.id, predictedUserId: b.user.id } });
    expect(r.status).toBe(200);
    expect(r.body.question.result).toBeNull();
    expect((await call('POST', `/api/groups/${group.id}/hive/${q}`, { token: a.token, body: { votedUserId: b.user.id, predictedUserId: b.user.id } })).status).toBe(409);
    await call('POST', `/api/groups/${group.id}/hive/${q}`, { token: b.token, body: { votedUserId: b.user.id, predictedUserId: a.user.id } });
    r = await call('POST', `/api/groups/${group.id}/hive/${q}`, { token: c.token, body: { votedUserId: a.user.id, predictedUserId: b.user.id } });
    expect(r.body.question.result.majorityIds).toEqual([b.user.id]);
    expect(r.body.question.result.predictedRight).toBe(true);
    expect(r.body.question.result.pointsEarned).toBe(13);
    expect(r.body.question.result.tally[0]).toMatchObject({ user: { id: b.user.id }, count: 2 });
    const bView = (await call('GET', `/api/groups/${group.id}/today`, { token: b.token })).body.hive.find((h) => h.id === q);
    expect(bView.result.pointsEarned).toBe(3);
    expect(bView.result.predictedRight).toBe(false);
    expect((await call('GET', `/api/groups/${group.id}/today`, { token: b.token })).body.streak).toBe(1);
  });

  it('rejects voters who joined after the round started', async () => {
    const { group, members } = await crew(2);
    const t = (await call('GET', `/api/groups/${group.id}/today`, { token: members[0].token })).body;
    const late = await register('Late');
    await call('POST', '/api/groups/join', { token: late.token, body: { inviteCode: group.inviteCode } });
    const r = await call('POST', `/api/groups/${group.id}/hive/${t.hive[0].id}`, { token: late.token, body: { votedUserId: members[0].user.id, predictedUserId: members[0].user.id } });
    expect(r.status).toBe(403);
  });

  it('nightly close settles partial votes', async () => {
    const { group, members } = await crew(3);
    const t = (await call('GET', `/api/groups/${group.id}/today`, { token: members[0].token })).body;
    await call('POST', `/api/groups/${group.id}/hive/${t.hive[1].id}`, { token: members[0].token, body: { votedUserId: members[1].user.id, predictedUserId: members[1].user.id } });
    setNow('2026-11-11T12:00:00Z');
    expect(await nightlyClose()).toBeGreaterThanOrEqual(1);
    const again = await nightlyClose();
    const pts = (await pool.query("select amount from points_ledger where user_id=$1 and source='hive'", [members[0].user.id])).rows;
    expect(pts).toEqual([{ amount: 13 }]);
    expect(again).toBe(0);
  });

  it('keeps Hot Seat answers anonymous except the crowned one', async () => {
    const { group, members } = await crew(4);
    const t = (await call('GET', `/api/groups/${group.id}/today`, { token: members[0].token })).body;
    const subject = byId(members, t.hotSeat.subject.id);
    const others = members.filter((m) => m !== subject);
    expect((await call('POST', `/api/groups/${group.id}/hot-seat/answers`, { token: subject.token, body: { text: 'me me' } })).status).toBe(403);
    expect((await call('POST', `/api/groups/${group.id}/hot-seat/answers`, { token: others[0].token, body: { text: 'que merda' } })).status).toBe(400);

    const before = (await call('GET', `/api/groups/${group.id}/today`, { token: others[1].token })).body.hotSeat;
    expect(before.answers).toEqual([]);
    const r1 = await call('POST', `/api/groups/${group.id}/hot-seat/answers`, { token: others[0].token, body: { text: '  Comprava um barco  ' } });
    expect(r1.body.hotSeat.myAnswer).toBe('Comprava um barco');
    expect((await call('POST', `/api/groups/${group.id}/hot-seat/answers`, { token: others[0].token, body: { text: 'again' } })).status).toBe(409);
    await call('POST', `/api/groups/${group.id}/hot-seat/answers`, { token: others[1].token, body: { text: 'Fugia para Marte' } });

    const subj = (await call('GET', `/api/groups/${group.id}/today`, { token: subject.token })).body.hotSeat;
    expect(subj.answers).toHaveLength(2);
    expect(subj.canPick).toBe(true);
    const raw = JSON.stringify(subj);
    for (const o of others) expect(raw).not.toContain(o.user.id);

    expect((await call('POST', `/api/groups/${group.id}/hot-seat/favorite`, { token: others[0].token, body: { answerId: subj.answers[0].id } })).status).toBe(403);
    const fav = await call('POST', `/api/groups/${group.id}/hot-seat/favorite`, { token: subject.token, body: { answerId: subj.answers[0].id } });
    expect(fav.status).toBe(200);
    expect(fav.body.hotSeat.answers[0].author.id).toBe(others[0].user.id);
    expect(fav.body.hotSeat.answers[1].author).toBeNull();
    expect(JSON.stringify(fav.body)).not.toContain(others[1].user.id);
    expect((await call('POST', `/api/groups/${group.id}/hot-seat/favorite`, { token: subject.token, body: { answerId: subj.answers[1].id } })).status).toBe(409);
    const pts = (await pool.query('select user_id, source, amount from points_ledger where group_id=$1 order by source', [group.id])).rows;
    expect(pts.filter((p) => p.source === 'hot_seat_crowned')).toEqual([{ user_id: others[0].user.id, source: 'hot_seat_crowned', amount: 25 }]);
    expect(pts.filter((p) => p.source === 'hot_seat_judge')).toEqual([{ user_id: subject.user.id, source: 'hot_seat_judge', amount: 5 }]);
  });
});

describe('mini games', () => {
  const key = () => miniKey(DAY);
  const rawFor = (k) => ({ reaction: { avgMs: 300 }, pattern: { level: 9 }, maths: { correct: 12, wrong: 2 }, stroop: { correct: 15, wrong: 1 } }[k]);
  const expected = (k) => ({ reaction: 75, pattern: 72, maths: 78, stroop: 72 }[k]);

  it('recomputes points server-side and blocks a second play', async () => {
    const { token } = await register('Gamer');
    const r = await call('POST', '/api/minigames/submit', { token, body: { gameKey: key(), date: DAY, raw: { ...rawFor(key()), points: 9999 } } });
    expect(r.status).toBe(200);
    expect(r.body.points).toBe(expected(key()));
    expect((await call('POST', '/api/minigames/submit', { token, body: { gameKey: key(), date: DAY, raw: rawFor(key()) } })).status).toBe(409);
  });
  it('rejects expired games and malformed raw', async () => {
    const { token } = await register('Gamer2');
    expect((await call('POST', '/api/minigames/submit', { token, body: { gameKey: key(), date: '2026-11-09', raw: rawFor(key()) } })).body.error.message).toBe('That game has expired');
    expect((await call('POST', '/api/minigames/submit', { token, body: { gameKey: key(), date: DAY, raw: { nope: true } } })).status).toBe(400);
  });
  it('scoring formulas clamp correctly', async () => {
    const { scoreMini } = await import('../src/game.js');
    expect(scoreMini('reaction', { avgMs: 100 })).toBe(0);
    expect(scoreMini('reaction', { avgMs: 120 })).toBe(100);
    expect(scoreMini('reaction', { avgMs: 900 })).toBe(0);
    expect(scoreMini('pattern', { level: 25 })).toBe(100);
    expect(scoreMini('pattern', { level: 26 })).toBeNull();
    expect(scoreMini('maths', { correct: 61, wrong: 0 })).toBeNull();
    expect(scoreMini('stroop', { correct: 2, wrong: 10 })).toBe(0);
  });
});

describe('leaderboards and seasons', () => {
  it('crew boards include mini games, global boards only mini games', async () => {
    const { group, members } = await crew(3);
    const [a, b, c] = members;
    const add = (u, gid, source, amount, at) => pool.query(
      `insert into points_ledger (user_id, group_id, season, day, source, amount, ref, created_at) values ($1,$2,'2026-11',$3,$4,$5,$6,$7)`,
      [u.user.id, gid, DAY, source, amount, Math.random().toString(), at]);
    await add(a, group.id, 'hive', 50, '2026-11-10T10:00:00Z');
    await add(b, null, 'mini_game', 30, '2026-11-10T09:00:00Z');
    await add(b, group.id, 'hot_seat', 20, '2026-11-10T09:30:00Z');
    const crewBoard = (await call('GET', `/api/leaderboards/group/${group.id}`, { token: c.token })).body;
    expect(crewBoard.rows.map((r) => [r.user.id, r.points, r.rank])).toEqual([[b.user.id, 50, 1], [a.user.id, 50, 1], [c.user.id, 0, 3]]);
    expect(crewBoard.rows[2].isMe).toBe(true);
    const global = (await call('GET', '/api/leaderboards/global', { token: a.token })).body;
    expect(global.rows.find((r) => r.user.id === b.user.id).points).toBe(30);
    expect(global.rows.find((r) => r.user.id === a.user.id)).toMatchObject({ points: 0, isMe: true });
    expect((await call('GET', '/api/leaderboards/global?season=2026-13', { token: a.token })).status).toBe(400);
  });

  it('season close is idempotent and grants the deck_writer perk', async () => {
    const { group, members } = await crew(3);
    const [a, b] = members;
    await pool.query(`insert into points_ledger (user_id, group_id, season, day, source, amount, ref) values
      ($1,$3,'2026-10','2026-10-05','hive',40,'x1'), ($2,$3,'2026-10','2026-10-05','hive',10,'x2')`, [a.user.id, b.user.id, group.id]);
    setNow('2026-11-01T01:00:00Z');
    await seasonClose();
    await seasonClose();
    const rows = (await pool.query("select user_id, rank, title, perk from season_rewards where group_id=$1 order by rank", [group.id])).rows;
    expect(rows).toEqual([
      { user_id: a.user.id, rank: 1, title: 'Crew Captain', perk: 'deck_writer' },
      { user_id: b.user.id, rank: 2, title: 'First Mate', perk: null },
    ]);
    const globals = (await pool.query("select user_id, count(*)::int n from season_rewards where scope='global' and season='2026-10' group by 1")).rows;
    for (const g of globals) expect(g.n).toBe(1);

    setNow(`${DAY}T12:00:00Z`);
    expect((await call('GET', '/api/me', { token: a.token })).body.user.frame).toBe('gold');
    const rewards = (await call('GET', '/api/me/rewards', { token: a.token })).body.rewards;
    expect(rewards[0]).toMatchObject({ scope: 'group', rank: 1, groupName: 'Test Crew', perk: 'deck_writer', perkUsed: false });

    const cq = await call('POST', `/api/groups/${group.id}/custom-question`, { token: a.token, body: { text: 'Quem come mais pastéis de nata?' } });
    expect(cq.body).toEqual({ scheduledFor: '2026-11-11' });
    expect((await call('POST', `/api/groups/${group.id}/custom-question`, { token: a.token, body: { text: 'Outra pergunta aqui?' } })).status).toBe(403);
    setNow('2026-11-11T12:00:00Z');
    const t = (await call('GET', `/api/groups/${group.id}/today`, { token: b.token })).body;
    expect(t.hive[0]).toMatchObject({ text: 'Quem come mais pastéis de nata?', custom: true });
  });
});

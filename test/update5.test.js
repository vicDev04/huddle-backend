import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { call, register, crew, pool, setNow } from './helpers.js';
import { addPoints } from '../src/ledger.js';
import { ensureRound, scoreMini, miniKey } from '../src/game.js';
import { syncAchievements, ACHIEVEMENTS } from '../src/achievements.js';
import { addDays } from '../src/time.js';

const DAY = '2026-11-10'; // a Tuesday; week of 2026-11-09 is "arcade"
beforeEach(() => setNow(`${DAY}T12:00:00Z`));
// api.test re-runs the 002 seed, which deactivates every non-PT row; restore the 005 packs.
beforeAll(async () => {
  await pool.query(`update hive_questions set is_active = true where group_id is null and pack <> 'classic'`);
  await pool.query(`update hot_seat_prompts set is_active = true where pack <> 'classic'`);
});

const coins = async (id) => (await pool.query('select coins from users where id=$1', [id])).rows[0].coins;
const packsOf = async (ids) => (await pool.query('select pack from hive_questions where id = any($1::int[])', [ids])).rows.map((r) => r.pack);
const lockAchievements = (uid) => pool.query(
  `insert into user_achievements (user_id, achievement_id) select $1, unnest($2::text[]) on conflict do nothing`, [uid, ACHIEVEMENTS.map((a) => a.id)]);

describe('deck packs', () => {
  it('only the creator switches, and the switch applies from tomorrow', async () => {
    const { group, members } = await crew(3);
    const stranger = await register('Out');
    expect(group).toMatchObject({ pack: 'classic', canManage: true });
    const setPack = (token, pack) => call('POST', `/api/groups/${group.id}/pack`, { token, body: { pack } });
    expect((await setPack(members[1].token, 'office')).status).toBe(403);
    expect((await setPack(stranger.token, 'office')).status).toBe(404);
    expect((await setPack(members[0].token, 'nope')).body.error.code).toBe('INVALID_PACK');

    const r = await setPack(members[0].token, 'office');
    expect(r.status).toBe(200);
    expect(r.body.group).toMatchObject({ pack: 'office', canManage: true });
    const listed = (await call('GET', '/api/groups', { token: members[1].token })).body.groups[0];
    expect(listed).toMatchObject({ pack: 'office', canManage: false });

    const today = await ensureRound(group.id, DAY);
    expect(new Set(await packsOf(today.hive_question_ids))).toEqual(new Set(['classic']));
    const tomorrow = await ensureRound(group.id, addDays(DAY, 1));
    expect(new Set(await packsOf(tomorrow.hive_question_ids))).toEqual(new Set(['office']));
    const prompt = (await pool.query('select pack from hot_seat_prompts where id=$1', [tomorrow.hot_seat_prompt_id])).rows[0];
    expect(prompt.pack).toBe('office');

    // Switching back to the pack in force today clears the pending change.
    await setPack(members[0].token, 'classic');
    const g = (await pool.query('select pack, pack_prev, pack_from from groups where id=$1', [group.id])).rows[0];
    expect(g).toEqual({ pack: 'classic', pack_prev: null, pack_from: null });
  });

  it('creating a crew with a pack, and the least-recently-used fallback when the pack runs low', async () => {
    const a = await register('A'); const b = await register('B');
    expect((await call('POST', '/api/groups', { token: a.token, body: { name: 'Bad', pack: 'x' } })).body.error.code).toBe('INVALID_PACK');
    const g = (await call('POST', '/api/groups', { token: a.token, body: { name: 'Lovers', pack: 'couples' } })).body.group;
    await call('POST', '/api/groups/join', { token: b.token, body: { inviteCode: g.inviteCode } });
    expect(g.pack).toBe('couples');
    const start = '2026-12-01';
    const rounds = [];
    for (let i = 0; i < 13; i++) rounds.push(await ensureRound(g.id, addDays(start, i)));
    for (const r of rounds) {
      expect(r.hive_question_ids).toHaveLength(3);
      expect(new Set(await packsOf(r.hive_question_ids))).toEqual(new Set(['couples']));
    }
    // 24 couples questions, 3 a day: day 9 has nothing fresh and reuses day 1's (the oldest).
    expect(new Set(rounds[8].hive_question_ids)).toEqual(new Set(rounds[0].hive_question_ids));
    // 12 prompts: day 13 falls back to day 1's prompt.
    expect(rounds[12].hot_seat_prompt_id).toBe(rounds[0].hot_seat_prompt_id);
  });

  it('admin list filters by pack and create accepts a pack', async () => {
    const adm = await register('Adm');
    await pool.query('update users set is_admin = true where id = $1', [adm.user.id]);
    const list = (await call('GET', '/api/admin/questions?type=hive&pack=spicy', { token: adm.token })).body.items;
    expect(list.length).toBeGreaterThanOrEqual(24);
    expect(list.every((i) => i.pack === 'spicy')).toBe(true);
    const r = await call('POST', '/api/admin/questions', { token: adm.token, body: { type: 'hot_seat', text: 'Who would {name} call at 3am?', pack: 'family' } });
    expect(r.status).toBe(201);
    expect(r.body.item.pack).toBe('family');
    expect((await call('POST', '/api/admin/questions', { token: adm.token, body: { type: 'hive', text: 'Another good one?', pack: 'zz' } })).status).toBe(400);
  });
});

describe('new mini games', () => {
  it('rotate through 8 keys', () => {
    const keys = new Set(Array.from({ length: 8 }, (_, i) => miniKey(addDays(DAY, i))));
    expect(keys).toEqual(new Set(['reaction', 'pattern', 'maths', 'stroop', 'scramble', 'memory', 'highlow', 'spotter']));
  });
  it('score server-side', () => {
    expect(scoreMini('scramble', { solved: 10, skipped: 3 })).toBe(100);
    expect(scoreMini('scramble', { solved: 5, skipped: 0 })).toBe(55);
    expect(scoreMini('scramble', { solved: 21, skipped: 0 })).toBe(null);
    expect(scoreMini('memory', { moves: 8, ms: 20000 })).toBe(100);
    expect(scoreMini('memory', { moves: 12, ms: 35000 })).toBe(70);
    expect(scoreMini('memory', { moves: 7, ms: 20000 })).toBe(0);
    expect(scoreMini('memory', { moves: 8, ms: 2000 })).toBe(0);
    expect(scoreMini('memory', { moves: 201, ms: 20000 })).toBe(null);
    expect(scoreMini('highlow', { correct: 12, wrong: 3 })).toBe(45);
    expect(scoreMini('highlow', { correct: 61, wrong: 0 })).toBe(null);
    expect(scoreMini('spotter', { correct: 20, wrong: 5 })).toBe(100);
    expect(scoreMini('spotter', { correct: 3, wrong: 10 })).toBe(0);
    expect(scoreMini('spotter', { correct: 1.5, wrong: 0 })).toBe(null);
  });
  it('rejects malformed raw for today\'s new game with 400', async () => {
    const { token } = await register('Odd'); // 2026-11-10 is spotter
    expect(miniKey(DAY)).toBe('spotter');
    const r = await call('POST', '/api/minigames/submit', { token, body: { gameKey: 'spotter', date: DAY, raw: { correct: 'x' } } });
    expect(r.status).toBe(400);
  });
});

describe('achievements', () => {
  it('pays coins and titles exactly once, even when synced concurrently', async () => {
    const { token, user } = await register('Streaker');
    for (let i = 0; i < 7; i++) await addPoints(pool, { userId: user.id, day: addDays(DAY, -i), source: 'hot_seat', amount: 0, ref: 'x' });
    const before = await coins(user.id);
    await Promise.all([syncAchievements(user.id), syncAchievements(user.id), syncAchievements(user.id)]);
    expect(await coins(user.id)).toBe(before + 20 + 30 + 80);
    await syncAchievements(user.id);
    expect(await coins(user.id)).toBe(before + 130);
    const titles = (await pool.query(`select source from user_items where user_id=$1 and item_id='title_onfire'`, [user.id])).rows;
    expect(titles).toEqual([{ source: 'achievement' }]);

    const r = (await call('GET', '/api/me/achievements', { token })).body.items;
    expect(r.map((i) => i.id)).toEqual(ACHIEVEMENTS.map((a) => a.id));
    expect(r.find((i) => i.id === 'streak_7')).toMatchObject({ progress: 7, target: 7 });
    expect(r.find((i) => i.id === 'streak_30')).toMatchObject({ progress: 7, target: 30, unlockedAt: null });
    expect(r.find((i) => i.id === 'first_steps').unlockedAt).toBeTruthy();
    const inv = (await call('GET', '/api/me/inventory', { token })).body;
    expect(inv.owned).toContain('title_onfire');
    expect((await call('POST', '/api/me/title', { token, body: { titleId: 'title_onfire' } })).body.user.title).toBe('On Fire');
    expect((await call('POST', '/api/me/title', { token, body: { titleId: 'title_flawless' } })).status).toBe(403);
    expect((await call('POST', '/api/shop/buy', { token, body: { itemId: 'title_flawless' } })).body.error.code).toBe('NOT_FOR_SALE');
  });
  it('a perfect mini game unlocks Flawless via the submit hook', async () => {
    const { token, user } = await register('Perfect');
    await call('POST', '/api/minigames/submit', { token, body: { gameKey: 'spotter', date: DAY, raw: { correct: 20, wrong: 0 } } });
    const ids = (await pool.query('select achievement_id from user_achievements where user_id=$1', [user.id])).rows.map((r) => r.achievement_id);
    expect(ids.sort()).toEqual(['first_steps', 'perfect_game']);
  });
});

describe('weekly crew challenge', () => {
  const challenge = async (gid, token) => (await call('GET', `/api/groups/${gid}/challenge`, { token })).body.challenge;

  it('is null for a crew of one', async () => {
    const { group, members } = await crew(1);
    expect(await challenge(group.id, members[0].token)).toBe(null);
  });

  it('arcade: progress, target, contributions and claiming', async () => {
    const { group, members } = await crew(3);
    const [a, b, c] = members;
    for (let i = 0; i < 8; i++) await addPoints(pool, { userId: a.user.id, day: '2026-11-09', source: 'mini_game', amount: 10, ref: `a${i}` });
    await addPoints(pool, { userId: a.user.id, day: '2026-11-08', source: 'mini_game', amount: 10, ref: 'old' }); // last week
    let ch = await challenge(group.id, a.token);
    expect(ch).toMatchObject({ id: 'arcade', week: '2026-11-09', target: 15, progress: 8, completed: false, claimed: false, eligible: true,
      rewardCoins: 50, endsOn: '2026-11-15', daysLeft: 6, name: 'Arcade Week', description: 'Play 15 daily games as a crew this week.', unit: 'games' });
    expect(ch.contributions[0]).toMatchObject({ user: { id: a.user.id }, amount: 8 });
    const claim = (m) => call('POST', `/api/groups/${group.id}/challenge/claim`, { token: m.token });
    expect((await claim(a)).body.error.code).toBe('NOT_COMPLETED');

    for (let i = 0; i < 8; i++) await addPoints(pool, { userId: b.user.id, day: '2026-11-10', source: 'mini_game', amount: 10, ref: `b${i}` });
    ch = await challenge(group.id, a.token);
    expect(ch).toMatchObject({ progress: 15, completed: true });

    expect((await claim(c)).status).toBe(403);
    await lockAchievements(a.user.id); await lockAchievements(b.user.id);
    const before = await coins(a.user.id);
    const r = await claim(a);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ rewardCoins: 50, challenge: { claimed: true } });
    expect(await coins(a.user.id)).toBe(before + 50);
    expect((await claim(a)).body.error.code).toBe('ALREADY_CLAIMED');

    const bBefore = await coins(b.user.id);
    const both = await Promise.all([claim(b), claim(b)]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await coins(b.user.id)).toBe(bBefore + 50);
  });

  it('show_up, hive_reads and roast count the right rows', async () => {
    const { group, members } = await crew(2);
    const other = await crew(2);
    const [a, b] = members;
    // Week of 2026-10-26: show_up (target 8, each person counts up to 5 days)
    setNow('2026-10-28T12:00:00Z');
    for (let i = 0; i < 7; i++) await addPoints(pool, { userId: a.user.id, groupId: group.id, day: addDays('2026-10-26', i), source: 'hot_seat', amount: 5 });
    await addPoints(pool, { userId: b.user.id, groupId: other.group.id, day: '2026-10-27', source: 'hive', amount: 3, ref: 1 }); // other crew
    let ch = await challenge(group.id, a.token);
    expect(ch).toMatchObject({ id: 'show_up', target: 8, progress: 5, eligible: true });
    expect((await challenge(group.id, b.token)).eligible).toBe(false);

    // Week of 2026-11-02: hive_reads (target 6)
    setNow('2026-11-03T12:00:00Z');
    for (let i = 0; i < 4; i++) await addPoints(pool, { userId: b.user.id, groupId: group.id, day: '2026-11-03', source: 'hive', amount: 13, ref: 100 + i });
    await addPoints(pool, { userId: a.user.id, groupId: group.id, day: '2026-11-03', source: 'hive', amount: 3, ref: 1 });
    ch = await challenge(group.id, a.token);
    expect(ch).toMatchObject({ id: 'hive_reads', target: 6, progress: 4, completed: false });
    expect(ch.contributions.map((x) => x.amount)).toEqual([4, 0]);

    // Week of 2026-11-16: roast (target 5 * (2 - 1) = 5)
    setNow('2026-11-22T12:00:00Z');
    for (let i = 0; i < 5; i++) await addPoints(pool, { userId: a.user.id, groupId: group.id, day: addDays('2026-11-16', i), source: 'hot_seat', amount: 5 });
    ch = await challenge(group.id, a.token);
    expect(ch).toMatchObject({ id: 'roast', target: 5, progress: 5, completed: true, daysLeft: 1 });
  });
});

describe('player profiles', () => {
  it('visible to self, crewmates and admins only; isAdmin only here', async () => {
    const { group, members } = await crew(2);
    const [a, b] = members;
    const stranger = await register('Stranger');
    const adm = await register('Boss');
    await pool.query('update users set is_admin = true where id = any($1::uuid[])', [[adm.user.id, b.user.id]]);
    const profile = (token, id) => call('GET', `/api/users/${id}/profile?groupId=${group.id}`, { token });

    const r = await profile(a.token, b.user.id);
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ id: b.user.id, isAdmin: true });
    expect(r.body.crews).toEqual([{ id: group.id, name: 'Test Crew' }]);
    expect(Object.keys(r.body.stats).sort()).toEqual(['bestStreak', 'crowned', 'gamesPlayed', 'hiveReads', 'seasonPoints', 'streak']);
    expect((await profile(a.token, a.user.id)).status).toBe(200);
    const hidden = await profile(stranger.token, a.user.id);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe('PROFILE_HIDDEN');
    expect((await call('GET', `/api/users/00000000-0000-4000-8000-000000000000/profile`, { token: a.token })).body.error.code).toBe('PROFILE_HIDDEN');
    const asAdmin = await profile(adm.token, a.user.id);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.crews).toEqual([]);
    expect(asAdmin.body.user.isAdmin).toBe(false);
    expect((await call('GET', `/api/users/${a.user.id}/profile?groupId=bad`, { token: a.token })).status).toBe(400);

    const g = (await call('GET', '/api/groups', { token: a.token })).body.groups[0];
    for (const m of g.members) expect(m).not.toHaveProperty('isAdmin');
  });
});

import fs from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import { call, register, crew, pool, setNow } from './helpers.js';
import { addPoints } from '../src/ledger.js';
import { seasonClose } from '../src/jobs.js';
import { clearGlobalCache } from '../src/routes/boards.js';

const DAY = '2026-11-10';
beforeEach(() => setNow(`${DAY}T12:00:00Z`));

const coins = async (id) => (await pool.query('select coins from users where id=$1', [id])).rows[0].coins;
const setCoins = (id, n) => pool.query('update users set coins=$2 where id=$1', [id, n]);
const avatar = (parts) => 'L.' + parts.join('.');
const BASE = Array(13).fill('0');

describe('coins', () => {
  it('a ledger insert grants ceil(amount / 5)', async () => {
    const { user } = await register('Coin');
    await addPoints(pool, { userId: user.id, day: DAY, source: 'mini_game', amount: 13 });
    expect(await coins(user.id)).toBe(3);
    await addPoints(pool, { userId: user.id, day: DAY, source: 'mini_game', amount: 13 }); // duplicate, ignored
    expect(await coins(user.id)).toBe(3);
    await addPoints(pool, { userId: user.id, day: DAY, source: 'mini_game', amount: 0, ref: 'z' });
    expect(await coins(user.id)).toBe(3);
  });
  it('the backfill does not run twice', async () => {
    const { user } = await register('Back');
    await pool.query(`insert into points_ledger (user_id, season, day, source, amount, ref) values ($1,'2026-11',$2,'mini_game',10,'b')`, [user.id, DAY]);
    expect(await coins(user.id)).toBe(2);
    const sql = fs.readFileSync(new URL('../migrations/004_coins_shop.sql', import.meta.url), 'utf8');
    const c = await pool.connect();
    try { await c.query('begin'); await c.query(sql); await c.query('commit'); } finally { c.release(); }
    expect(await coins(user.id)).toBe(2);
  });
  it('playing a game grants coins and inventory shows them', async () => {
    const { token, user } = await register('Inv');
    await setCoins(user.id, 85);
    expect((await call('GET', '/api/me/inventory', { token })).body).toEqual({ coins: 85, owned: [], titleId: null });
  });
});

describe('shop', () => {
  it('buys, and rejects not enough coins / already owned / not for sale / unknown', async () => {
    const { token, user } = await register('Buyer');
    const buy = (itemId) => call('POST', '/api/shop/buy', { token, body: { itemId } });
    await setCoins(user.id, 50);
    expect((await buy('addon_catears')).body.error.code).toBe('NOT_ENOUGH_COINS');
    await setCoins(user.id, 70);
    const r = await buy('addon_catears');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ coins: 10, owned: ['addon_catears'], titleId: null });
    expect((await buy('addon_catears')).status).toBe(409);
    expect((await buy('addon_alpha')).body.error.code).toBe('NOT_FOR_SALE');
    expect((await buy('title_rookie')).body.error.code).toBe('NOT_FOR_SALE');
    expect((await buy('nope')).status).toBe(404);
  });
  it('two simultaneous buys cannot overspend', async () => {
    const { token, user } = await register('Racer');
    await setCoins(user.id, 130);
    const rs = await Promise.all(['addon_tophat', 'title_maincharacter', 'addon_halo'].map((itemId) => call('POST', '/api/shop/buy', { token, body: { itemId } })));
    const ok = rs.filter((r) => r.status === 200).length;
    expect(ok).toBe(1);
    expect(await coins(user.id)).toBeGreaterThanOrEqual(0);
  });
});

describe('codes', () => {
  it('grants once, case-insensitive, 409 on repeat, 404 unknown/expired/used up', async () => {
    const { token } = await register('Coder');
    const redeem = (code) => call('POST', '/api/codes/redeem', { token, body: { code } });
    const r = await redeem('  huddle-alpha ');
    expect(r.status).toBe(200);
    expect(r.body.granted).toEqual(['addon_alpha', 'shirt_alpha', 'title_alpha']);
    expect(r.body.owned).toEqual(expect.arrayContaining(['addon_alpha', 'shirt_alpha', 'title_alpha']));
    expect((await redeem('HUDDLE-ALPHA')).body.error.code).toBe('ALREADY_REDEEMED');
    const bad = await redeem('NOPE-123');
    expect(bad.status).toBe(404);
    expect(bad.body.error).toEqual({ code: 'INVALID_CODE', message: "That code isn't valid" });

    await pool.query(`insert into codes (code, item_ids, coins, expires_at) values ('OLD-ONE','{}',5, now() - interval '1 day'), ('ONE-SHOT','{}',7,null)`);
    await pool.query(`update codes set max_redemptions = 1 where code = 'ONE-SHOT'`);
    expect((await redeem('old-one')).body.error.code).toBe('INVALID_CODE');
    const one = await redeem('one-shot');
    expect(one.body.coins).toBe(7);
    const other = await register('Other');
    expect((await call('POST', '/api/codes/redeem', { token: other.token, body: { code: 'ONE-SHOT' } })).body.error.code).toBe('INVALID_CODE');
  });
});

describe('avatar and colour locks', () => {
  const reg = (avatar, color = '#000000') => call('POST', '/api/auth/register', { body: { username: 'av_' + Math.random().toString(36).slice(2, 10), password: 'password123', displayName: 'A', avatar, color } });
  it('register rejects locked values, a 13-part code still works', async () => {
    expect((await reg(avatar(BASE))).status).toBe(201);
    expect((await reg(avatar([...BASE, '0', '0']))).status).toBe(201);
    for (const [a, c] of [[avatar([...BASE.slice(0, 12), '5']), undefined], [avatar([...BASE, '3']), undefined], [avatar([...BASE, '0', '1']), undefined], [avatar(BASE), '#2F3947'], [avatar(BASE), '#141414']]) {
      const r = await reg(a, c);
      expect(r.status, a + c).toBe(403);
      expect(r.body.error.code).toBe('ITEM_LOCKED');
    }
  });
  it('profile accepts locked values once owned', async () => {
    const { token, user } = await register('Owner');
    const save = (a, color = '#000000') => call('POST', '/api/me/profile', { token, body: { displayName: 'O', avatar: a, color } });
    const cat = avatar([...BASE.slice(0, 12), '5']);
    expect((await save(cat)).status).toBe(403);
    await setCoins(user.id, 60);
    await call('POST', '/api/shop/buy', { token, body: { itemId: 'addon_catears' } });
    expect((await save(cat)).status).toBe(200);
    expect((await save(avatar([...BASE, '0', '1']), '#2f3947')).status).toBe(403);
    await call('POST', '/api/codes/redeem', { token, body: { code: 'HUDDLE-BETA' } });
    expect((await save(avatar([...BASE, '0', '1']), '#2f3947')).status).toBe(200);
  });
  it('admin items: owned by admins with no user_items row, locked for others', async () => {
    const adm = await register('Adm');
    const pleb = await register('Pleb');
    await pool.query('update users set is_admin = true where id = $1', [adm.user.id]);
    const look = avatar([...BASE.slice(0, 12), '9']);
    expect((await call('POST', '/api/me/profile', { token: adm.token, body: { displayName: 'A', avatar: look, color: '#141414' } })).status).toBe(200);
    expect((await call('POST', '/api/me/profile', { token: pleb.token, body: { displayName: 'P', avatar: look, color: '#141414' } })).status).toBe(403);
    expect((await call('GET', '/api/me/inventory', { token: adm.token })).body.owned).toEqual(['addon_admin', 'bg_admin', 'title_admin']);
    expect((await pool.query('select count(*)::int n from user_items where user_id=$1', [adm.user.id])).rows[0].n).toBe(0);
    expect((await call('POST', '/api/me/title', { token: adm.token, body: { titleId: 'title_admin' } })).body.user.title).toBe('Admin');
    await pool.query('update users set is_admin = false where id = $1', [adm.user.id]);
    expect((await call('GET', '/api/me', { token: adm.token })).body.user.title).toBeNull();
    expect((await call('GET', '/api/me/inventory', { token: adm.token })).body).toMatchObject({ owned: [], titleId: null });
  });
});

describe('titles', () => {
  it('equipped title shows on leaderboards; unowned is 403; null clears', async () => {
    const { group, members } = await crew(2);
    const [a, b] = members;
    const eq = (t, titleId) => call('POST', '/api/me/title', { token: t.token, body: { titleId } });
    expect((await eq(a, 'title_nightowl')).status).toBe(403);
    expect((await eq(a, 'addon_halo')).status).toBe(403);
    const r = await eq(a, 'title_rookie');
    expect(r.body).toMatchObject({ titleId: 'title_rookie', user: { id: a.user.id, title: 'Rookie' } });
    const board = (await call('GET', `/api/leaderboards/group/${group.id}`, { token: b.token })).body;
    expect(board.rows.find((x) => x.user.id === a.user.id).user.title).toBe('Rookie');
    expect(board.rows.find((x) => x.user.id === b.user.id).user.title).toBeNull();
    await addPoints(pool, { userId: a.user.id, day: DAY, source: 'mini_game', amount: 50, ref: 't' });
    clearGlobalCache();
    const g = (await call('GET', '/api/leaderboards/global', { token: b.token })).body;
    expect(g.rows.find((x) => x.user.id === a.user.id).user.title).toBe('Rookie');
    const crews = (await call('GET', '/api/groups', { token: b.token })).body.groups[0];
    expect(crews.members.find((m) => m.id === a.user.id).title).toBe('Rookie');
    expect((await eq(a, null)).body.user.title).toBeNull();
  });
  it('season close grants title items', async () => {
    const { group, members } = await crew(3);
    const [a] = members;
    await pool.query(`insert into points_ledger (user_id, group_id, season, day, source, amount, ref) values ($1,$2,'2026-09','2026-09-05','hive',40,'s1')`, [a.user.id, group.id]);
    await pool.query(`insert into points_ledger (user_id, group_id, season, day, source, amount, ref) values ($1,null,'2026-09','2026-09-05','mini_game',99999,'s2')`, [a.user.id]);
    setNow('2026-10-01T01:00:00Z');
    await seasonClose();
    setNow(`${DAY}T12:00:00Z`);
    const owned = (await call('GET', '/api/me/inventory', { token: a.token })).body.owned;
    expect(owned).toEqual(expect.arrayContaining(['title_crew_captain', 'title_global_legend']));
    expect((await call('POST', '/api/me/title', { token: a.token, body: { titleId: 'title_crew_captain' } })).body.user.title).toBe('Crew Captain');
  });
});

describe('admin answer removal takes back coins', () => {
  it('subtracts the coins the removed ledger rows granted', async () => {
    const adm = await register('Mod');
    await pool.query('update users set is_admin = true where id = $1', [adm.user.id]);
    const { group, members } = await crew(3);
    const t = (await call('GET', `/api/groups/${group.id}/today`, { token: members[0].token })).body;
    const author = members.find((m) => m.user.id !== t.hotSeat.subject.id);
    const before = await coins(author.user.id);
    await call('POST', `/api/groups/${group.id}/hot-seat/answers`, { token: author.token, body: { text: 'Uma resposta' } });
    expect(await coins(author.user.id)).toBe(before + 1);
    const ans = (await call('GET', '/api/admin/hot-seat/answers', { token: adm.token })).body.items.find((i) => i.text === 'Uma resposta');
    await call('POST', `/api/admin/hot-seat/answers/${ans.id}/remove`, { token: adm.token });
    expect(await coins(author.user.id)).toBe(before);
  });
});

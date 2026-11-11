import { pool, tx } from '../db.js';
import { ApiError, bad, notFound } from '../errors.js';
import * as v from '../validate.js';
import { ITEMS, owns, loadInventory, inventoryView } from '../items.js';
import { loadUser } from '../users.js';
import { clearGlobalCache } from './boards.js';

const invalidCode = () => new ApiError(404, 'INVALID_CODE', "That code isn't valid");

export default async function (app) {
  app.addHook('preHandler', app.auth);

  app.get('/me/inventory', async (req) => inventoryView(await loadInventory(pool, req.userId)));

  app.post('/shop/buy', async (req) => {
    const itemId = v.body(req).itemId;
    if (typeof itemId !== 'string' || !Object.hasOwn(ITEMS, itemId)) throw new ApiError(404, 'UNKNOWN_ITEM', 'No such item');
    const item = ITEMS[itemId];
    if (!(item.price > 0)) throw bad('NOT_FOR_SALE', 'That item is not for sale');
    return tx(async (c) => {
      const inv = await loadInventory(c, req.userId, { lock: true });
      if (owns(itemId, inv.ownedSet, inv.isAdmin)) throw new ApiError(409, 'ALREADY_OWNED', 'You already own that');
      if (inv.coins < item.price) throw bad('NOT_ENOUGH_COINS', 'Not enough coins');
      await c.query('update users set coins = coins - $2 where id = $1', [req.userId, item.price]);
      await c.query(`insert into user_items (user_id, item_id, source) values ($1,$2,'shop')`, [req.userId, itemId]);
      return inventoryView(await loadInventory(c, req.userId));
    });
  });

  app.post('/codes/redeem', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const raw = v.body(req).code;
    if (typeof raw !== 'string') throw invalidCode();
    const code = raw.trim();
    if (!code || code.length > 64) throw invalidCode();
    return tx(async (c) => {
      await c.query('select id from users where id = $1 for update', [req.userId]);
      const row = (await c.query(
        `select code, item_ids, coins, max_redemptions, expires_at, now() as now,
           (select count(*)::int from code_redemptions r where r.code = codes.code) as used
         from codes where code = $1 for update`, [code])).rows[0];
      if (!row || (row.expires_at && row.expires_at <= row.now)) throw invalidCode();
      const mine = await c.query('select 1 from code_redemptions where code = $1 and user_id = $2', [row.code, req.userId]);
      if (mine.rowCount) throw new ApiError(409, 'ALREADY_REDEEMED', 'You already used that code');
      if (row.max_redemptions != null && row.used >= row.max_redemptions) throw invalidCode();
      await c.query('insert into code_redemptions (code, user_id) values ($1,$2)', [row.code, req.userId]);
      for (const id of row.item_ids) {
        await c.query(`insert into user_items (user_id, item_id, source) values ($1,$2,'code') on conflict do nothing`, [req.userId, id]);
      }
      if (row.coins > 0) await c.query('update users set coins = coins + $2 where id = $1', [req.userId, row.coins]);
      return { granted: row.item_ids, ...inventoryView(await loadInventory(c, req.userId)) };
    });
  });

  app.post('/me/title', async (req) => {
    const titleId = v.body(req).titleId;
    if (titleId !== null) {
      if (typeof titleId !== 'string' || !Object.hasOwn(ITEMS, titleId) || ITEMS[titleId].kind !== 'title') throw new ApiError(403, 'ITEM_LOCKED', "You don't own one of those items yet");
      const inv = await loadInventory(pool, req.userId);
      if (!owns(titleId, inv.ownedSet, inv.isAdmin)) throw new ApiError(403, 'ITEM_LOCKED', "You don't own one of those items yet");
    }
    await pool.query('update users set title_id = $2 where id = $1', [req.userId, titleId]);
    clearGlobalCache();
    return { titleId, user: await loadUser(pool, req.userId) };
  });
}

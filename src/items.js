// Item catalogue: the authority for prices and locks. price: number = shop price (0 = everyone owns it),
// null = not for sale. how: 'shop' | 'code' | 'admin' | 'free' | 'season' | 'achievement'.
const I = (id, kind, price, how, extra = {}) => ({ id, kind, price, how, ...extra });

export const ITEMS = Object.fromEntries([
  I('addon_catears', 'addon', 60, 'shop'),
  I('addon_halo', 'addon', 80, 'shop'),
  I('shirt_hoodie', 'shirt', 90, 'shop'),
  I('addon_tophat', 'addon', 120, 'shop'),
  I('addon_alpha', 'addon', null, 'code'),
  I('shirt_alpha', 'shirt', null, 'code'),
  I('style_beta', 'style', null, 'code'),
  I('bg_beta', 'bg', null, 'code', { color: '#2f3947' }),
  I('addon_admin', 'addon', null, 'admin'),
  I('bg_admin', 'bg', null, 'admin', { color: '#141414' }),
  I('title_rookie', 'title', 0, 'free', { text: 'Rookie' }),
  I('title_nightowl', 'title', 40, 'shop', { text: 'Night Owl' }),
  I('title_arcaderat', 'title', 60, 'shop', { text: 'Arcade Rat' }),
  I('title_memelord', 'title', 80, 'shop', { text: 'Meme Lord' }),
  I('title_roastmaster', 'title', 100, 'shop', { text: 'Roast Master' }),
  I('title_hivewhisperer', 'title', 120, 'shop', { text: 'Hive Whisperer' }),
  I('title_maincharacter', 'title', 150, 'shop', { text: 'Main Character' }),
  I('title_alpha', 'title', null, 'code', { text: 'Alpha Player' }),
  I('title_admin', 'title', null, 'admin', { text: 'Admin' }),
  I('title_crew_captain', 'title', null, 'season', { text: 'Crew Captain' }),
  I('title_first_mate', 'title', null, 'season', { text: 'First Mate' }),
  I('title_deckhand', 'title', null, 'season', { text: 'Deckhand' }),
  I('title_global_legend', 'title', null, 'season', { text: 'Global Legend' }),
  I('title_global_ace', 'title', null, 'season', { text: 'Global Ace' }),
  I('title_global_contender', 'title', null, 'season', { text: 'Global Contender' }),
  I('title_onfire', 'title', null, 'achievement', { text: 'On Fire' }),
  I('title_unstoppable', 'title', null, 'achievement', { text: 'Unstoppable' }),
  I('title_flawless', 'title', null, 'achievement', { text: 'Flawless' }),
  I('title_gamemaster', 'title', null, 'achievement', { text: 'Game Master' }),
  I('title_mindreader', 'title', null, 'achievement', { text: 'Mind Reader' }),
  I('title_roastchamp', 'title', null, 'achievement', { text: 'Roast Champion' }),
  I('title_allrounder', 'title', null, 'achievement', { text: 'All-Rounder' }),
  I('title_podium', 'title', null, 'achievement', { text: 'Podium Regular' }),
  I('title_teamplayer', 'title', null, 'achievement', { text: 'Team Player' }),
].map((i) => [i.id, i]));

export const ADMIN_ITEMS = Object.values(ITEMS).filter((i) => i.how === 'admin').map((i) => i.id);
export const SEASON_TITLES = {
  group: { 1: 'title_crew_captain', 2: 'title_first_mate', 3: 'title_deckhand' },
  global: { 1: 'title_global_legend', 2: 'title_global_ace', 3: 'title_global_contender' },
};

// ownedSet: the user's user_items ids. isAdmin: users.is_admin.
export function owns(itemId, ownedSet, isAdmin) {
  const it = ITEMS[itemId];
  if (!it) return false;
  if (it.price === 0) return true;
  if (it.how === 'admin') return isAdmin === true;
  return ownedSet.has(itemId);
}

export function titleText(titleId, ownedSet, isAdmin) {
  const it = titleId && ITEMS[titleId];
  if (!it || it.kind !== 'title' || !owns(titleId, ownedSet, isAdmin)) return null;
  return it.text;
}

// Avatar part locks: [partIndex, value, itemId]
const PART_LOCKS = [
  [12, 5, 'addon_catears'], [12, 6, 'addon_halo'], [12, 7, 'addon_tophat'], [12, 8, 'addon_alpha'], [12, 9, 'addon_admin'],
  [13, 3, 'shirt_hoodie'], [13, 4, 'shirt_alpha'],
  [14, 1, 'style_beta'],
];
const COLOR_LOCKS = { '#2f3947': 'bg_beta', '#141414': 'bg_admin' };

// Items the given avatar + colour need.
export function requiredItems(avatar, color) {
  const need = [];
  if (typeof avatar === 'string' && avatar.startsWith('L.')) {
    const parts = avatar.slice(2).split('.').map((p) => parseInt(p, 36));
    for (const [idx, val, item] of PART_LOCKS) if ((parts[idx] || 0) === val) need.push(item);
  }
  const c = typeof color === 'string' && COLOR_LOCKS[color.toLowerCase()];
  if (c) need.push(c);
  return need;
}

// Loads what a user owns. Returns { coins, ownedSet, isAdmin, titleId }.
export async function loadInventory(db, userId, { lock = false } = {}) {
  const u = (await db.query(`select coins, is_admin, title_id from users where id = $1 ${lock ? 'for update' : ''}`, [userId])).rows[0];
  const items = (await db.query('select item_id from user_items where user_id = $1 order by created_at, item_id', [userId])).rows.map((r) => r.item_id);
  return { coins: u.coins, isAdmin: u.is_admin, titleId: u.title_id, ownedSet: new Set(items), items };
}

export function inventoryView(inv) {
  const owned = [...inv.items];
  if (inv.isAdmin) for (const id of ADMIN_ITEMS) if (!owned.includes(id)) owned.push(id);
  const titleId = inv.titleId && titleText(inv.titleId, inv.ownedSet, inv.isAdmin) ? inv.titleId : null;
  return { coins: inv.coins, owned, titleId };
}

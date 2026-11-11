import { prevSeason, seasonOf, today } from './time.js';
import { titleText } from './items.js';

const FRAMES = { 1: 'gold', 2: 'silver', 3: 'bronze' };

export const toPublic = (r) => ({
  id: r.id, displayName: r.display_name, avatar: r.avatar, color: r.color, frame: FRAMES[r.best_rank] || null,
  title: titleText(r.title_id, new Set(r.title_owned ? [r.title_id] : []), r.is_admin),
});

// Returns Map<id, UserPublic>
export async function loadUsers(db, ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const { rows } = await db.query(
    `select u.id, u.display_name, u.avatar, u.color, u.title_id, u.is_admin,
       exists (select 1 from user_items i where i.user_id = u.id and i.item_id = u.title_id) as title_owned,
       (select min(rank) from season_rewards r where r.user_id = u.id and r.season = $2) as best_rank
     from users u where u.id = any($1::uuid[])`,
    [uniq, prevSeason(seasonOf(today()))]
  );
  return new Map(rows.map((r) => [r.id, toPublic(r)]));
}
export async function loadUser(db, id) {
  return (await loadUsers(db, [id])).get(id) || null;
}

// The caller's own user object: UserPublic plus isAdmin. Never use this for other users.
export async function loadMe(db, id) {
  const u = await loadUser(db, id);
  if (!u) return null;
  const { rows } = await db.query('select is_admin from users where id = $1', [id]);
  return { ...u, isAdmin: rows[0]?.is_admin === true };
}

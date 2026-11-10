import { seasonOf } from './time.js';

export async function addPoints(db, { userId, groupId = null, day, source, amount, ref = null }) {
  await db.query(
    `insert into points_ledger (user_id, group_id, season, day, source, amount, ref)
     values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
    [userId, groupId, seasonOf(day), day, source, amount, ref == null ? null : String(ref)]
  );
}

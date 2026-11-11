import { pool, tx } from '../db.js';
import { ApiError, bad, notFound } from '../errors.js';
import { assertMember } from './groups.js';
import * as v from '../validate.js';
import { today, seasonOf, daysLeft } from '../time.js';
import { addPoints } from '../ledger.js';
import { safeSync } from '../achievements.js';
import {
  ensureRound, lockRound, settleQuestion, buildHiveItem, buildHotSeat, roundUsers, miniGameFor, streakFor, miniKey, scoreMini,
} from '../game.js';

export default async function (app) {
  app.addHook('preHandler', app.auth);

  app.get('/groups/:id/today', async (req) => {
    const gid = req.params.id;
    await assertMember(pool, gid, req.userId);
    const day = today();
    const round = await ensureRound(gid, day);
    const users = await roundUsers(pool, round);
    const [hive, hotSeat, miniGame, streak] = await Promise.all([
      Promise.all(round.hive_question_ids.map((q) => buildHiveItem(pool, round, q, req.userId, users))),
      buildHotSeat(pool, round, req.userId, users),
      miniGameFor(pool, req.userId, day),
      streakFor(pool, req.userId, day),
    ]);
    return {
      date: day, season: seasonOf(day), daysLeft: daysLeft(day), streak,
      members: round.member_ids.map((id) => users.get(id)).filter(Boolean),
      hive, hotSeat, miniGame,
    };
  });

  app.post('/groups/:id/hive/:questionId', async (req) => {
    const gid = req.params.id;
    await assertMember(pool, gid, req.userId);
    const qid = Number(req.params.questionId);
    const b = v.body(req);
    const { votedUserId, predictedUserId } = b;
    if (typeof votedUserId !== 'string' || typeof predictedUserId !== 'string') throw bad('VALIDATION_ERROR', 'votedUserId and predictedUserId are required');
    const day = today();
    await ensureRound(gid, day);
    const out = await tx(async (c) => {
      const round = await lockRound(c, gid, day);
      if (!Number.isInteger(qid) || !round.hive_question_ids.includes(qid)) throw notFound('That question is not in today\'s round');
      if (!round.member_ids.includes(req.userId)) throw new ApiError(403, 'NOT_IN_ROUND', 'You joined after today\'s round started');
      if (!round.member_ids.includes(votedUserId) || !round.member_ids.includes(predictedUserId)) throw bad('INVALID_MEMBER', 'Pick someone from today\'s round');
      const ins = await c.query(
        `insert into hive_votes (group_id, day, question_id, voter_id, voted_user_id, predicted_user_id)
         values ($1,$2,$3,$4,$5,$6) on conflict do nothing`, [gid, day, qid, req.userId, votedUserId, predictedUserId]);
      if (!ins.rowCount) throw new ApiError(409, 'ALREADY_VOTED', 'You already voted on this one');
      const n = (await c.query('select count(*)::int n from hive_votes where group_id=$1 and day=$2 and question_id=$3', [gid, day, qid])).rows[0].n;
      if (n >= round.member_ids.length) await settleQuestion(c, gid, day, qid);
      const users = await roundUsers(c, round);
      return { question: await buildHiveItem(c, round, qid, req.userId, users), members: round.member_ids };
    });
    // Settling can pay everyone who voted, so sync the whole round.
    await safeSync(req.log, req.userId, ...out.members);
    return { question: out.question };
  });

  app.post('/groups/:id/hot-seat/answers', async (req) => {
    const gid = req.params.id;
    await assertMember(pool, gid, req.userId);
    const text = v.cleanText(v.body(req).text, 2, 140);
    const day = today();
    await ensureRound(gid, day);
    const out = await tx(async (c) => {
      const round = await lockRound(c, gid, day);
      if (round.hot_seat_subject_id === req.userId) throw new ApiError(403, 'IS_SUBJECT', 'You\'re in the hot seat today');
      const ins = await c.query(
        `insert into hot_seat_answers (group_id, day, author_id, text) values ($1,$2,$3,$4) on conflict do nothing returning id`,
        [gid, day, req.userId, text]);
      if (!ins.rowCount) throw new ApiError(409, 'ALREADY_ANSWERED', 'You already answered today');
      await addPoints(c, { userId: req.userId, groupId: gid, day, source: 'hot_seat', amount: 5, ref: ins.rows[0].id });
      return { hotSeat: await buildHotSeat(c, round, req.userId, await roundUsers(c, round)) };
    });
    await safeSync(req.log, req.userId);
    return out;
  });

  app.post('/groups/:id/hot-seat/favorite', async (req) => {
    const gid = req.params.id;
    await assertMember(pool, gid, req.userId);
    const answerId = v.body(req).answerId;
    if (typeof answerId !== 'string' || !v.UUID_RE.test(answerId)) throw bad('VALIDATION_ERROR', 'answerId is required');
    const day = today();
    await ensureRound(gid, day);
    let author = null;
    const out = await tx(async (c) => {
      const round = await lockRound(c, gid, day);
      if (round.hot_seat_subject_id !== req.userId) throw new ApiError(403, 'NOT_SUBJECT', 'Only the person in the hot seat can crown an answer');
      const ans = (await c.query('select id, author_id from hot_seat_answers where id=$1 and group_id=$2 and day=$3', [answerId, gid, day])).rows[0];
      if (!ans) throw notFound('Answer not found');
      const ins = await c.query('insert into hot_seat_favorites (group_id, day, answer_id) values ($1,$2,$3) on conflict do nothing', [gid, day, answerId]);
      if (!ins.rowCount) throw new ApiError(409, 'ALREADY_CROWNED', 'You already crowned an answer today');
      await addPoints(c, { userId: ans.author_id, groupId: gid, day, source: 'hot_seat_crowned', amount: 25, ref: answerId });
      await addPoints(c, { userId: req.userId, groupId: gid, day, source: 'hot_seat_judge', amount: 5, ref: answerId });
      author = ans.author_id;
      return { hotSeat: await buildHotSeat(c, round, req.userId, await roundUsers(c, round)) };
    });
    await safeSync(req.log, author, req.userId);
    return out;
  });

  app.post('/minigames/submit', async (req) => {
    const { gameKey, date, raw } = v.body(req);
    const day = today();
    if (date !== day || gameKey !== miniKey(day)) throw bad('GAME_EXPIRED', 'That game has expired');
    const points = scoreMini(gameKey, raw);
    if (points == null) throw bad('INVALID_RAW', 'Malformed game result');
    const out = await tx(async (c) => {
      const ins = await c.query(
        'insert into mini_game_plays (user_id, day, game_key, raw, points) values ($1,$2,$3,$4,$5) on conflict do nothing',
        [req.userId, day, gameKey, JSON.stringify(raw), points]);
      if (!ins.rowCount) throw new ApiError(409, 'ALREADY_PLAYED', 'Already played today');
      await addPoints(c, { userId: req.userId, groupId: null, day, source: 'mini_game', amount: points });
      if (gameKey === 'reaction' && raw.avgMs < 120) req.log.warn({ userId: req.userId, raw }, 'suspicious reaction time');
      if (gameKey === 'memory' && (raw.moves < 8 || raw.ms < 3000)) req.log.warn({ userId: req.userId, raw }, 'impossible memory result');
      return { points };
    });
    await safeSync(req.log, req.userId);
    return out;
  });
}

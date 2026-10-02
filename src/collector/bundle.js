// アプリに渡す実データ一式（バンドル）を組み立てる。
//   過去：結果の確定したレース（レース前時点の出馬表＋着順＋払戻）
//   当日・これから：JRAの出馬表（前4走・単勝オッズ）。発走後は結果を取りにいく

import { listCardMeetings, listRecentResultMeetings, listRaces, fetchCard, fetchResult, fetchOdds, cardToRace, resultToRecord } from './collect.js';
import { raceKeyFromCname, CODE_BY_COURSE } from './jra.js';
import { preRaceCard, computeDayVariants } from '../data/history.js';
import { jstParts, startMs } from '../engine/raceTime.js';

export { jstParts, startMs, raceStatus } from '../engine/raceTime.js';

export const BUNDLE_VERSION = 1;
const MIN = 60 * 1000;

export function emptyBundle() {
  return { version: BUNDLE_VERSION, source: 'JRA', generatedAt: null, days: [] };
}

function upsertRace(bundle, race) {
  let day = bundle.days.find((d) => d.date === race.date);
  if (!day) {
    day = { date: race.date, races: [] };
    bundle.days.push(day);
  }
  const i = day.races.findIndex((r) => r.id === race.id);
  if (i >= 0) day.races[i] = { ...day.races[i], ...race };
  else day.races.push(race);
  return day.races[i >= 0 ? i : day.races.length - 1];
}

function sortBundle(bundle) {
  bundle.days.sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const d of bundle.days) {
    // 競馬場は JRA の場コード順（東京・中山 → 中京・京都・阪神 …）
    const code = (r) => r.courseCode || CODE_BY_COURSE[r.course] || '99';
    d.races.sort((a, b) => code(a).localeCompare(code(b)) || a.raceNo - b.raceNo);
    d.venues = [...new Set(d.races.map((r) => r.course))];
  }
}

/** 結果の記録をバンドルのレースに付ける */
function attachResult(race, record) {
  race.result = record.runners
    .filter((r) => r.finish > 0)
    .sort((a, b) => a.finish - b.finish || a.number - b.number)
    .map((r) => r.number);
  race.finishes = Object.fromEntries(record.runners.map((r) => [r.number, r.finish || r.status || 0]));
  race.resultRows = record.runners.map((r) => ({
    number: r.number,
    finish: r.finish,
    status: r.status,
    time: r.time,
    margin: r.margin,
    marginText: r.marginText,
    passing: r.passing,
    last3f: r.last3f,
    popularity: r.popularity,
    odds: r.odds,
  }));
  race.payouts = record.payouts;
  race.going = record.going || race.going;
  race.weather = record.weather || race.weather;
  // 最終オッズで出馬表のオッズを更新（取消馬は残す）
  const finalOdds = new Map(record.runners.map((r) => [r.number, r]));
  for (const e of race.entries) {
    const r = finalOdds.get(e.number);
    if (r?.odds) e.odds = r.odds;
    if (r?.popularity) e.popularity = r.popularity;
    if (r?.placeMin > 1) {
      e.placeMin = r.placeMin;
      e.placeMax = r.placeMax;
    }
    if (r && r.finish === 0 && /取消|除外/.test(r.status || '')) e.scratched = true;
    if (r?.bodyWeight && !e.bodyWeight) {
      e.bodyWeight = r.bodyWeight;
      e.bodyWeightDiff = r.bodyWeightDiff;
    }
  }
  race.status = 'result';
}

/** 収集済みの過去データ（data/history）から、指定した開催日のレースを作る */
export function addPastDaysFromHistory(bundle, records, index, dates) {
  const set = new Set(dates);
  for (const rec of records) {
    if (!set.has(rec.date)) continue;
    const race = preRaceCard(rec, index);
    delete race.finishes;
    race.status = 'result';
    const added = upsertRace(bundle, race);
    attachResult(added, rec);
  }
  sortBundle(bundle);
}

/** 出馬表（オッズ）を取り直す間隔：発走が近いほど短く */
export function cardTtl(race, now) {
  const st = race ? startMs(race) : null;
  if (!st) return 10 * MIN;
  const until = st - now;
  if (until <= 0) return 3 * MIN; // 発走後：締切時点のオッズを一度取り直す
  if (until <= 60 * MIN) return 2 * MIN;
  if (until <= 3 * 60 * MIN) return 10 * MIN;
  return 30 * MIN;
}

/**
 * JRAから最新の出馬表・オッズと、発走後のレースの結果を取ってきてバンドルを更新する。
 * onRecord：結果が確定したレースの記録（data/history と同じ形）を受け取る
 * onOdds：新しく取得したオッズ（出馬表）を受け取る（オッズの推移の記録用）
 */
export async function refreshLive(client, bundle, { now = Date.now(), log = () => {}, onRecord = null, onOdds = null } = {}) {
  let cards = 0;
  let results = 0;
  const meetings = await listCardMeetings(client);
  for (const meeting of meetings) {
    const links = await listRaces(client, meeting, { live: true });
    for (const link of links) {
      if (!link.cardCname) continue;
      const known = bundle.days.find((d) => d.date === link.date)?.races.find((r) => r.id === link.raceId);
      if (known?.status === 'result') continue;
      const st = known ? startMs(known) : null;
      // 発走から30分以上たったら出馬表はもう取りにいかない（結果待ち）
      if (st && now - st > 30 * MIN && known.oddsAt && Date.parse(known.oddsAt) > st) continue;
      try {
        const ttl = cardTtl(known, now);
        const card = await fetchCard(client, link.cardCname, ttl);
        const race = cardToRace(card, raceKeyFromCname(link.cardCname));
        race.cardCname = link.cardCname;
        // 発走2時間前からは、単勝・複勝のオッズのページも取る（複勝オッズは出馬表にない）
        const st2 = startMs(race);
        if (card.oddsCname && st2 && st2 - now < 2 * 60 * MIN && now - st2 < 30 * MIN) {
          try {
            const o = await fetchOdds(client, card.oddsCname, { ttlMs: ttl });
            const by = new Map(o.odds.map((x) => [x.number, x]));
            for (const e of race.entries) {
              const x = by.get(e.number);
              if (!x) continue;
              if (x.odds > 1) e.odds = x.odds;
              e.placeMin = x.placeMin;
              e.placeMax = x.placeMax;
            }
          } catch (err) {
            log(`オッズの取得に失敗 ${link.raceId}: ${err.message}`);
          }
        }
        race.oddsAt = new Date(client.fetchedAt?.(link.cardCname) ?? now).toISOString();
        race.status = 'card';
        // キャッシュから読んだだけ（中身が同じ）なら更新に数えない
        const fresh = !known || known.oddsAt !== race.oddsAt;
        if (fresh) cards++;
        upsertRace(bundle, race);
        if (fresh && onOdds) await onOdds(race);
      } catch (e) {
        log(`出馬表の取得に失敗 ${link.raceId}: ${e.message}`);
      }
    }
  }

  // 発走から10分以上たったレースの結果
  const pending = bundle.days.flatMap((d) => d.races).filter((r) => r.status !== 'result' && startMs(r) && now - startMs(r) > 10 * MIN);
  if (pending.length) {
    const resultMeetings = await listRecentResultMeetings(client);
    const wanted = new Set(pending.map((r) => r.date));
    for (const m of resultMeetings.filter((x) => wanted.has(x.date))) {
      const links = await listRaces(client, m, { live: true });
      for (const link of links) {
        const race = pending.find((r) => r.id === link.raceId);
        if (!race || !link.resultCname) continue;
        try {
          const result = await fetchResult(client, link.resultCname, { live: true });
          // 払戻まで出そろってから取り込む
          if (!result.rows.length || !Object.keys(result.payouts || {}).length) continue;
          const odds = link.oddsCname ? await fetchOdds(client, link.oddsCname, { final: true }) : null;
          const record = resultToRecord(result, odds, raceKeyFromCname(link.resultCname));
          // オッズのページが取れなかったときは出馬表の最終オッズで補う
          for (const r of record.runners) if (r.odds == null) r.odds = race.entries.find((e) => e.number === r.number)?.odds ?? null;
          attachResult(race, record);
          results++;
          if (onRecord) await onRecord(record);
          log(`結果を取得 ${race.date} ${race.course}${race.raceNo}R`);
        } catch (e) {
          log(`結果の取得に失敗 ${link.raceId}: ${e.message}`);
        }
      }
    }
  }
  sortBundle(bundle);
  // generatedAt：データが変わった時刻（画面はこれで読み直しを判断）、checkedAt：最後に確認した時刻
  if (cards || results || !bundle.generatedAt) bundle.generatedAt = new Date(now).toISOString();
  bundle.checkedAt = new Date(now).toISOString();
  return { bundle, cards, results };
}

/** バンドルの確定したレースを、統計の計算に使える記録の形にする（馬場差の計算用） */
export function bundleRecords(bundle) {
  return bundle.days.flatMap((d) =>
    d.races
      .filter((r) => r.status === 'result' && r.resultRows?.length)
      .map((r) => ({
        id: r.id,
        date: r.date,
        course: r.course,
        surface: r.surface,
        distance: r.distance,
        going: r.going,
        grade: r.grade,
        jump: r.jump,
        runners: r.resultRows.map((x) => ({ number: x.number, finish: x.finish, time: x.time })),
      })),
  );
}

/**
 * 画面の予想に使う開催日ごとの馬場差を、バンドルに入れる。
 * 統計（REAL_STATS）を作ったあとの開催日の分だけを、同じ基準タイムで計算する。
 */
export function attachDayVariants(bundle, records, stats, { days = 150, today = jstParts().date } = {}) {
  if (!stats?.baseTimes || !Object.keys(stats.baseTimes).length) return bundle;
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  const all = computeDayVariants([...records, ...bundleRecords(bundle)], stats);
  const known = stats.dayVariant || {};
  // 前回までに計算した日の値も残す（バンドルから落ちた開催日の馬場差も、過去走の指数に使うため）
  const merged = { ...(bundle.dayVariant || {}), ...all };
  bundle.dayVariant = Object.fromEntries(Object.entries(merged).filter(([k]) => !(k in known) && k.slice(0, 10) >= cutoff));
  return bundle;
}

/** 前回のバンドルを引き継ぐ（結果のあるレース・まだ取り直していないレース） */
export function mergeBundle(bundle, previous) {
  if (!previous?.days) return bundle;
  if (previous.dayVariant) bundle.dayVariant = { ...previous.dayVariant, ...(bundle.dayVariant || {}) };
  for (const day of previous.days) {
    for (const race of day.races || []) {
      const cur = bundle.days.find((d) => d.date === race.date)?.races.find((r) => r.id === race.id);
      if (!cur || (race.status === 'result' && cur.status !== 'result')) upsertRace(bundle, race);
    }
  }
  sortBundle(bundle);
  return bundle;
}

// 画面でもエンジンでも使わない過去走の項目（data.json を小さくするため落とす）
const PAST_DROP = ['raceId', 'number', 'status', 'bodyWeight', 'winner'];

/** 画面に渡す前に、使わない項目を落とす */
export function compactBundle(bundle) {
  for (const d of bundle.days) for (const r of d.races) for (const e of r.entries) for (const p of e.past || []) for (const k of PAST_DROP) delete p[k];
  return bundle;
}

/** 古い開催日を落とす（結果のある日は keepPast 日分、これからの日はすべて残す） */
export function pruneBundle(bundle, { keepPast = 4, today = jstParts().date } = {}) {
  const past = bundle.days.filter((d) => d.date < today).map((d) => d.date);
  const drop = new Set(past.slice(0, Math.max(0, past.length - keepPast)));
  bundle.days = bundle.days.filter((d) => !drop.has(d.date));
  return bundle;
}

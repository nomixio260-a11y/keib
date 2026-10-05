// アプリに渡す実データ一式（バンドル）を組み立てる。
//   過去：結果の確定したレース（レース前時点の出馬表＋着順＋払戻）
//   当日・これから：JRAの出馬表（前4走・単勝オッズ）。発走後は結果を取りにいく

import { listCardMeetings, listRecentResultMeetings, listRaces, fetchCard, fetchResult, fetchOdds, cardToRace, resultToRecord, recordCoverage } from './collect.js';
import { raceKeyFromCname, CODE_BY_COURSE, parseOdds, parseOddsLinks, parseExoticOdds } from './jra.js';
import { preRaceCard, computeDayVariants } from '../data/history.js';
import { jstParts, startMs, NEAR_POST_MIN } from '../engine/raceTime.js';
export { NEAR_POST_MIN };

export { jstParts, startMs, raceStatus } from '../engine/raceTime.js';

export const BUNDLE_VERSION = 1;
const MIN = 60 * 1000;

export function emptyBundle() {
  return { version: BUNDLE_VERSION, source: 'JRA', generatedAt: null, days: [] };
}

export function upsertRace(bundle, race) {
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

export function sortBundle(bundle) {
  bundle.days.sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const d of bundle.days) {
    // 競馬場は JRA の場コード順（東京・中山 → 中京・京都・阪神 …）
    const code = (r) => r.courseCode || CODE_BY_COURSE[r.course] || '99';
    d.races.sort((a, b) => code(a).localeCompare(code(b)) || a.raceNo - b.raceNo);
    d.venues = [...new Set(d.races.map((r) => r.course))];
  }
}

/** バンドルのレースの結果が全頭そろっているか（出馬表の取消・除外を除いた頭数と比べる） */
export function resultComplete(race) {
  if (race.status !== 'result') return false;
  const rows = race.resultRows || [];
  if (!rows.length) return true;
  const have = rows.filter((r) => !(r.finish === 0 && /取消|除外/.test(r.status || ''))).length;
  const expected = (race.entries || []).filter((e) => !e.scratched).length;
  return !expected || have >= expected;
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

/**
 * 次の取り込みまでの目安（秒。Race day ワークフローの間隔）：深夜（JST 0〜7時）は 3600。今日のまだ確定していないレースが
 * 発走8分前〜発走のときは 60、発走20分前〜のときは 150（買う直前のオッズを新しくする。発走前のオッズで選ぶ推定では、買う時刻が
 * 発走に近いほど収支が良く、発走10分前に買うと最後の更新の約半分、60分前では損だった。README の開発日記 2026-10-06）、
 * 発走90分前〜結果待ちは 300、それ以外の今日と前日発売中（24時間以内に発走）は 1200、開催のない日は 3600。
 * JRA への取得は間隔に関係なく 1.2 秒に1回まで（発走8分前〜は、そのレースの出馬表とオッズのページだけが取り直しの対象になる：cardTtl）
 */
export function nextRefreshSec(bundle, { now = Date.now(), today = jstParts(now).date } = {}) {
  const all = bundle.days.flatMap((d) => d.races);
  const jstHour = new Date(now + 9 * 3600 * 1000).getUTCHours();
  if (jstHour < 7) return 3600;
  const pendingToday = all.filter((r) => r.date === today && r.status !== 'result');
  if (pendingToday.length) {
    const untils = pendingToday.map((r) => (startMs(r) ? startMs(r) - now : -Infinity));
    if (untils.some((u) => u > 0 && u <= NEAR_POST_MIN * MIN)) return 60;
    if (untils.some((u) => u > 0 && u <= 20 * MIN)) return 150;
    return untils.some((u) => u < 90 * MIN) ? 300 : 1200;
  }
  const soon = all.some((r) => r.status !== 'result' && startMs(r) && startMs(r) > now && startMs(r) - now < 24 * 3600 * 1000);
  return soon ? 1200 : 3600;
}

/**
 * バンドルの構成の署名：開催日・レース・状態（結果の有無）・取消・馬場。オッズや馬体重は入れない。
 * 画面は、data.json を読んだときの署名と near.json の署名が同じなら、発走の近いレースだけを差し替える（違えば data.json を読み直す）
 */
export function bundleSig(bundle) {
  let h = 2166136261;
  const add = (v) => {
    const str = `${v ?? ''}|`;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  };
  for (const d of bundle.days || []) {
    add(d.date);
    for (const r of d.races || []) {
      add(r.id);
      add(r.status);
      add(r.provisional ? 1 : 0);
      add(r.result?.length || 0);
      add(r.entries?.length || 0);
      add((r.entries || []).filter((e) => e.scratched).length);
      add(r.going);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
/** 発走の近いレース（near.json）：今日のまだ確定していないレースで、発走の30分前〜発走15分後のもの（レースはバンドルと同じ形） */
export function nearRaces(bundle, { now = Date.now(), today = jstParts(now).date, before = 30, after = 15 } = {}) {
  const out = [];
  for (const d of bundle.days || []) {
    if (d.date !== today) continue;
    for (const r of d.races || []) {
      const st = startMs(r);
      if (!st || r.status === 'result' || r.provisional) continue;
      if (st - now <= before * MIN && now - st <= after * MIN) out.push(r);
    }
  }
  return out;
}
/** near.json の中身（data.json と同じ取り込みの回で作る）。generatedAt と sig は data.json と同じ */
export function nearFile(bundle, opts = {}) {
  return { version: 1, generatedAt: bundle.generatedAt, sig: bundle.sig || bundleSig(bundle), races: nearRaces(bundle, opts) };
}

/** 出馬表（オッズ）を取り直す間隔：発走が近いほど短く */
export function cardTtl(race, now) {
  const st = race ? startMs(race) : null;
  if (!st) return 10 * MIN;
  const until = st - now;
  if (until <= 0) return 3 * MIN; // 発走後：締切時点のオッズを一度取り直す
  if (until <= NEAR_POST_MIN * MIN) return 45 * 1000; // 発走8分前〜：取り込みのたびに（約1分ごと）
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
        // 発走2時間前からは、単勝・複勝と、馬連・ワイド・3連複のオッズのページも取る（出馬表にはない）
        const st2 = startMs(race);
        if (card.oddsCname && st2 && st2 - now < 2 * 60 * MIN && now - st2 < 30 * MIN) {
          try {
            const html = await client.page(card.oddsCname, { cache: 'ttl', ttlMs: ttl });
            const o = parseOdds(html);
            const by = new Map(o.odds.map((x) => [x.number, x]));
            for (const e of race.entries) {
              const x = by.get(e.number);
              if (!x) continue;
              if (x.odds > 1) e.odds = x.odds;
              e.placeMin = x.placeMin;
              e.placeMax = x.placeMax;
            }
            const links = parseOddsLinks(html);
            const exotic = known?.exoticOdds || {};
            for (const kind of ['quinella', 'wide', 'trio', 'exacta']) {
              if (!links[kind]) continue;
              const parsed = parseExoticOdds(await client.page(links[kind], { cache: 'ttl', ttlMs: ttl }));
              if (parsed.count) exotic[kind] = parsed.odds;
            }
            if (Object.keys(exotic).length) race.exoticOdds = exotic;
          } catch (err) {
            log(`オッズの取得に失敗 ${link.raceId}: ${err.message}`);
          }
        } else if (known?.exoticOdds) race.exoticOdds = known.exoticOdds;
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

  // 発走から10分以上たったレースの結果。結果が途中まで（速報の上位だけ）のレースも取り直す
  const pending = bundle.days.flatMap((d) => d.races).filter((r) => (r.status !== 'result' || !resultComplete(r)) && startMs(r) && now - startMs(r) > 10 * MIN);
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
          // 全頭の結果がそろってから取り込む（速報の上位だけの段階では取り込まない。次の回に取り直す）
          const expected = Math.max(record.expectedRunners || 0, race.entries.filter((e) => !e.scratched).length);
          const cov = recordCoverage(record, expected);
          if (!cov.complete) {
            log(`結果がまだ途中まで ${race.date} ${race.course}${race.raceNo}R（${cov.have}/${expected}頭）`);
            continue;
          }
          record.expectedRunners = expected;
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

/** 古い開催日を落とす（過去は keepPastDays 日以内の開催日。少なくとも直近 keepPast 開催日は残す。これからの日はすべて残す） */
export function pruneBundle(bundle, { keepPast = 4, keepPastDays = 0, today = jstParts().date } = {}) {
  const past = bundle.days.filter((d) => d.date < today).map((d) => d.date);
  const cutoff = keepPastDays ? new Date(Date.parse(`${today}T00:00:00Z`) - keepPastDays * 86400000).toISOString().slice(0, 10) : '9999';
  const drop = new Set(past.filter((d, i) => d < cutoff && i < past.length - keepPast));
  bundle.days = bundle.days.filter((d) => !drop.has(d.date));
  return bundle;
}

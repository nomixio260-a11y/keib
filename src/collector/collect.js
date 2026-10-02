// JRA公式サイトからの収集処理（開催一覧 → レース一覧 → 出馬表 / 結果 / オッズ）と、アプリ用データへの整形。

import {
  parseRaceCard,
  parseRaceResult,
  parseOdds,
  parseMeetingLinks,
  parseRaceLinks,
  parseMonthParams,
} from './jra.js';

const MIN = 60 * 1000;

/** 今週の出馬表がある開催 */
export async function listCardMeetings(client) {
  const html = await client.page('pw01dli00/F3', { cache: 'ttl', ttlMs: 10 * MIN });
  return parseMeetingLinks(html).filter((m) => m.type === 'card');
}

/** 払戻期間内（直近およそ2か月）の結果がある開催 */
export async function listRecentResultMeetings(client) {
  const html = await client.page('pw01sli00/AF', { cache: 'ttl', ttlMs: 5 * MIN });
  return parseMeetingLinks(html).filter((m) => m.type === 'result');
}

let monthParams = null;
/** 過去のレース結果（年月）の開催。ym = '2025-10' */
export async function listMonthMeetings(client, ym, todayYm) {
  if (!monthParams) monthParams = parseMonthParams(await client.page('pw01skl00999999/B3', { cache: 'ttl', ttlMs: 24 * 60 * MIN }));
  const yyyymm = ym.replace('-', '');
  const sum = monthParams[yyyymm.slice(2)];
  if (!sum) return [];
  const prefix = todayYm && yyyymm >= todayYm.replace('-', '') ? 'pw01skl00' : 'pw01skl10';
  const html = await client.page(`${prefix}${yyyymm}/${sum}`, { cache: 'forever' });
  return parseMeetingLinks(html).filter((m) => m.type === 'result');
}

/** 開催のレース一覧（CNAME） */
export async function listRaces(client, meeting, { live = false } = {}) {
  const html = await client.page(meeting.cname, live ? { cache: 'ttl', ttlMs: 2 * MIN } : { cache: 'forever' });
  return parseRaceLinks(html);
}

export async function fetchCard(client, cname, ttlMs = 2 * MIN) {
  return parseRaceCard(await client.page(cname, { cache: 'ttl', ttlMs }));
}

export async function fetchResult(client, cname) {
  return parseRaceResult(await client.page(cname, { cache: 'forever' }));
}

export async function fetchOdds(client, cname, { final = false, ttlMs = MIN } = {}) {
  return parseOdds(await client.page(cname, final ? { cache: 'forever' } : { cache: 'ttl', ttlMs }));
}

const stripPedigree = (s) => String(s || '').trim();

/** 出馬表 → アプリのレース形式 */
export function cardToRace(card, key) {
  return {
    id: key.raceId,
    source: 'JRA',
    date: key.date,
    course: key.course,
    courseCode: key.courseCode,
    kai: key.kai,
    day: key.day,
    raceNo: key.raceNo,
    startTime: card.startTime,
    name: card.name,
    grade: card.grade,
    className: card.className,
    gradeIcon: card.gradeIcon,
    category: card.category,
    ageCond: card.category,
    rule: card.rule,
    weightRule: card.weightRule,
    surface: card.surface,
    distance: card.distance,
    direction: card.direction,
    lane: card.lane,
    going: card.going,
    weather: card.weather,
    jump: card.jump,
    entries: card.entries.map((e) => ({
      frame: e.frame,
      number: e.number,
      name: e.name,
      horseId: e.horseId,
      sex: e.sex,
      age: e.age,
      weight: e.weight,
      jockey: e.jockey,
      jockeyId: e.jockeyId,
      trainer: e.trainer,
      trainerArea: e.trainerArea,
      bodyWeight: e.bodyWeight,
      bodyWeightDiff: e.bodyWeightDiff,
      odds: e.odds,
      popularity: e.popularity,
      sire: stripPedigree(e.sire),
      damSire: stripPedigree(e.damSire),
      record: e.record,
      scratched: e.scratched,
      past: e.past.map((p) => ({
        raceId: p.raceId,
        date: p.date,
        course: p.course,
        raceName: p.raceName,
        grade: p.grade,
        surface: p.surface,
        distance: p.distance,
        going: p.going,
        fieldSize: p.fieldSize,
        number: p.number,
        finish: p.finish,
        status: p.status,
        time: p.time,
        margin: p.margin,
        last3f: p.last3f,
        passing: p.passing,
        weight: p.weight,
        jockey: p.jockey,
        bodyWeight: p.bodyWeight,
        popularity: p.popularity,
        winner: p.winner,
      })),
    })),
  };
}

/** 結果 + 最終オッズ → 保存用のレース記録（出走馬ごとの成績） */
export function resultToRecord(result, odds, key) {
  const oddsBy = new Map((odds?.odds || []).map((o) => [o.number, o]));
  const winnerTime = result.rows.find((r) => r.finish === 1)?.time ?? null;
  const secondTime = result.rows.find((r) => r.finish === 2)?.time ?? null;
  const runners = result.rows.map((r) => {
    const o = oddsBy.get(r.number);
    let margin = null;
    if (r.time != null && winnerTime != null) margin = Math.round((r.time - winnerTime) * 10) / 10;
    if (r.finish === 1 && secondTime != null && winnerTime != null) margin = -Math.round((secondTime - winnerTime) * 10) / 10;
    return { ...r, margin, odds: o?.odds ?? null, placeMin: o?.placeMin ?? null, placeMax: o?.placeMax ?? null };
  });
  // 上がり3Fの順位（同タイムは同順位）
  const l3 = runners.filter((r) => r.last3f > 0).map((r) => r.last3f).sort((a, b) => a - b);
  for (const r of runners) r.last3fRank = r.last3f > 0 ? l3.indexOf(r.last3f) + 1 : null;
  return {
    id: key.raceId,
    source: 'JRA',
    date: key.date,
    course: key.course,
    courseCode: key.courseCode,
    kai: key.kai,
    day: key.day,
    raceNo: key.raceNo,
    startTime: result.startTime,
    name: result.name,
    grade: result.grade,
    className: result.className,
    category: result.category,
    rule: result.rule,
    weightRule: result.weightRule,
    surface: result.surface,
    distance: result.distance,
    direction: result.direction,
    lane: result.lane,
    going: result.going,
    weather: result.weather,
    jump: result.jump,
    fieldSize: runners.filter((r) => r.finish > 0 || r.status === '中止' || r.status === '失格').length,
    runners,
    payouts: result.payouts,
  };
}

/** 着順（馬番の並び）。同着や中止は除いて確定順に */
export function finishingOrder(record) {
  return record.runners
    .filter((r) => r.finish > 0)
    .sort((a, b) => a.finish - b.finish || a.number - b.number)
    .map((r) => r.number);
}

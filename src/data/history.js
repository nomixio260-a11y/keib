// 実際のレース結果（JRA）から、予想に使う統計と「レース前時点の出馬表」を作る。
// 学習・検証では、各レースの前に終わったレースだけを使い、未来の情報が混ざらないようにする。

import { daysBetween } from '../engine/util.js';

// 出馬表（レース前時点）に載せる過去走の数。JRA の出馬表は前4走だが、馬のデータベースから足して増やせる（MAX_PAST）
const MAX_PAST = Number(globalThis.process?.env?.KEIB_MAX_PAST || 4);

/** 結果の記録から、出馬表の「過去走」1走分を作る */
export function runFromRecord(record, runner) {
  const winner = record.runners.find((r) => r.finish === 1 && r.number !== runner.number) || record.runners.find((r) => r.finish === 2);
  return {
    raceId: record.id,
    date: record.date,
    course: record.course,
    raceName: record.name,
    grade: record.grade,
    surface: record.surface,
    distance: record.distance,
    going: record.going,
    fieldSize: record.fieldSize,
    number: runner.number,
    finish: runner.finish,
    status: runner.status,
    time: runner.time,
    margin: runner.margin,
    last3f: runner.last3f,
    last3fRank: runner.last3fRank,
    passing: runner.passing,
    weight: runner.weight,
    jockey: runner.jockey,
    bodyWeight: runner.bodyWeight,
    popularity: runner.popularity,
    winner: winner?.name || '',
  };
}

/** 馬ごとの出走履歴（新しい順） */
export function indexHistory(records) {
  const byHorse = new Map();
  for (const rec of records) {
    for (const r of rec.runners) {
      if (!r.horseId) continue;
      if (!byHorse.has(r.horseId)) byHorse.set(r.horseId, []);
      byHorse.get(r.horseId).push({ date: rec.date, raceId: rec.id, rec, runner: r });
    }
  }
  for (const list of byHorse.values()) list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.raceId.localeCompare(a.raceId)));
  return { byHorse };
}

/** 結果の記録 → レース前時点の出馬表（過去走はこのレースより前のものだけ） */
export function preRaceCard(record, index, { maxPast = MAX_PAST } = {}) {
  const entries = record.runners.map((r) => {
    const hist = (index.byHorse.get(r.horseId) || []).filter((h) => h.date < record.date).slice(0, maxPast);
    return {
      frame: r.frame,
      number: r.number,
      name: r.name,
      horseId: r.horseId,
      sex: r.sex,
      age: r.age,
      weight: r.weight,
      jockey: r.jockey,
      jockeyId: r.jockeyId,
      trainer: r.trainer,
      bodyWeight: r.bodyWeight,
      bodyWeightDiff: r.bodyWeightDiff,
      odds: r.odds,
      popularity: r.popularity,
      placeMin: r.placeMin ?? null,
      placeMax: r.placeMax ?? null,
      scratched: r.finish === 0 && /取消|除外/.test(r.status || ''),
      past: hist.map((h) => runFromRecord(h.rec, h.runner)),
    };
  });
  return {
    id: record.id,
    source: 'JRA',
    date: record.date,
    course: record.course,
    courseCode: record.courseCode,
    kai: record.kai,
    day: record.day,
    raceNo: record.raceNo,
    startTime: record.startTime,
    name: record.name,
    grade: record.grade,
    className: record.className,
    category: record.category,
    ageCond: record.category,
    rule: record.rule,
    weightRule: record.weightRule,
    surface: record.surface,
    distance: record.distance,
    direction: record.direction,
    lane: record.lane,
    going: record.going,
    weather: record.weather,
    jump: record.jump,
    entries,
    result: record.runners
      .filter((r) => r.finish > 0)
      .sort((a, b) => a.finish - b.finish || a.number - b.number)
      .map((r) => r.number),
    finishes: Object.fromEntries(record.runners.map((r) => [r.number, r.finish || r.status || 0])),
    payouts: record.payouts,
  };
}

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const CLASS_REF = '2勝';

/**
 * 実データの統計：
 *  baseTimes … コース×芝ダ×距離の基準タイム（2勝クラス・良馬場の勝ち時計に相当）
 *  goingAdj  … 馬場状態ごとの補正（1000mあたり秒）
 *  classAdj  … クラスごとの勝ち時計の差（1000mあたり秒）
 *  last3f    … コース×芝ダ×距離の上がり3Fの中央値
 *  draw      … コース×芝ダ×距離の枠順傾向（＋で内枠有利）
 *  jockeys   … 騎手の出走数・勝利数・3着内数
 *  trainers  … 調教師（厩舎）の出走数・勝利数・3着内数
 */
export function computeStats(records) {
  const flat = records.filter((r) => !r.jump && r.surface !== '障' && r.distance > 0);
  const winners = [];
  for (const rec of flat) {
    const w = rec.runners.find((r) => r.finish === 1 && r.time > 0);
    if (w) winners.push({ key: `${rec.course}|${rec.surface}|${rec.distance}`, surface: rec.surface, going: rec.going || '良', grade: rec.grade || CLASS_REF, d: rec.distance / 1000, t: w.time });
  }
  // バックフィッティング：時計 = 基準(コース距離) + (馬場補正 + クラス補正) × 距離
  const base = new Map();
  const going = new Map();
  const cls = new Map();
  const groupMean = (items, keyOf, valueOf) => {
    const acc = new Map();
    for (const it of items) {
      const k = keyOf(it);
      const a = acc.get(k) || [0, 0];
      a[0] += valueOf(it);
      a[1]++;
      acc.set(k, a);
    }
    return new Map([...acc].map(([k, [s, n]]) => [k, { v: s / n, n }]));
  };
  const g = (it) => going.get(`${it.surface}|${it.going}`)?.v ?? 0;
  const c = (it) => cls.get(`${it.surface}|${it.grade}`)?.v ?? 0;
  for (let iter = 0; iter < 8; iter++) {
    const b = groupMean(winners, (it) => it.key, (it) => it.t - (g(it) + c(it)) * it.d);
    base.clear();
    for (const [k, v] of b) base.set(k, v);
    const bv = (it) => base.get(it.key).v;
    const gm = groupMean(winners, (it) => `${it.surface}|${it.going}`, (it) => (it.t - bv(it) - c(it) * it.d) / it.d);
    for (const s of ['芝', 'ダ']) {
      const ref = gm.get(`${s}|良`)?.v ?? 0;
      for (const [k, v] of gm) if (k.startsWith(s)) gm.set(k, { ...v, v: v.v - ref });
    }
    going.clear();
    for (const [k, v] of gm) going.set(k, v);
    const cm = groupMean(winners, (it) => `${it.surface}|${it.grade}`, (it) => (it.t - bv(it) - g(it) * it.d) / it.d);
    for (const s of ['芝', 'ダ']) {
      const ref = cm.get(`${s}|${CLASS_REF}`)?.v ?? 0;
      for (const [k, v] of cm) if (k.startsWith(s)) cm.set(k, { ...v, v: v.v - ref });
    }
    cls.clear();
    for (const [k, v] of cm) cls.set(k, v);
  }

  const l3 = new Map();
  for (const rec of flat) {
    const k = `${rec.course}|${rec.surface}|${rec.distance}`;
    for (const r of rec.runners) if (r.last3f > 0 && r.finish > 0) (l3.get(k) || l3.set(k, []).get(k)).push(r.last3f);
  }

  // 枠順傾向：内側1/3と外側1/3の3着内率の差（馬番で判定）
  const drawAcc = new Map();
  for (const rec of flat) {
    const n = rec.runners.filter((r) => r.finish > 0).length;
    if (n < 8) continue;
    const k = `${rec.course}|${rec.surface}|${rec.distance}`;
    const a = drawAcc.get(k) || { innerTop3: 0, inner: 0, outerTop3: 0, outer: 0, races: 0 };
    a.races++;
    for (const r of rec.runners) {
      if (!(r.finish > 0)) continue;
      const pos = (r.number - 1) / (n - 1);
      if (pos <= 1 / 3) {
        a.inner++;
        if (r.finish <= 3) a.innerTop3++;
      } else if (pos >= 2 / 3) {
        a.outer++;
        if (r.finish <= 3) a.outerTop3++;
      }
    }
    drawAcc.set(k, a);
  }
  const draw = {};
  for (const [k, a] of drawAcc) {
    if (a.races < 12 || !a.inner || !a.outer) continue;
    const ri = a.innerTop3 / a.inner;
    const ro = a.outerTop3 / a.outer;
    const avg = (a.innerTop3 + a.outerTop3) / (a.inner + a.outer);
    // 少ないサンプルは0に寄せる
    const shrink = a.races / (a.races + 40);
    draw[k] = Math.max(-1, Math.min(1, ((ri - ro) / Math.max(avg, 0.05)) * 1.2 * shrink));
  }

  const jockeys = {};
  const trainers = {};
  const tally = (table, name, r) => {
    const j = (table[name] ||= { starts: 0, wins: 0, top3: 0 });
    j.starts++;
    if (r.finish === 1) j.wins++;
    if (r.finish >= 1 && r.finish <= 3) j.top3++;
  };
  for (const rec of records) {
    for (const r of rec.runners) {
      if (!(r.finish > 0 || r.status === '中止')) continue;
      if (r.jockey) tally(jockeys, r.jockey, r);
      if (r.trainer) tally(trainers, r.trainer, r);
    }
  }

  const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  return {
    races: records.length,
    from: records.reduce((m, r) => (r.date < m ? r.date : m), '9999'),
    to: records.reduce((m, r) => (r.date > m ? r.date : m), '0000'),
    baseTimes: Object.fromEntries([...base].filter(([, v]) => v.n >= 3).map(([k, v]) => [k, [round(v.v), v.n]])),
    goingAdj: Object.fromEntries([...going].map(([k, v]) => [k, round(v.v, 3)])),
    classAdj: Object.fromEntries([...cls].map(([k, v]) => [k, round(v.v, 3)])),
    last3f: Object.fromEntries([...l3].filter(([, v]) => v.length >= 20).map(([k, v]) => [k, round(median(v), 2)])),
    draw: Object.fromEntries(Object.entries(draw).map(([k, v]) => [k, round(v, 3)])),
    jockeys,
    trainers,
  };
}

/**
 * 開催日ごとの馬場差（1000mあたり秒、＋で時計がかかる馬場）。
 * 同じ日・同じ競馬場・同じ芝ダートの勝ち時計が、基準タイム＋馬場状態＋クラスの補正からどれだけずれたかの平均。
 * レース数が少ない日は0に寄せる。各日の値はその日の結果だけから決まるので、
 * それより後のレースの予想に使っても未来の情報は混ざらない。
 */
export function computeDayVariants(records, stats, { shrink = 2 } = {}) {
  const acc = new Map();
  for (const rec of records) {
    if (rec.jump || (rec.surface !== '芝' && rec.surface !== 'ダ') || !(rec.distance > 0)) continue;
    const w = rec.runners?.find((r) => r.finish === 1 && r.time > 0);
    const base = stats.baseTimes?.[`${rec.course}|${rec.surface}|${rec.distance}`];
    if (!w || !base) continue;
    const d = rec.distance / 1000;
    const g = stats.goingAdj?.[`${rec.surface}|${rec.going || '良'}`] ?? 0;
    const c = stats.classAdj?.[`${rec.surface}|${rec.grade || CLASS_REF}`] ?? 0;
    const resid = (w.time - base[0]) / d - g - c;
    // 極端な値（記録ミス・特殊なペース）は抑える
    const r = Math.max(-1.5, Math.min(1.5, resid));
    const k = `${rec.date}|${rec.course}|${rec.surface}`;
    const a = acc.get(k) || [0, 0];
    a[0] += r;
    a[1]++;
    acc.set(k, a);
  }
  const out = {};
  for (const [k, [sum, n]] of acc) out[k] = Math.round((sum / (n + shrink)) * 1000) / 1000;
  return out;
}

/** 騎手（調教師）の勝率・複勝率（出走が少ない人は全体平均に寄せる） */
export function jockeyRates(jockeys, prior = 60) {
  let starts = 0;
  let wins = 0;
  let top3 = 0;
  for (const j of Object.values(jockeys)) {
    starts += j.starts;
    wins += j.wins;
    top3 += j.top3;
  }
  const w0 = starts ? wins / starts : 0.07;
  const t0 = starts ? top3 / starts : 0.21;
  const out = {};
  for (const [name, j] of Object.entries(jockeys)) {
    out[name] = {
      starts: j.starts,
      winRate: (j.wins + prior * w0) / (j.starts + prior),
      top3Rate: (j.top3 + prior * t0) / (j.starts + prior),
    };
  }
  return { rates: out, average: { winRate: w0, top3Rate: t0 } };
}

/** 2つの日付の間の日数（a < b） */
export const gapDays = (a, b) => daysBetween(a, b);

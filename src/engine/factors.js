// 予想ファクターの計算。各馬の過去走から「生の値」を出す（レース内での標準化は model.js）。

import { speedFigure, last3fBase } from './speed.js';
import { classLevel, COURSES, drawBias, straightBias, JOCKEY_DEFAULT } from './constants.js';
import { impliedWinProbs } from './market.js';
import { REAL_STATS } from './realStats.js';
import { clamp, daysBetween, mean } from './util.js';

// 直近の走ほど重視する（出馬表の前4走に、馬のデータベースにある古い走を足した分も使える）
const RECENCY = [1, 0.8, 0.65, 0.5, 0.4, 0.33, 0.28, 0.24];
/** 予想に使う過去走の最大数 */
export const MAX_RUNS = Number(globalThis.process?.env?.KEIB_MAX_RUNS || 8);

const isHeavy = (going) => going === '重' || going === '不良';

/** 過去走1走を数値化 */
export function analyzeRun(run, k, race, stats = REAL_STATS) {
  const field = Math.max(2, run.fieldSize || 16);
  const finished = run.finish > 0;
  const pos = finished ? 1 - (Math.min(run.finish, field) - 1) / (field - 1) : 0;
  // 着差（秒）。勝ち馬はマイナス表記のことがあるので 0 に丸める
  const margin = finished ? Math.max(0, Number.isFinite(run.margin) ? run.margin : run.finish === 1 ? 0 : 0.8) : 3;
  const marginScore = Math.exp(-margin / 0.6);
  const ageDays = race?.date && run.date ? daysBetween(run.date, race.date) : 30;
  let recency = RECENCY[k] ?? 0.3;
  if (ageDays > 365) recency *= 0.5;
  const passing = Array.isArray(run.passing) ? run.passing.filter((p) => p > 0) : [];
  // 上がり3F：その条件の標準的な上がりより何秒速いか（0.5が標準、1.5秒速いと1）
  const l3base = run.last3f > 0 ? last3fBase(run.course, run.surface, run.distance, stats) : null;
  return {
    run,
    k,
    field,
    finished,
    pos,
    marginScore,
    perf: 0.5 * pos + 0.5 * marginScore,
    si: speedFigure(run, stats),
    recency,
    sameSurface: run.surface === race.surface,
    closing: l3base ? clamp(0.5 + (l3base - run.last3f) / 3, 0, 1) : null,
    firstPos: passing.length ? (Math.min(passing[0], field) - 1) / (field - 1) : null,
    led: passing.length ? passing[0] === 1 : false,
  };
}

/** 脚質。early は先行力（1=先頭、0=最後方） */
export function runningStyle(an) {
  const items = an.filter((a) => a.firstPos != null);
  if (!items.length) return { early: null, style: '不明', leadShare: 0 };
  let s = 0;
  let w = 0;
  let lead = 0;
  for (const a of items) {
    s += a.recency * a.firstPos;
    w += a.recency;
    if (a.led) lead += a.recency;
  }
  const back = s / w;
  const leadShare = lead / w;
  let style;
  if (leadShare >= 0.4 || back <= 0.1) style = '逃げ';
  else if (back <= 0.36) style = '先行';
  else if (back <= 0.66) style = '差し';
  else style = '追込';
  return { early: 1 - back, style, leadShare };
}

/**
 * 先行力の一覧からペースを推定（生成器とモデルで共通）。
 * z: −1 スロー 〜 +1 ハイ。front は逃げ候補の頭数の目安。
 */
export function paceFromEarly(earlies) {
  let front = 0;
  let second = 0;
  for (const e of earlies) {
    front += 1 / (1 + Math.exp(-(e - 0.8) * 18));
    second += 1 / (1 + Math.exp(-(e - 0.62) * 14));
  }
  const z = clamp((front - 1.5) / 1.3 + (second - 4.5) / 6, -1, 1);
  return { z, front, second, label: z >= 0.35 ? 'H' : z <= -0.35 ? 'S' : 'M' };
}

/**
 * スピード指数：同じ芝ダでの最高値（持ち時計）を、今回の斤量で走ったときの水準に直す（1kg ≒ 2ポイント）。
 * 実データでの比較（scripts/experiment.mjs）で、平均よりも最高値のほうが着順をよく説明した。
 * 1年以上前の走は少し割り引き、同じ芝ダの走がなければ別の芝ダの最高値から割り引いて使う。
 */
function speedFactor(an, entry, race) {
  const items = an.filter((a) => a.si != null);
  if (!items.length) return null;
  const ageOf = (a) => (race?.date && a.run.date ? daysBetween(a.run.date, race.date) : 30);
  const val = (a) => a.si - (ageOf(a) > 365 ? 3 : 0);
  const same = items.filter((a) => a.sameSurface);
  const best = same.length ? Math.max(...same.map(val)) : Math.max(...items.map(val)) - 5;
  const weightAdj = entry?.weight > 0 ? -2 * (entry.weight - 55) : 0;
  return best + weightAdj;
}

function formFactor(an, race) {
  if (!an.length) return null;
  const today = classLevel(race.grade);
  let s = 0;
  let w = 0;
  for (const a of an) {
    // 上のクラスでの着順は価値が高い
    const classAdj = 0.07 * (classLevel(a.run.grade) - today);
    s += a.recency * (0.55 * a.pos + 0.45 * a.marginScore + classAdj);
    w += a.recency;
  }
  return s / w;
}

function closingFactor(an) {
  const items = an.filter((a) => a.closing != null);
  if (!items.length) return null;
  let s = 0;
  let w = 0;
  for (const a of items) {
    s += a.recency * a.closing;
    w += a.recency;
  }
  return s / w;
}

function jockeyFactor(entry, jockeys, average = JOCKEY_DEFAULT) {
  const j = jockeys?.[entry.jockey];
  const win = j?.winRate ?? average.winRate;
  const top3 = j?.top3Rate ?? average.top3Rate;
  return 0.35 * win + 0.65 * top3;
}

/** 厩舎（調教師）の勝率・複勝率。データがなければ null（平均扱い） */
function trainerFactor(entry, trainers, average) {
  if (!trainers || !average) return null;
  const t = trainers[entry.trainer];
  const win = t?.winRate ?? average.winRate;
  const top3 = t?.top3Rate ?? average.top3Rate;
  return 0.35 * win + 0.65 * top3;
}

/** 距離・コース・馬場・芝ダ・回り・血統 */
function aptitudeFactor(an, race, sire) {
  const n = an.length;
  const overall = n ? mean(an.map((a) => a.perf)) : 0.5;
  // 条件が近いレースでの成績が、その馬の平均よりどれだけ良いか（少数サンプルは縮小）
  const rel = (weightOf) => {
    let s = 0;
    let w = 0;
    for (const a of an) {
      const ww = weightOf(a);
      if (ww > 0) {
        s += ww * (a.perf - overall);
        w += ww;
      }
    }
    return w > 0 ? (s / w) * (w / (w + 1.5)) : 0;
  };
  const dir = COURSES[race.course]?.dir;
  const heavy = isHeavy(race.going);
  const parts = {
    dist: rel((a) => {
      const d = Math.abs(a.run.distance - race.distance);
      return d <= 200 ? 1 : d <= 400 ? 0.5 : 0;
    }),
    course: rel((a) => (a.run.course === race.course && a.sameSurface ? 1 : 0)),
    going: heavy ? rel((a) => (isHeavy(a.run.going) ? 1 : 0)) : 0,
    direction: dir ? rel((a) => (COURSES[a.run.course]?.dir === dir ? 0.7 : 0)) : 0,
    surface: 0,
    pedigree: 0,
  };
  const sameSurf = an.filter((a) => a.sameSurface).length;
  if (n && !sameSurf) parts.surface = -0.06; // 初の芝/ダートは未知数
  else if (n) parts.surface = rel((a) => (a.sameSurface ? 1 : 0));
  const nearDist = an.filter((a) => Math.abs(a.run.distance - race.distance) <= 400).length;
  const distUnknown = n && !nearDist ? -0.04 : 0;
  if (sire) {
    // 血統は経験が少ない馬ほど重視
    const surfFit = race.surface === '芝' ? sire.turf : -sire.turf;
    const distFit = 0.5 - Math.min(1, Math.abs(race.distance - sire.dist) / 700);
    const goingFit = heavy ? sire.heavy : 0;
    parts.pedigree = (0.12 * surfFit + 0.1 * distFit + 0.06 * goingFit) / (1 + 0.6 * sameSurf);
  }
  const value =
    0.35 * parts.dist +
    0.2 * parts.course +
    0.25 * parts.going +
    0.2 * parts.surface +
    0.1 * parts.direction +
    distUnknown +
    parts.pedigree;
  return { value, parts, sameSurf, nearDist };
}

/** 休み明け・連闘・叩き2戦目・斤量増減・馬体重増減・年齢 */
function conditionFactor(entry, runs, race) {
  let c = 0;
  const notes = [];
  const last = runs[0];
  let layoffDays = null;
  if (last) {
    layoffDays = daysBetween(last.date, race.date);
    if (layoffDays > 180) {
      c -= 0.55;
      notes.push({ text: `休み明け(${Math.round(layoffDays / 7)}週)`, sign: -1 });
    } else if (layoffDays > 120) {
      c -= 0.35;
      notes.push({ text: `休み明け(${Math.round(layoffDays / 7)}週)`, sign: -1 });
    } else if (layoffDays > 75) {
      c -= 0.12;
    } else if (layoffDays <= 13) {
      c -= 0.12;
      notes.push({ text: layoffDays <= 8 ? '連闘' : '中1週', sign: -1 });
    }
    if (runs[1] && daysBetween(runs[1].date, last.date) > 90 && layoffDays <= 75) {
      c += 0.12;
      notes.push({ text: '叩き2戦目', sign: 1 });
    }
    const dw = (entry.weight || 0) - (last.weight || 0);
    if (entry.weight > 0 && last.weight > 0) {
      if (dw >= 2) {
        c -= 0.1 * Math.min(2, dw / 2);
        notes.push({ text: `斤量+${dw}kg`, sign: -1 });
      } else if (dw <= -2) {
        c += 0.06 * Math.min(2, -dw / 2);
        notes.push({ text: `斤量${dw}kg`, sign: 1 });
      }
    }
  }
  const bwd = entry.bodyWeightDiff;
  if (Number.isFinite(bwd)) {
    const a = Math.abs(bwd);
    if (a >= 14) c -= 0.35;
    else if (a >= 10) c -= 0.2;
    else if (a >= 8) c -= 0.06;
    if (a >= 10) notes.push({ text: `馬体重${bwd > 0 ? '+' : ''}${bwd}kg`, sign: -1 });
  }
  if (entry.age >= 8) c -= 0.3;
  else if (entry.age >= 7) c -= 0.18;
  return { value: c, notes, layoffDays };
}

function summaryStats(an) {
  const sis = an.filter((a) => a.si != null && a.sameSurface).map((a) => a.si);
  const allSis = an.filter((a) => a.si != null).map((a) => a.si);
  return {
    runs: an.length,
    wins: an.filter((a) => a.run.finish === 1).length,
    top3: an.filter((a) => a.run.finish >= 1 && a.run.finish <= 3).length,
    bestSi: sis.length ? Math.max(...sis) : allSis.length ? Math.max(...allSis) : null,
    lastSi: an[0]?.si ?? null,
    topClosing: an.filter((a) => a.closing != null && a.closing >= 0.8).length,
  };
}

/** レース全体のファクター（生の値）を計算 */
export function computeRaceFactors(race, opts = {}) {
  const stats = opts.stats || REAL_STATS;
  const entries = race.entries.filter((e) => !e.scratched);
  const hasRaceJockeys = race.jockeys && Object.keys(race.jockeys).length;
  const jockeys = hasRaceJockeys ? race.jockeys : opts.jockeys || stats.jockeyRates || {};
  const jockeyAvg = stats.jockeyAverage || JOCKEY_DEFAULT;
  const sires = opts.sires || {};
  const rows = entries.map((entry) => {
    const runs = (entry.past || []).filter((r) => r && r.date).slice(0, MAX_RUNS);
    const an = runs.map((run, k) => analyzeRun(run, k, race, stats));
    const style = runningStyle(an);
    const sire = sires[entry.sire] || null;
    const apt = aptitudeFactor(an, race, sire);
    const cond = conditionFactor(entry, runs, race);
    return {
      entry,
      runs,
      an,
      style,
      sire,
      apt,
      cond,
      stats: summaryStats(an),
      raw: {
        speed: speedFactor(an, entry, race),
        form: formFactor(an, race),
        closing: closingFactor(an),
        jockey: jockeyFactor(entry, jockeys, jockeyAvg),
        trainer: trainerFactor(entry, stats.trainerRates, stats.trainerAverage),
        aptitude: apt.value,
        condition: cond.value,
      },
    };
  });

  // 展開と枠順はレース全体を見て決まる
  const pace = paceFromEarly(rows.map((r) => r.style.early ?? 0.45));
  const sb = straightBias(race.course, race.surface, race.distance);
  // 枠順傾向は実データの統計を優先（なければ代表的な傾向を弱めて使う）
  const realDraw = stats.draw?.[`${race.course}|${race.surface}|${race.distance}`];
  const db = realDraw ?? drawBias(race.course, race.surface, race.distance) * 0.5;
  const gates = Math.max(...race.entries.map((e) => e.number || 0), race.entries.length);
  const nigeCount = rows.filter((r) => r.style.style === '逃げ').length;
  for (const r of rows) {
    const e = r.style.early ?? 0.45;
    let p = (e - 0.5) * -pace.z + 0.5 * (e - 0.5) * sb;
    r.loneLeader = r.style.style === '逃げ' && nigeCount === 1 && pace.z < 0.2;
    if (r.loneLeader) p += 0.25;
    if (r.raw.closing != null) {
      // 速い流れと長い直線は末脚のある馬に向く
      if (pace.z > 0) p += 0.6 * pace.z * (r.raw.closing - 0.5);
      if (sb < 0) p += 0.8 * -sb * (r.raw.closing - 0.5);
    }
    r.raw.pace = p;
    const inner = gates > 1 ? 1 - (2 * (r.entry.number - 1)) / (gates - 1) : 0;
    r.inner = inner;
    r.raw.draw = db * inner * (0.6 + 0.8 * e) * (entries.length <= 10 ? 0.6 : 1);
  }

  // 市場（単勝オッズ）
  const q = impliedWinProbs(entries.map((e) => e.odds));
  rows.forEach((r, i) => {
    r.marketProb = q[i];
    r.raw.market = Math.log(Math.max(q[i], 1e-4));
  });

  return { rows, pace, straightBias: sb, drawBias: db, nigeCount };
}

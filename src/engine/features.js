// 機械学習モデル（勾配ブースティング）用の特徴量。学習（scripts/dataset.mjs）と画面の予想で同じ関数を使う。
// すべて「そのレースの発走前に手に入る情報」から計算する。

import { computeRaceFactors } from './factors.js';
import { classLevel, drawBias, straightBias, JOCKEY_DEFAULT } from './constants.js';
import { speedFigure } from './speed.js';
import { REAL_STATS } from './realStats.js';
import { clamp, daysBetween, mean } from './util.js';

/**
 * Harville の式：単勝確率 q から、各馬が k 着以内に入る確率（複勝の払い戻し対象になる確率）。
 * k=3 のとき O(n^3) だが出走頭数は最大18頭なので問題ない
 */
export function harvilleTopK(q, k = 3) {
  const n = q.length;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let p = q[i];
    if (k >= 2) for (let j = 0; j < n; j++) if (j !== i) p += (q[j] * q[i]) / Math.max(1 - q[j], 1e-6);
    if (k >= 3)
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        for (let l = 0; l < n; l++) {
          if (l === i || l === j) continue;
          p += ((q[j] * q[l]) / Math.max(1 - q[j], 1e-6)) * (q[i] / Math.max(1 - q[j] - q[l], 1e-6));
        }
      }
    out[i] = Math.min(p, 0.999);
  }
  return out;
}

/**
 * Shin（1993）の市場確率：オッズの逆数 π_i（合計 Π > 1）から、人気薄が過大評価される分を取り除いた確率。
 *   p_i = ( sqrt(z^2 + 4(1-z) π_i^2 / Π) - z ) / (2(1-z))、Σp_i = 1 になる z を二分法で求める。
 * 単純な正規化（1/オッズ ÷ 合計）より人気薄が低く、人気馬が高くなる
 */
export function shinProbs(odds) {
  const pi = odds.map((o) => (o > 0 ? 1 / o : 0));
  const Pi = pi.reduce((a, b) => a + b, 0);
  if (!(Pi > 0) || pi.some((v) => !(v > 0))) return null;
  const probs = (z) => pi.map((v) => (Math.sqrt(z * z + (4 * (1 - z) * v * v) / Pi) - z) / (2 * (1 - z)));
  let lo = 0;
  let hi = 0.5;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    const s = probs(mid).reduce((a, b) => a + b, 0);
    if (s > 1) lo = mid;
    else hi = mid;
  }
  const p = probs((lo + hi) / 2);
  const s = p.reduce((a, b) => a + b, 0);
  return p.map((v) => v / s);
}

const fin01 = (finish, field) => (finish > 0 ? 1 - (Math.min(finish, field) - 1) / Math.max(1, field - 1) : 0);

/**
 * 馬のデータベース（data/history）にある、そのレースより前の全出走から作る要約（entry.career に入れる）。
 * サーバーもデータベースもない環境では src/data/horses.json（収集時点の要約）から同じ形で渡す。runs は新しい順。
 */
export function careerSnapshot(runs, stats = REAL_STATS) {
  if (!runs?.length) return null;
  const sis = runs.map((r) => speedFigure(r, stats)).filter((v) => v != null);
  const fins = runs.filter((r) => r.finish > 0);
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    starts: runs.length,
    wins: fins.filter((r) => r.finish === 1).length,
    top3: fins.filter((r) => r.finish <= 3).length,
    siBest: sis.length ? r1(Math.max(...sis)) : null,
    siMean: sis.length ? r1(mean(sis.slice(0, 6))) : null,
    posMean: fins.length ? Math.round(mean(fins.map((r) => fin01(r.finish, r.fieldSize || 16))) * 1000) / 1000 : null,
    bestClass: Math.max(...runs.map((r) => classLevel(r.grade))),
    elo: null, // 対戦成績の評価（history.js の computeRatings）。データベースがあるときに入る
  };
}

/** src/data/horses.json の1行（配列）→ careerSnapshot と同じ形 */
export function careerFromRow(row) {
  if (!row) return null;
  const [starts, wins, top3, siBest, siMean, posMean, bestClass, elo = null] = row;
  return { starts, wins, top3, siBest, siMean, posMean, bestClass, elo };
}

export const FEATURE_NAMES = [
  // 市場（単勝オッズ）と複勝オッズ（別の投票の市場。単勝から見込まれる複勝確率とのずれ）
  'logq', 'logqGap', 'popRank', 'placeKnown', 'placeLog', 'placeVsWin', 'placeSpread', 'logqShin', 'logqShinGap', 'placeRankDiff',
  // エンジンのファクター（生の値とレース内の相対値）
  'fSpeed', 'fSpeedRel', 'fForm', 'fFormRel', 'fClosing', 'fClosingRel', 'fJockey', 'fTrainer', 'fApt', 'fAptRel', 'fPace', 'fDraw', 'fCond',
  // 馬
  'age', 'sexF', 'weight', 'weightRel', 'bodyWeight', 'bwDiff', 'bwKnown',
  // 前4走
  'n4', 'lastFin', 'lastMargin', 'meanPos', 'wins4', 'top3_4', 'siBest4', 'siBest4Rel', 'siBest4Rank', 'siLast4', 'siMean4', 'siTrend', 'daysSince', 'classDelta', 'lastClass', 'distDelta', 'sameSurf4', 'sameCourse4', 'lastPop', 'lastBeatenFav', 'jockeyChange', 'earlyPos', 'styleKnown', 'closingBest', 'lastL3Rank', 'lastFieldSize', 'lastOddsLog', 'weightDelta', 'jWinDelta', 'siLast4Rel',
  // 通算（データベース）
  'cKnown', 'cStarts', 'cWinRate', 'cTop3Rate', 'cSiBest', 'cSiMean', 'cPosMean', 'cBestClass', 'cEloKnown', 'cElo', 'cEloRel',
  // 騎手・厩舎（全体と、競馬場・芝ダ・コンビの条件つき）
  'jWin', 'jTop3', 'jStarts', 'tWin', 'tTop3', 'jWinCourse', 'tWinSurf', 'pairWin', 'pairStarts',
  // 今日の相手との対戦成績（前4走で同じレースに出た相手に先着したか。人気の高い相手ほど重く）
  'h2h', 'h2hN',
  // 血統：父・母の父の芝ダ別の成績（出馬表の父・母の父と、統計の表から）
  'sireKnown', 'sireWinSurf', 'sireTop3Surf', 'sireStarts', 'damSireWinSurf',
  // レースの条件
  'n', 'isTurf', 'dist', 'gradeLevel', 'heavy', 'straight', 'drawInner', 'handicap', 'qFav', 'qEntropy',
];

const F = Object.fromEntries(FEATURE_NAMES.map((k, i) => [k, i]));
export const FEATURE_INDEX = F;

/**
 * レースの全馬の特徴量。
 *   careerOf(entry) … 馬の通算要約（careerSnapshot の形）か null
 *   jockeys / trainers … { 名前: { starts, winRate, top3Rate } }
 */
export function raceFeatures(race, { stats = REAL_STATS, careerOf = (e) => e.career || null, jockeys = null, trainers = null, fx = null } = {}) {
  fx = fx || computeRaceFactors(race, { stats, jockeys: jockeys || undefined });
  const rows = fx.rows;
  const n = rows.length;
  if (!n) return { rows: [], names: FEATURE_NAMES };
  const jk = jockeys || stats.jockeyRates || {};
  const jAvg = stats.jockeyAverage || JOCKEY_DEFAULT;
  const tk = trainers || stats.trainerRates || {};
  const tAvg = stats.trainerAverage || JOCKEY_DEFAULT;
  const today = classLevel(race.grade);
  const avg = (key) => {
    const v = rows.map((r) => r.raw[key]).filter((x) => x != null && Number.isFinite(x));
    return v.length ? mean(v) : 0;
  };
  const m = { speed: avg('speed'), form: avg('form'), closing: avg('closing'), aptitude: avg('aptitude') };
  const weights = rows.map((r) => r.entry.weight || 0).filter((w) => w > 0);
  const wMean = weights.length ? mean(weights) : 56;
  const logqs = rows.map((r) => Math.log(Math.max(r.marketProb, 1e-4)));
  const logqMax = Math.max(...logqs);
  const shin = shinProbs(rows.map((r) => r.entry.odds));
  const logqShin = shin ? shin.map((p) => Math.log(Math.max(p, 1e-4))) : logqs;
  const logqShinMax = Math.max(...logqShin);
  // 同順位は馬番で決める（行の並び順に情報が混ざらないように）
  const byNumber = (a, b) => (rows[a].entry.number || 0) - (rows[b].entry.number || 0);
  const popOrder = [...rows.keys()].sort((a, b) => logqs[b] - logqs[a] || byNumber(a, b));
  const popRank = new Array(n);
  popOrder.forEach((i, k) => (popRank[i] = k / Math.max(1, n - 1)));
  // 複勝オッズ：全馬そろっているときだけ使う。複勝は8頭以上なら3着まで、7頭以下なら2着まで
  const kPlace = n >= 8 ? 3 : 2;
  const qSum = rows.reduce((a, r) => a + r.marketProb, 0) || 1;
  const hv = harvilleTopK(rows.map((r) => r.marketProb / qSum), kPlace);
  const pmids = rows.map((r) => (r.entry.placeMin >= 1 && r.entry.placeMax >= r.entry.placeMin ? (r.entry.placeMin + r.entry.placeMax) / 2 : null));
  const placeOk = pmids.every((v) => v != null);
  const invSum = placeOk ? pmids.reduce((a, v) => a + 1 / v, 0) : 0;
  const placeProb = rows.map((r, i) => (placeOk ? clamp(((1 / pmids[i]) / invSum) * kPlace, 1e-3, 0.999) : hv[i]));
  // 単勝の人気順と複勝の人気順のずれ（複勝のほうが買われている馬はプラス）
  const placeOrder = [...rows.keys()].sort((a, b) => placeProb[b] - placeProb[a] || byNumber(a, b));
  const placeRank = new Array(n);
  placeOrder.forEach((i, k) => (placeRank[i] = k / Math.max(1, n - 1)));
  const siBest4 = rows.map((r) => {
    const sis = r.an.filter((a) => a.si != null).map((a) => a.si);
    return sis.length ? Math.max(...sis) : null;
  });
  const siKnown = siBest4.filter((v) => v != null);
  const siMax = siKnown.length ? Math.max(...siKnown) : 0;
  const siOrder = [...rows.keys()].sort((a, b) => (siBest4[b] ?? -999) - (siBest4[a] ?? -999) || byNumber(a, b));
  const siRank = new Array(n);
  siOrder.forEach((i, k) => (siRank[i] = k / Math.max(1, n - 1)));
  const sb = straightBias(race.course, race.surface, race.distance);
  const db = stats.draw?.[`${race.course}|${race.surface}|${race.distance}`] ?? drawBias(race.course, race.surface, race.distance) * 0.5;
  const heavy = race.going === '重' || race.going === '不良' ? 1 : 0;
  const handicap = /ハンデ/.test(`${race.weightRule || ''}${race.rule || ''}${race.name || ''}`) ? 1 : 0;
  // 市場の形：1番人気の確率と、人気の散らばり（エントロピー）
  const qn = rows.map((r) => r.marketProb / qSum);
  const qFav = Math.max(...qn);
  const qEntropy = -qn.reduce((a, q) => a + (q > 0 ? q * Math.log(q) : 0), 0);
  // 対戦成績：前走までで同じレースに出た今日の相手に先着したか（相手の人気で重み付け）
  const finOf = rows.map((r) => new Map(r.runs.filter((q) => q.raceId).map((q) => [q.raceId, q.finish])));
  const h2h = rows.map((r, i) => {
    let s = 0;
    let w = 0;
    let cnt = 0;
    for (let j = 0; j < rows.length; j++) {
      if (j === i) continue;
      for (const [rid, fi] of finOf[i]) {
        const fj = finOf[j].get(rid);
        if (fj == null || !(fi > 0) || !(fj > 0)) continue;
        s += (fi < fj ? 1 : -1) * qn[j];
        w += qn[j];
        cnt++;
      }
    }
    return { v: w ? s / w : 0, n: cnt };
  });
  const jc = stats.jockeyCourse || {};
  const ts = stats.trainerSurface || {};
  const pr = stats.pair || {};
  const ss = stats.sireSurface || {};
  const ds = stats.damSireSurface || {};

  // 対戦成績の評価（レーティング）：わかっている馬の中での相対値。わからない馬は平均より少し下とみなす
  const careers = rows.map((r) => careerOf(r.entry));
  const elos = careers.map((c) => c?.elo).filter((v) => Number.isFinite(v));
  const eloMax = elos.length ? Math.max(...elos) : 1500;
  const eloFill = (elos.length ? mean(elos) : 1500) - 40;
  const out = rows.map((r, i) => {
    const e = r.entry;
    const runs = r.runs;
    const an = r.an;
    const last = runs[0];
    const x = new Float64Array(FEATURE_NAMES.length);
    const set = (k, v) => {
      x[F[k]] = Number.isFinite(v) ? v : 0;
    };
    set('logq', logqs[i]);
    set('logqGap', logqs[i] - logqMax);
    set('logqShin', logqShin[i]);
    set('logqShinGap', logqShin[i] - logqShinMax);
    set('popRank', popRank[i]);
    set('placeKnown', placeOk ? 1 : 0);
    set('placeLog', Math.log(placeProb[i]));
    set('placeVsWin', placeOk ? Math.log(placeProb[i]) - Math.log(Math.max(hv[i], 1e-3)) : 0);
    set('placeSpread', placeOk ? Math.log(Math.max(e.placeMax, 1) / Math.max(e.placeMin, 1)) : 0);
    set('placeRankDiff', placeOk ? popRank[i] - placeRank[i] : 0);
    set('fSpeed', r.raw.speed ?? m.speed - 8);
    set('fSpeedRel', (r.raw.speed ?? m.speed - 8) - m.speed);
    set('fForm', r.raw.form ?? 0.3);
    set('fFormRel', (r.raw.form ?? 0.3) - m.form);
    set('fClosing', r.raw.closing ?? 0.5);
    set('fClosingRel', (r.raw.closing ?? 0.5) - m.closing);
    set('fJockey', r.raw.jockey);
    set('fTrainer', r.raw.trainer ?? 0.35 * tAvg.winRate + 0.65 * tAvg.top3Rate);
    set('fApt', r.raw.aptitude);
    set('fAptRel', r.raw.aptitude - m.aptitude);
    set('fPace', r.raw.pace);
    set('fDraw', r.raw.draw);
    set('fCond', r.raw.condition);
    set('age', e.age || 4);
    set('sexF', e.sex === '牝' ? 1 : 0);
    set('weight', e.weight || wMean);
    set('weightRel', (e.weight || wMean) - wMean);
    set('bodyWeight', e.bodyWeight || 470);
    set('bwDiff', Number.isFinite(e.bodyWeightDiff) ? e.bodyWeightDiff : 0);
    set('bwKnown', e.bodyWeight ? 1 : 0);
    set('n4', runs.length);
    set('lastFin', last ? fin01(last.finish, last.fieldSize || 16) : 0);
    set('lastMargin', last ? clamp(last.finish > 0 ? Math.max(0, last.margin ?? 0.8) : 3, 0, 5) : 2);
    set('meanPos', an.length ? an.reduce((a, b) => a + b.recency * b.pos, 0) / an.reduce((a, b) => a + b.recency, 0) : 0.3);
    set('wins4', runs.filter((q) => q.finish === 1).length);
    set('top3_4', runs.filter((q) => q.finish > 0 && q.finish <= 3).length);
    set('siBest4', siBest4[i] ?? siMax - 12);
    set('siBest4Rel', (siBest4[i] ?? siMax - 12) - siMax);
    set('siBest4Rank', siRank[i]);
    const sis = an.map((a) => a.si);
    set('siLast4', sis[0] ?? siMax - 12);
    const known = sis.filter((v) => v != null);
    set('siMean4', known.length ? mean(known) : siMax - 12);
    set('siTrend', known.length >= 2 ? known[0] - mean(known.slice(1)) : 0);
    set('daysSince', last ? clamp(daysBetween(last.date, race.date), 0, 400) : 400);
    set('classDelta', last ? today - classLevel(last.grade) : 0);
    set('lastClass', last ? classLevel(last.grade) : today);
    set('distDelta', last ? Math.abs((last.distance || race.distance) - race.distance) / 1000 : 0);
    set('sameSurf4', an.filter((a) => a.sameSurface).length);
    set('sameCourse4', runs.filter((q) => q.course === race.course).length);
    set('lastPop', last?.popularity > 0 ? Math.log(last.popularity) : 0);
    set('lastBeatenFav', last && last.popularity === 1 && last.finish > 3 ? 1 : 0);
    set('jockeyChange', last && last.jockey && e.jockey && last.jockey !== e.jockey ? 1 : 0);
    set('earlyPos', r.style.early ?? 0.45);
    set('styleKnown', r.style.early != null ? 1 : 0);
    const cl = an.filter((a) => a.closing != null).map((a) => a.closing);
    set('closingBest', cl.length ? Math.max(...cl) : 0.5);
    set('lastL3Rank', last?.last3fRank > 0 && last.fieldSize > 1 ? (last.last3fRank - 1) / (last.fieldSize - 1) : 0.5);
    set('lastFieldSize', last?.fieldSize || 0);
    set('lastOddsLog', last?.popularity > 0 && last.fieldSize > 0 ? Math.log((last.fieldSize + 1) / last.popularity) : 0);
    // 斤量の増減、騎手の乗り替わりによる勝率の変化、前走のスピード指数のレース内での位置
    set('weightDelta', last?.weight > 0 && e.weight > 0 ? clamp(e.weight - last.weight, -6, 6) : 0);
    const jNow = jk[e.jockey]?.winRate ?? jAvg.winRate;
    const jLast = last?.jockey ? jk[last.jockey]?.winRate ?? jAvg.winRate : jNow;
    set('jWinDelta', last?.jockey && last.jockey !== e.jockey ? jNow - jLast : 0);
    set('siLast4Rel', (sis[0] ?? siMax - 12) - siMax);
    const c = careers[i];
    set('cKnown', c ? 1 : 0);
    set('cStarts', c?.starts ?? 0);
    set('cWinRate', c ? (c.wins + 0.25) / (c.starts + 3) : 0.08);
    set('cTop3Rate', c ? (c.top3 + 0.7) / (c.starts + 3) : 0.23);
    set('cSiBest', c?.siBest ?? siMax - 12);
    set('cSiMean', c?.siMean ?? siMax - 12);
    set('cPosMean', c?.posMean ?? 0.4);
    set('cBestClass', c?.bestClass ?? today);
    set('cEloKnown', Number.isFinite(c?.elo) ? 1 : 0);
    set('cElo', Number.isFinite(c?.elo) ? c.elo : eloFill);
    set('cEloRel', (Number.isFinite(c?.elo) ? c.elo : eloFill) - eloMax);
    const j = jk[e.jockey];
    set('jWin', j?.winRate ?? jAvg.winRate);
    set('jTop3', j?.top3Rate ?? jAvg.top3Rate);
    set('jStarts', Math.log1p(j?.starts ?? 0));
    const t = tk[e.trainer];
    set('tWin', t?.winRate ?? tAvg.winRate);
    set('tTop3', t?.top3Rate ?? tAvg.top3Rate);
    set('jWinCourse', jc[`${e.jockey}|${race.course}`]?.winRate ?? j?.winRate ?? jAvg.winRate);
    set('tWinSurf', ts[`${e.trainer}|${race.surface}`]?.winRate ?? t?.winRate ?? tAvg.winRate);
    const pair = pr[`${e.jockey}|${e.trainer}`];
    set('pairWin', pair?.winRate ?? j?.winRate ?? jAvg.winRate);
    set('pairStarts', Math.log1p(pair?.starts ?? 0));
    set('h2h', h2h[i].v);
    set('h2hN', h2h[i].n);
    const sire = e.sire ? ss[`${e.sire}|${race.surface}`] : null;
    const dsire = e.damSire ? ds[`${e.damSire}|${race.surface}`] : null;
    set('sireKnown', sire ? 1 : 0);
    set('sireWinSurf', sire?.winRate ?? jAvg.winRate);
    set('sireTop3Surf', sire?.top3Rate ?? jAvg.top3Rate);
    set('sireStarts', Math.log1p(sire?.starts ?? 0));
    set('damSireWinSurf', dsire?.winRate ?? jAvg.winRate);
    set('n', n);
    set('isTurf', race.surface === '芝' ? 1 : 0);
    set('dist', (race.distance || 1600) / 1000);
    set('gradeLevel', today);
    set('heavy', heavy);
    set('straight', sb);
    set('drawInner', db * r.inner);
    set('handicap', handicap);
    set('qFav', qFav);
    set('qEntropy', qEntropy);
    return { entry: e, number: e.number, x, marketProb: r.marketProb, row: r };
  });
  return { rows: out, names: FEATURE_NAMES, pace: fx.pace };
}

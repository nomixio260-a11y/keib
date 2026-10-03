#!/usr/bin/env node
// レースごとの温度（荒れ具合）のモデル：p_i ∝ exp(スコア_i / T)、T = exp(θ・z) を、レースの条件 z（頭数・人気の散らばり・
// 1番人気の確率・クラス・芝ダ・距離・ハンデ・馬場・前走情報の少なさ）から決める。
// 木のスコアは分割外（out-of-fold）で作り、θ はその上で交差検証して効果を測る。検証期間は最後に1回だけ見る。
// 同時に、レースの「荒れ度」（人気3頭以外が勝つ確率）がモデル・市場でどれだけ当たるかも検証期間で測る。
//
//   node scripts/race-temp.mjs      環境変数：ROUNDS=820（木の本数）、FOLDS=5、TEST_START、OUT=結果 JSON

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { readJson, DATA_DIR } from '../src/collector/store.js';
import { DEFAULT_PARAMS, groupRaces, flatten, makeThresholds, binize, trainBoost, evalTrees, dateFolds } from './lib/boost.mjs';
import { GBDT_MODEL } from '../src/engine/gbdtModel.js';
import { treeSum, baseOf } from '../src/engine/gbdt.js';

const TEST_START = process.env.TEST_START || '2026-07-01';
const FOLDS = Number(process.env.FOLDS || 5);
const ROUNDS = Number(process.env.ROUNDS || 820);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const TOP16 = ['logq', 'logqGap', 'popRank', 'placeLog', 'placeVsWin', 'placeSpread', 'weightRel', 'jTop3', 'tWin', 'fFormRel', 'siBest4Rel', 'siLast4Rel', 'fSpeedRel', 'closingBest', 'daysSince', 'cEloRel'];
const Z_NAMES = ['n', 'qEntropy', 'qFav', 'gradeLevel', 'isTurf', 'dist', 'handicap', 'heavy'];

const ds = await readJson(process.env.DATASET_FILE || path.join(DATA_DIR, 'dataset.json'));
const names = ds.names;
const Fn = names.length;
const ix = (k) => { const i = names.indexOf(k); if (i < 0) throw new Error(`特徴量がありません: ${k}`); return i; };
const iLogq = ix('logq');
const iN4 = ix('n4');
const zIdx = Z_NAMES.map(ix);
const racesAll = groupRaces(ds.rows);
const trainRaces = racesAll.filter((rs) => rs[0].date < TEST_START && rs.length >= 2);
const testRaces = racesAll.filter((rs) => rs[0].date >= TEST_START && rs.length >= 2);

/** レースの条件 z（切片つき）：数値はあとで標準化する */
function rawZ(rs) {
  const x0 = rs[0].x;
  const z = zIdx.map((i) => x0[i]);
  z.push(rs.reduce((a, r) => a + (r.x[iN4] === 0 ? 1 : 0), 0) / rs.length); // 前走情報のない馬の割合
  z.push(rs.reduce((a, r) => a + r.x[iN4], 0) / rs.length / 4); // 前走数の平均（0〜1）
  return z;
}
const Z_LABELS = [...Z_NAMES, 'newShare', 'meanN4'];

// ---- 1) 分割外のスコア ----
const folds = dateFolds(trainRaces, FOLDS);
const feats = TOP16.map(ix);
const params = { ...DEFAULT_PARAMS, depth: 2, lr: 0.01, lambda: 10, colsample: 0.5, subsample: 0.6, rounds: ROUNDS, patience: 0 };
const oof = []; // { m:[], w:index of winner, z:[], date }
let oofLL = 0;
for (let k = 0; k < FOLDS; k++) {
  const t0 = Date.now();
  const fit = flatten(folds.filter((_, j) => j !== k).flat(), Fn, { baseIndex: iLogq });
  const thresholds = makeThresholds(fit);
  binize(fit, thresholds);
  const valid = binize(flatten(folds[k], Fn, { baseIndex: iLogq }), thresholds);
  const r = trainBoost({ fit, valids: [], thresholds, feats, params, seed: 1000 + k });
  const ev = evalTrees(r.trees, valid);
  for (let ri = 0; ri < valid.races.length; ri++) {
    const a = valid.start[ri];
    const b = valid.start[ri + 1];
    const m = Array.from(ev.m.subarray(a, b));
    let w = -1;
    for (let i = a; i < b; i++) if (valid.y[i]) w = i - a;
    if (w < 0) continue;
    oof.push({ m, w, z: rawZ(valid.races[ri]), date: valid.races[ri][0].date, q: valid.races[ri].map((row) => Math.exp(row.x[iLogq])) });
  }
  oofLL += ev.ll;
  log(`分割 ${k + 1}/${FOLDS}：判定 ${folds[k].length}レース LL ${ev.ll.toFixed(4)}（${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
}
log(`分割外のスコア：${oof.length}レース、LL ${(oofLL / FOLDS).toFixed(4)}`);

// ---- 2) 温度モデル ----
const K = Z_LABELS.length;
const mu = new Array(K).fill(0);
const sd = new Array(K).fill(1);
for (let j = 0; j < K; j++) {
  const v = oof.map((r) => r.z[j]);
  mu[j] = v.reduce((a, b) => a + b, 0) / v.length;
  sd[j] = Math.sqrt(v.reduce((a, b) => a + (b - mu[j]) ** 2, 0) / v.length) || 1;
}
const stdZ = (z) => [1, ...z.map((v, j) => (v - mu[j]) / sd[j])];
for (const r of oof) r.zs = stdZ(r.z);

function raceLogP(r, theta) {
  let u = 0;
  for (let j = 0; j < theta.length; j++) u += theta[j] * r.zs[j];
  const T = Math.exp(u);
  const a = r.m.map((v) => v / T);
  const mx = Math.max(...a);
  const e = a.map((v) => Math.exp(v - mx));
  const Z = e.reduce((s, v) => s + v, 0);
  const p = e.map((v) => v / Z);
  return { lp: Math.log(Math.max(p[r.w], 1e-12)), p, T };
}
function meanLL(races, theta) {
  let s = 0;
  for (const r of races) s += raceLogP(r, theta).lp;
  return s / races.length;
}
function fitTheta(races, { l2 = 1e-3, iters = 400, onlyIntercept = false } = {}) {
  const KK = races[0].zs.length;
  let theta = new Float64Array(KK);
  let ll = meanLL(races, theta);
  let step = 0.3;
  for (let it = 0; it < iters; it++) {
    const g = new Float64Array(KK);
    for (const r of races) {
      const { p, T } = raceLogP(r, theta);
      let pm = 0;
      for (let i = 0; i < p.length; i++) pm += p[i] * r.m[i];
      const gu = (pm - r.m[r.w]) / T;
      for (let j = 0; j < KK; j++) g[j] += gu * r.zs[j];
    }
    for (let j = 0; j < KK; j++) g[j] = g[j] / races.length - (j ? l2 * theta[j] : 0);
    if (onlyIntercept) for (let j = 1; j < KK; j++) g[j] = 0;
    const cand = theta.map((t, j) => t + step * g[j]);
    const llc = meanLL(races, cand);
    if (llc > ll) {
      theta = cand;
      ll = llc;
      step *= 1.3;
    } else step *= 0.5;
    if (step < 1e-7) break;
  }
  return { theta, ll };
}
// θ の交差検証（分割外スコアの上で、日付順に5分割）
const cvF = 5;
const per = Math.ceil(oof.length / cvF);
let cvT1 = 0;
let cvInt = 0;
let cvFull = 0;
for (let k = 0; k < cvF; k++) {
  const valid = oof.slice(k * per, (k + 1) * per);
  const fit = [...oof.slice(0, k * per), ...oof.slice((k + 1) * per)];
  const zero = new Float64Array(K + 1);
  const fi = fitTheta(fit, { onlyIntercept: true });
  const ff = fitTheta(fit);
  cvT1 += meanLL(valid, zero) * valid.length;
  cvInt += meanLL(valid, fi.theta) * valid.length;
  cvFull += meanLL(valid, ff.theta) * valid.length;
}
log(`θ の交差検証（分割外スコアの上）：T=1 ${(cvT1 / oof.length).toFixed(4)}、全体の温度だけ ${(cvInt / oof.length).toFixed(4)}（${(cvInt / oof.length - cvT1 / oof.length >= 0 ? '+' : '') + (cvInt / oof.length - cvT1 / oof.length).toFixed(4)}）、レースごとの温度 ${(cvFull / oof.length).toFixed(4)}（${(cvFull / oof.length - cvT1 / oof.length >= 0 ? '+' : '') + (cvFull / oof.length - cvT1 / oof.length).toFixed(4)}）`);
const full = fitTheta(oof);
const intc = fitTheta(oof, { onlyIntercept: true });
log(`全体の温度 T=${Math.exp(intc.theta[0]).toFixed(3)}。レースごとの θ：切片 ${full.theta[0].toFixed(3)} ${Z_LABELS.map((k, j) => `${k} ${full.theta[j + 1].toFixed(3)}`).join('、')}`);
{
  const Ts = oof.map((r) => raceLogP(r, full.theta).T).sort((a, b) => a - b);
  log(`レースごとの T の分布：5% ${Ts[Math.floor(Ts.length * 0.05)].toFixed(2)}、中央 ${Ts[Math.floor(Ts.length * 0.5)].toFixed(2)}、95% ${Ts[Math.floor(Ts.length * 0.95)].toFixed(2)}`);
}

// ---- 3) 検証期間（本番モデルのスコア）----
const prodT = GBDT_MODEL.temps?.[0] ?? 1;
const test = testRaces.map((rs) => {
  const m = rs.map((row) => baseOf(row.x[iLogq]) + treeSum(row.x));
  const w = rs.findIndex((row) => row.y);
  return { m, w, z: rawZ(rs), zs: stdZ(rawZ(rs)), date: rs[0].date, q: rs.map((row) => Math.exp(row.x[iLogq])) };
}).filter((r) => r.w >= 0);
const lpOf = (theta) => test.map((r) => raceLogP(r, theta).lp);
const lpProd = test.map((r) => raceLogP(r, Float64Array.from([Math.log(prodT), ...new Array(K).fill(0)])).lp);
const paired = (a, b) => {
  const d = a.map((v, i) => b[i] - v);
  const mean = d.reduce((s, v) => s + v, 0) / d.length;
  const se = Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / (d.length - 1) / d.length);
  return `${mean >= 0 ? '+' : ''}${mean.toFixed(4)} ± ${se.toFixed(4)}`;
};
const ll = (lp) => -lp.reduce((s, v) => s + v, 0) / lp.length;
const lp1 = lpOf(new Float64Array(K + 1));
const lpInt = lpOf(intc.theta);
const lpFull = lpOf(full.theta);
log(`検証 ${test.length}レース：本番（T=${prodT}）対数損失 ${ll(lpProd).toFixed(4)}、T=1 ${ll(lp1).toFixed(4)}（${paired(lpProd, lp1)}）、全体の温度 ${ll(lpInt).toFixed(4)}（${paired(lpProd, lpInt)}）、レースごとの温度 ${ll(lpFull).toFixed(4)}（${paired(lpProd, lpFull)}）`);

// ---- 4) 荒れ度：人気3頭以外が勝つ確率（モデル・市場）の当たり方 ----
function upsetStats(races, theta) {
  const rows = races.map((r) => {
    const { p } = raceLogP(r, theta);
    const qs = r.q.reduce((s, v) => s + v, 0);
    const q = r.q.map((v) => v / qs);
    const top3 = [...q.keys()].sort((a, b) => q[b] - q[a]).slice(0, 3);
    const pm = 1 - top3.reduce((s, i) => s + p[i], 0);
    const pq = 1 - top3.reduce((s, i) => s + q[i], 0);
    const upset = top3.includes(r.w) ? 0 : 1;
    const fav = top3[0];
    return { pm, pq, upset, favWin: r.w === fav ? 1 : 0, pFavM: p[fav], pFavQ: q[fav], winnerOdds: 1 / q[r.w] };
  });
  const bll = (key) => -rows.reduce((s, r) => s + (r.upset ? Math.log(Math.max(r[key], 1e-6)) : Math.log(Math.max(1 - r[key], 1e-6))), 0) / rows.length;
  const fll = (key) => -rows.reduce((s, r) => s + (r.favWin ? Math.log(Math.max(r[key], 1e-6)) : Math.log(Math.max(1 - r[key], 1e-6))), 0) / rows.length;
  return { rows, upsetLL: { model: bll('pm'), market: bll('pq') }, favLL: { model: fll('pFavM'), market: fll('pFavQ') } };
}
const prodTheta = Float64Array.from([Math.log(prodT), ...new Array(K).fill(0)]);
const oofU = upsetStats(oof, new Float64Array(K + 1));
const pmSorted = oofU.rows.map((r) => r.pm).sort((a, b) => a - b);
const cut1 = pmSorted[Math.floor(pmSorted.length / 3)];
const cut2 = pmSorted[Math.floor((2 * pmSorted.length) / 3)];
log(`荒れ度（人気3頭以外が勝つ確率）の3分位（学習期間の分割外）：${cut1.toFixed(3)} / ${cut2.toFixed(3)}`);
const tU = upsetStats(test, prodTheta);
log(`検証：「人気3頭以外が勝つ」の二値対数損失 モデル ${tU.upsetLL.model.toFixed(4)} 市場 ${tU.upsetLL.market.toFixed(4)}、「1番人気が勝つ」 モデル ${tU.favLL.model.toFixed(4)} 市場 ${tU.favLL.market.toFixed(4)}`);
const buckets = [['堅い', (r) => r.pm < cut1], ['普通', (r) => r.pm >= cut1 && r.pm < cut2], ['荒れ', (r) => r.pm >= cut2]];
const bucketOut = [];
for (const [label, f] of buckets) {
  const rs = tU.rows.filter(f);
  if (!rs.length) continue;
  const n = rs.length;
  const o = { label, n, predUpset: rs.reduce((s, r) => s + r.pm, 0) / n, upset: rs.reduce((s, r) => s + r.upset, 0) / n, favWin: rs.reduce((s, r) => s + r.favWin, 0) / n, medWinnerOdds: rs.map((r) => r.winnerOdds).sort((a, b) => a - b)[Math.floor(n / 2)] };
  bucketOut.push(o);
  log(`  ${label}：${n}レース 予測 ${(o.predUpset * 100).toFixed(1)}% → 実際に人気3頭以外が勝った ${(o.upset * 100).toFixed(1)}%、1番人気の勝率 ${(o.favWin * 100).toFixed(1)}%、勝ち馬の市場オッズの中央値 ${o.medWinnerOdds.toFixed(1)}倍`);
}
if (process.env.OUT) {
  await writeFile(process.env.OUT, JSON.stringify({ testStart: TEST_START, rounds: ROUNDS, oofRaces: oof.length, cv: { t1: cvT1 / oof.length, intercept: cvInt / oof.length, full: cvFull / oof.length }, globalT: Math.exp(intc.theta[0]), theta: Array.from(full.theta), zLabels: ['intercept', ...Z_LABELS], mu, sd, test: { n: test.length, prodT, ll: { prod: ll(lpProd), t1: ll(lp1), intercept: ll(lpInt), full: ll(lpFull) } }, upset: { cuts: [cut1, cut2], testLL: tU.upsetLL, favLL: tU.favLL, buckets: bucketOut } }, null, 1));
  log(`書き出しました：${process.env.OUT}`);
}

#!/usr/bin/env node
// 荒れ度専用のレース単位モデル：「人気3頭（単勝オッズ順）以外が勝つ」をレースの特徴から直接学習する（ロジスティック回帰・リッジ）。
// 入力は、馬ごとのモデル（木）の勝率から出した荒れ度・市場の荒れ度に加えて、レースの条件（頭数・クラス・距離・馬場・人気の散らばり）、
// 馬の履歴の集計（前走情報のない馬の割合・平均の走数）、モデルの補正の分布（人気薄に強い馬がいるか、人気馬に弱い馬がいるか）、
// 騎手の成績の差、先行馬の数など。木のスコアは分割外で作り、θ はその上で交差検証。検証期間は最後に1回。
//
//   node scripts/upset-model.mjs   環境変数：ROUNDS=820、FOLDS=5、TEST_START、OUT=結果 JSON

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

const ds = await readJson(process.env.DATASET_FILE || path.join(DATA_DIR, 'dataset.json'));
const names = ds.names;
const Fn = names.length;
const ix = (k) => { const i = names.indexOf(k); if (i < 0) throw new Error(`特徴量がありません: ${k}`); return i; };
const I = Object.fromEntries(['logq', 'n', 'isTurf', 'dist', 'gradeLevel', 'heavy', 'handicap', 'qEntropy', 'n4', 'cStarts', 'jTop3', 'earlyPos', 'styleKnown', 'straight', 'placeSpread', 'daysSince'].map((k) => [k, ix(k)]));
const racesAll = groupRaces(ds.rows);
const trainRaces = racesAll.filter((rs) => rs[0].date < TEST_START && rs.length >= 4);
const testRaces = racesAll.filter((rs) => rs[0].date >= TEST_START && rs.length >= 4);

const logit = (p) => Math.log(Math.max(p, 1e-4) / Math.max(1 - p, 1e-4));
const Z_LABELS = ['logitModelUpset', 'logitMarketUpset', 'logitPFav', 'pGap12', 'n', 'isTurf', 'dist', 'gradeLevel', 'heavy', 'handicap', 'qEntropy', 'newShare', 'meanN4', 'meanCStarts', 'adjMaxNonTop3', 'adjMinTop3', 'adjSumTop3', 'nContenders', 'jTop3Gap', 'frontRunners', 'straight', 'q4vs3', 'placeSpreadMean', 'meanDaysSince'];
/** レースの特徴 z と目的 y。m：馬ごとのスコア（出発点＋木）、T：温度 */
function raceRow(rs, m, T = 1) {
  const n = rs.length;
  const base = rs.map((r) => r.x[I.logq]);
  const qRaw = base.map((v) => Math.exp(v));
  const qs = qRaw.reduce((a, b) => a + b, 0);
  const q = qRaw.map((v) => v / qs);
  const a = m.map((v) => v / T);
  const mx = Math.max(...a);
  const e = a.map((v) => Math.exp(v - mx));
  const Z = e.reduce((s, v) => s + v, 0);
  const p = e.map((v) => v / Z);
  const byQ = [...q.keys()].sort((i, j) => q[j] - q[i] || rs[i].number - rs[j].number);
  const top3 = byQ.slice(0, 3);
  const inTop3 = new Set(top3);
  const pUp = 1 - top3.reduce((s, i) => s + p[i], 0);
  const qUp = 1 - top3.reduce((s, i) => s + q[i], 0);
  const pSorted = [...p].sort((x, y) => y - x);
  const adj = m.map((v, i) => v - base[i]);
  const non3 = [...q.keys()].filter((i) => !inTop3.has(i));
  const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
  const x0 = rs[0].x;
  const w = rs.findIndex((r) => r.y);
  const z = [
    logit(pUp), logit(qUp), logit(p[top3[0]]), pSorted[0] - pSorted[1],
    n, x0[I.isTurf], x0[I.dist], x0[I.gradeLevel], x0[I.heavy], x0[I.handicap], x0[I.qEntropy],
    rs.filter((r) => r.x[I.n4] === 0).length / n, mean(rs.map((r) => r.x[I.n4])), mean(rs.map((r) => r.x[I.cStarts])),
    Math.max(...non3.map((i) => adj[i])), Math.min(...top3.map((i) => adj[i])), top3.reduce((s, i) => s + adj[i], 0),
    p.filter((v) => v >= 0.1).length,
    mean(top3.map((i) => rs[i].x[I.jTop3])) - mean(non3.map((i) => rs[i].x[I.jTop3])),
    rs.filter((r) => r.x[I.styleKnown] && r.x[I.earlyPos] > 0.7).length,
    x0[I.straight], Math.log(Math.max(q[byQ[3]] ?? 1e-4, 1e-4) / Math.max(q[byQ[2]], 1e-4)),
    mean(rs.map((r) => r.x[I.placeSpread])), mean(rs.map((r) => r.x[I.daysSince])),
  ];
  return { z, y: w >= 0 && !inTop3.has(w) ? 1 : 0, pUp, qUp, ok: w >= 0 };
}

// ---- 1) 分割外のスコア → レースの特徴 ----
const folds = dateFolds(trainRaces, FOLDS);
const feats = TOP16.map(ix);
const params = { ...DEFAULT_PARAMS, depth: 2, lr: 0.01, lambda: 10, colsample: 0.5, subsample: 0.6, rounds: ROUNDS, patience: 0 };
const oof = [];
for (let k = 0; k < FOLDS; k++) {
  const t0 = Date.now();
  const fit = flatten(folds.filter((_, j) => j !== k).flat(), Fn, { baseIndex: I.logq });
  const thresholds = makeThresholds(fit);
  binize(fit, thresholds);
  const valid = binize(flatten(folds[k], Fn, { baseIndex: I.logq }), thresholds);
  const r = trainBoost({ fit, valids: [], thresholds, feats, params, seed: 1000 + k });
  const ev = evalTrees(r.trees, valid);
  for (let ri = 0; ri < valid.races.length; ri++) {
    const a = valid.start[ri];
    const b = valid.start[ri + 1];
    const row = raceRow(valid.races[ri], Array.from(ev.m.subarray(a, b)), 1);
    if (row.ok) oof.push(row);
  }
  log(`分割 ${k + 1}/${FOLDS}：${folds[k].length}レース（${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
}
log(`分割外のレース ${oof.length}、人気3頭以外が勝った割合 ${(100 * oof.reduce((s, r) => s + r.y, 0) / oof.length).toFixed(1)}%`);

// ---- 2) ロジスティック回帰（リッジ）----
const K = Z_LABELS.length;
const mu = new Array(K).fill(0);
const sd = new Array(K).fill(1);
for (let j = 0; j < K; j++) {
  const v = oof.map((r) => r.z[j]);
  mu[j] = v.reduce((a, b) => a + b, 0) / v.length;
  sd[j] = Math.max(Math.sqrt(v.reduce((a, b) => a + (b - mu[j]) ** 2, 0) / v.length), 1e-3);
}
// 標準化した値は ±5 に収める（分割外と本番でスコアの散らばりが違っても暴れないように）
const stdZ = (z, cols) => [1, ...cols.map((j) => Math.max(-5, Math.min(5, (z[j] - mu[j]) / sd[j])))];
const sigmoid = (u) => 1 / (1 + Math.exp(-u));
const bll = (rows, probOf) => -rows.reduce((s, r) => { const p = Math.min(1 - 1e-6, Math.max(1e-6, probOf(r))); return s + (r.y ? Math.log(p) : Math.log(1 - p)); }, 0) / rows.length;
function fitLogit(rows, cols, { l2 = 3, iters = 600 } = {}) {
  const X = rows.map((r) => stdZ(r.z, cols));
  const KK = cols.length + 1;
  let theta = new Float64Array(KK);
  let step = 0.5;
  const nll = (th) => -X.reduce((s, x, i) => { let u = 0; for (let j = 0; j < KK; j++) u += th[j] * x[j]; const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(u))); return s + (rows[i].y ? Math.log(p) : Math.log(1 - p)); }, 0) / rows.length + (l2 / (2 * rows.length)) * theta.slice(1).reduce((s, v) => s + v * v, 0);
  let cur = nll(theta);
  for (let it = 0; it < iters; it++) {
    const g = new Float64Array(KK);
    X.forEach((x, i) => { let u = 0; for (let j = 0; j < KK; j++) u += theta[j] * x[j]; const d = sigmoid(u) - rows[i].y; for (let j = 0; j < KK; j++) g[j] += d * x[j]; });
    for (let j = 0; j < KK; j++) g[j] = g[j] / rows.length + (j ? (l2 * theta[j]) / rows.length : 0);
    const cand = theta.map((t, j) => t - step * g[j]);
    const c = nll(cand);
    if (c < cur) { theta = cand; cur = c; step *= 1.2; } else step *= 0.5;
    if (step < 1e-7) break;
  }
  const predict = (r) => { const x = stdZ(r.z, cols); let u = 0; for (let j = 0; j < KK; j++) u += theta[j] * x[j]; return sigmoid(u); };
  return { theta, predict };
}
const ALL = [...Array(K).keys()];
const sets = { '市場の荒れ度だけ（再校正）': [1], 'モデルの荒れ度だけ（再校正）': [0], 'モデル＋市場': [0, 1], 'すべて': ALL };
const cvF = 5;
const per = Math.ceil(oof.length / cvF);
const cv = { 市場そのまま: 0, モデルそのまま: 0 };
for (const k of Object.keys(sets)) cv[k] = 0;
for (let k = 0; k < cvF; k++) {
  const valid = oof.slice(k * per, (k + 1) * per);
  const fit = [...oof.slice(0, k * per), ...oof.slice((k + 1) * per)];
  cv['市場そのまま'] += bll(valid, (r) => r.qUp) * valid.length;
  cv['モデルそのまま'] += bll(valid, (r) => r.pUp) * valid.length;
  for (const [label, cols] of Object.entries(sets)) cv[label] += bll(valid, fitLogit(fit, cols).predict) * valid.length;
}
log(`交差検証（分割外、二値の対数損失。小さいほど良い）：${Object.entries(cv).map(([k, v]) => `${k} ${(v / oof.length).toFixed(4)}`).join('、')}`);
const full = fitLogit(oof, ALL);
const coef = Z_LABELS.map((k, j) => ({ name: k, w: full.theta[j + 1] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
log(`係数（標準化した特徴量あたり、大きい順）：${coef.slice(0, 12).map((c) => `${c.name} ${c.w.toFixed(3)}`).join('、')}`);
const two = fitLogit(oof, [0, 1]);

// ---- 3) 検証期間（本番モデルのスコア）----
const prodT = GBDT_MODEL.temps?.[0] ?? 1;
const test = testRaces.map((rs) => raceRow(rs, rs.map((row) => baseOf(row.x[I.logq]) + treeSum(row.x)), prodT)).filter((r) => r.ok);
const paired = (fa, fb) => {
  const d = test.map((r) => { const la = r.y ? Math.log(fa(r)) : Math.log(1 - fa(r)); const lb = r.y ? Math.log(fb(r)) : Math.log(1 - fb(r)); return lb - la; });
  const mean = d.reduce((s, v) => s + v, 0) / d.length;
  const se = Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / (d.length - 1) / d.length);
  return `${mean >= 0 ? '+' : ''}${mean.toFixed(4)} ± ${se.toFixed(4)}`;
};
const clip = (f) => (r) => Math.min(1 - 1e-6, Math.max(1e-6, f(r)));
const tM = clip((r) => r.qUp);
const tP = clip((r) => r.pUp);
const tTwo = clip(two.predict);
const tFull = clip(full.predict);
log(`検証 ${test.length}レース：市場そのまま ${bll(test, tM).toFixed(4)}、モデルそのまま ${bll(test, tP).toFixed(4)}（市場との差 ${paired(tM, tP)}）、モデル＋市場の再校正 ${bll(test, tTwo).toFixed(4)}（モデルそのままとの差 ${paired(tP, tTwo)}）、すべて ${bll(test, tFull).toFixed(4)}（${paired(tP, tFull)}）`);
// 3分位での当てはまり（すべて のモデル）
const cuts = (() => { const v = oof.map((r) => full.predict(r)).sort((a, b) => a - b); return [v[Math.floor(v.length / 3)], v[Math.floor((2 * v.length) / 3)]]; })();
for (const [label, f] of [['堅い', (p) => p < cuts[0]], ['普通', (p) => p >= cuts[0] && p < cuts[1]], ['荒れ', (p) => p >= cuts[1]]]) {
  const rs = test.filter((r) => f(full.predict(r)));
  if (rs.length) log(`  ${label}：${rs.length}レース 予測 ${(100 * rs.reduce((s, r) => s + full.predict(r), 0) / rs.length).toFixed(1)}% → 実際 ${(100 * rs.reduce((s, r) => s + r.y, 0) / rs.length).toFixed(1)}%`);
}
if (process.env.OUT) {
  await writeFile(process.env.OUT, JSON.stringify({ testStart: TEST_START, rounds: ROUNDS, oofRaces: oof.length, labels: Z_LABELS, mu, sd, theta: Array.from(full.theta), thetaTwo: Array.from(two.theta), cv: Object.fromEntries(Object.entries(cv).map(([k, v]) => [k, v / oof.length])), test: { n: test.length, market: bll(test, tM), model: bll(test, tP), two: bll(test, tTwo), full: bll(test, tFull) }, cuts, coef }, null, 1));
  log(`書き出しました：${process.env.OUT}`);
}

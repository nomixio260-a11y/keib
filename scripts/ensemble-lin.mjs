#!/usr/bin/env node
// 別の種類のモデルとのアンサンブル：決定木（勾配ブースティング）と、全特徴量の線形モデル（リッジ正則化つきの
// 条件付きロジット＝プラケット・ルース 1着）を分割外のスコアで混ぜ、混ぜる重みも分割外で決める。
// 木とは違う形（線形・全項目）の誤りをしていれば、平均すると良くなるはず。検証期間は最後に1回だけ見る。
//
//   node scripts/ensemble-lin.mjs   環境変数：ROUNDS=820、FOLDS=5、LAMBDAS=3,10,30、TEST_START、OUT

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { readJson, DATA_DIR } from '../src/collector/store.js';
import { DEFAULT_PARAMS, groupRaces, flatten, makeThresholds, binize, trainBoost, evalTrees, dateFolds } from './lib/boost.mjs';
import { GBDT_MODEL } from '../src/engine/gbdtModel.js';
import { treeSum, baseOf } from '../src/engine/gbdt.js';

const TEST_START = process.env.TEST_START || '2026-07-01';
const FOLDS = Number(process.env.FOLDS || 5);
const ROUNDS = Number(process.env.ROUNDS || 820);
const LAMBDAS = (process.env.LAMBDAS || '3,10,30').split(',').map(Number);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const TOP16 = ['logq', 'logqGap', 'popRank', 'placeLog', 'placeVsWin', 'placeSpread', 'weightRel', 'jTop3', 'tWin', 'fFormRel', 'siBest4Rel', 'siLast4Rel', 'fSpeedRel', 'closingBest', 'daysSince', 'cEloRel'];

const ds = await readJson(process.env.DATASET_FILE || path.join(DATA_DIR, 'dataset.json'));
const names = ds.names;
const Fn = names.length;
const ix = (k) => { const i = names.indexOf(k); if (i < 0) throw new Error(`特徴量がありません: ${k}`); return i; };
const iLogq = ix('logq');
// 線形モデルに使う列：馬体重（発走1時間前まで出ない）以外の全部
const linOnly = (process.env.LIN_ONLY || '').split(',').filter(Boolean);
const linCols = [...Array(Fn).keys()].filter((f) => !['bodyWeight', 'bwDiff', 'bwKnown'].includes(names[f]) && (!linOnly.length || linOnly.includes(names[f])));
const racesAll = groupRaces(ds.rows);
const trainRaces = racesAll.filter((rs) => rs[0].date < TEST_START && rs.length >= 2);
const testRaces = racesAll.filter((rs) => rs[0].date >= TEST_START && rs.length >= 2);

// ---- 線形モデル：score_i = logq_i + w・x̃_i（x̃ は学習データで標準化）。リッジ正則化、全バッチの勾配上昇 ----
function standardizer(races) {
  const K = linCols.length;
  const mu = new Float64Array(K);
  const sd = new Float64Array(K);
  let n = 0;
  for (const rs of races) for (const r of rs) { n++; for (let j = 0; j < K; j++) mu[j] += r.x[linCols[j]]; }
  for (let j = 0; j < K; j++) mu[j] /= n;
  for (const rs of races) for (const r of rs) for (let j = 0; j < K; j++) sd[j] += (r.x[linCols[j]] - mu[j]) ** 2;
  for (let j = 0; j < K; j++) sd[j] = Math.sqrt(sd[j] / n) || 1;
  return { mu, sd, K };
}
function pack(races, st) {
  const K = st.K;
  const n = races.reduce((a, rs) => a + rs.length, 0);
  const X = new Float64Array(n * K);
  const base = new Float64Array(n);
  const start = new Int32Array(races.length + 1);
  const w = new Int32Array(races.length).fill(-1);
  let k = 0;
  races.forEach((rs, ri) => {
    start[ri] = k;
    for (const r of rs) {
      for (let j = 0; j < K; j++) X[k * K + j] = (r.x[linCols[j]] - st.mu[j]) / st.sd[j];
      base[k] = r.x[iLogq];
      if (r.y) w[ri] = k;
      k++;
    }
  });
  start[races.length] = k;
  return { n, X, base, start, w, R: races.length, K };
}
function linScores(d, wv) {
  const s = new Float64Array(d.n);
  for (let i = 0; i < d.n; i++) {
    let v = d.base[i];
    const o = i * d.K;
    for (let j = 0; j < d.K; j++) v += wv[j] * d.X[o + j];
    s[i] = v;
  }
  return s;
}
function raceLL(d, s, grad = null, wv = null, lambda = 0) {
  let ll = 0;
  const p = new Float64Array(d.n);
  for (let ri = 0; ri < d.R; ri++) {
    const a = d.start[ri];
    const b = d.start[ri + 1];
    if (d.w[ri] < 0) continue;
    let mx = -Infinity;
    for (let i = a; i < b; i++) if (s[i] > mx) mx = s[i];
    let Z = 0;
    for (let i = a; i < b; i++) { p[i] = Math.exp(s[i] - mx); Z += p[i]; }
    for (let i = a; i < b; i++) p[i] /= Z;
    ll += Math.log(Math.max(p[d.w[ri]], 1e-12));
    if (grad) {
      const wo = d.w[ri] * d.K;
      for (let j = 0; j < d.K; j++) grad[j] += d.X[wo + j];
      for (let i = a; i < b; i++) { const o = i * d.K; const pi = p[i]; for (let j = 0; j < d.K; j++) grad[j] -= pi * d.X[o + j]; }
    }
  }
  if (grad) for (let j = 0; j < d.K; j++) grad[j] = grad[j] / d.R - lambda * wv[j] / d.R;
  return ll / d.R;
}
function fitLinear(d, lambda, iters = 300) {
  let wv = new Float64Array(d.K);
  let ll = raceLL(d, linScores(d, wv));
  let step = 0.05;
  for (let it = 0; it < iters; it++) {
    const g = new Float64Array(d.K);
    raceLL(d, linScores(d, wv), g, wv, lambda);
    const cand = wv.map((v, j) => v + step * g[j]);
    const llc = raceLL(d, linScores(d, cand));
    if (llc > ll) { wv = cand; ll = llc; step *= 1.2; } else step *= 0.5;
    if (step < 1e-8) break;
  }
  return { w: wv, ll };
}

// ---- 分割外のスコア（木・線形）----
const folds = dateFolds(trainRaces, FOLDS);
const feats = TOP16.map(ix);
const params = { ...DEFAULT_PARAMS, depth: 2, lr: 0.01, lambda: 10, colsample: 0.5, subsample: 0.6, rounds: ROUNDS, patience: 0 };
const oof = []; // { base, g (木の補正), l:{lambda: 線形の補正}, w }
const perLambdaLL = Object.fromEntries(LAMBDAS.map((l) => [l, 0]));
let gbdtLL = 0;
let baseLL = 0;
for (let k = 0; k < FOLDS; k++) {
  const t0 = Date.now();
  const fitRaces = folds.filter((_, j) => j !== k).flat();
  const fit = flatten(fitRaces, Fn, { baseIndex: iLogq });
  const thresholds = makeThresholds(fit);
  binize(fit, thresholds);
  const valid = binize(flatten(folds[k], Fn, { baseIndex: iLogq }), thresholds);
  const r = trainBoost({ fit, valids: [], thresholds, feats, params, seed: 1000 + k });
  const ev = evalTrees(r.trees, valid);
  const base = evalTrees([], valid);
  const st = standardizer(fitRaces);
  const dFit = pack(fitRaces, st);
  const dVal = pack(folds[k], st);
  const lin = {};
  for (const lambda of LAMBDAS) {
    const f = fitLinear(dFit, lambda);
    const s = linScores(dVal, f.w);
    lin[lambda] = s;
    perLambdaLL[lambda] += raceLL(dVal, s);
  }
  for (let ri = 0; ri < valid.races.length; ri++) {
    const a = valid.start[ri];
    const b = valid.start[ri + 1];
    let w = -1;
    for (let i = a; i < b; i++) if (valid.y[i]) w = i - a;
    if (w < 0) continue;
    const baseArr = Array.from(valid.base.subarray(a, b));
    oof.push({ base: baseArr, g: Array.from(ev.m.subarray(a, b)).map((v, i) => v - baseArr[i]), l: Object.fromEntries(LAMBDAS.map((l) => [l, Array.from(lin[l].subarray(a, b)).map((v, i) => v - baseArr[i])])), w });
  }
  gbdtLL += ev.ll;
  baseLL += base.ll;
  log(`分割 ${k + 1}/${FOLDS}：市場 ${base.ll.toFixed(4)} 木 ${ev.ll.toFixed(4)} 線形 ${LAMBDAS.map((l) => `λ${l} ${raceLL(dVal, lin[l]).toFixed(4)}`).join(' ')}（${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
}
log(`分割外：市場 ${(baseLL / FOLDS).toFixed(4)} 木 ${(gbdtLL / FOLDS).toFixed(4)}（+${(gbdtLL / FOLDS - baseLL / FOLDS).toFixed(4)}） 線形 ${LAMBDAS.map((l) => `λ${l} ${(perLambdaLL[l] / FOLDS).toFixed(4)}（${(perLambdaLL[l] / FOLDS - baseLL / FOLDS >= 0 ? '+' : '') + (perLambdaLL[l] / FOLDS - baseLL / FOLDS).toFixed(4)}）`).join(' ')}`);
const bestLambda = LAMBDAS.reduce((a, b) => (perLambdaLL[b] > perLambdaLL[a] ? b : a));

// ---- 混ぜる重み（a：木、b：線形）を分割外で交差検証 ----
function lpOf(r, a, b, lambda) {
  const s = r.base.map((v, i) => v + a * r.g[i] + b * r.l[lambda][i]);
  const mx = Math.max(...s);
  const Z = s.reduce((acc, v) => acc + Math.exp(v - mx), 0);
  return s[r.w] - mx - Math.log(Z);
}
const meanLP = (rs, a, b, lambda) => rs.reduce((acc, r) => acc + lpOf(r, a, b, lambda), 0) / rs.length;
function fitBlend(rs, lambda) {
  let best = { a: 1, b: 0, ll: meanLP(rs, 1, 0, lambda) };
  for (let a = 0; a <= 1.4001; a += 0.1) for (let b = 0; b <= 1.4001; b += 0.1) {
    const ll = meanLP(rs, a, b, lambda);
    if (ll > best.ll + 1e-9) best = { a: +a.toFixed(2), b: +b.toFixed(2), ll };
  }
  return best;
}
const cvF = 5;
const per = Math.ceil(oof.length / cvF);
let cvG = 0;
let cvL = 0;
let cvB = 0;
for (let k = 0; k < cvF; k++) {
  const valid = oof.slice(k * per, (k + 1) * per);
  const fit = [...oof.slice(0, k * per), ...oof.slice((k + 1) * per)];
  const bl = fitBlend(fit, bestLambda);
  cvG += meanLP(valid, 1, 0, bestLambda) * valid.length;
  cvL += meanLP(valid, 0, 1, bestLambda) * valid.length;
  cvB += meanLP(valid, bl.a, bl.b, bestLambda) * valid.length;
}
const blend = fitBlend(oof, bestLambda);
log(`混合の交差検証（λ${bestLambda}）：木だけ ${(cvG / oof.length).toFixed(4)}、線形だけ ${(cvL / oof.length).toFixed(4)}、混合 ${(cvB / oof.length).toFixed(4)}（木との差 ${(cvB / oof.length - cvG / oof.length >= 0 ? '+' : '') + (cvB / oof.length - cvG / oof.length).toFixed(4)}）。全体で選んだ重み 木 ${blend.a}・線形 ${blend.b}`);

// ---- 検証期間：本番の木 ＋ 全学習データで学習した線形 ----
const stAll = standardizer(trainRaces);
const dAll = pack(trainRaces, stAll);
const linAll = fitLinear(dAll, bestLambda);
const dTest = pack(testRaces, stAll);
const sLin = linScores(dTest, linAll.w);
const prodT = GBDT_MODEL.temps?.[0] ?? 1;
const test = testRaces.map((rs, ri) => {
  const base = rs.map((row) => row.x[iLogq]);
  const g = rs.map((row) => baseOf(row.x[iLogq]) + treeSum(row.x) - row.x[iLogq]);
  const a = dTest.start[ri];
  const l = rs.map((row, i) => sLin[a + i] - base[i]);
  const w = rs.findIndex((row) => row.y);
  return { base, g, l: { [bestLambda]: l }, w };
}).filter((r) => r.w >= 0);
const lpT = (r, a, b) => { // 本番は木のスコアを温度 prodT で割る
  const s = r.base.map((v, i) => (v + a * r.g[i] + b * r.l[bestLambda][i]) / prodT);
  const mx = Math.max(...s);
  const Z = s.reduce((acc, v) => acc + Math.exp(v - mx), 0);
  return s[r.w] - mx - Math.log(Z);
};
const paired = (x, y) => {
  const d = x.map((v, i) => y[i] - v);
  const mean = d.reduce((s, v) => s + v, 0) / d.length;
  const se = Math.sqrt(d.reduce((s, v) => s + (v - mean) ** 2, 0) / (d.length - 1) / d.length);
  return `${mean >= 0 ? '+' : ''}${mean.toFixed(4)} ± ${se.toFixed(4)}`;
};
const ll = (lp) => -lp.reduce((s, v) => s + v, 0) / lp.length;
const lpProd = test.map((r) => lpT(r, 1, 0));
const lpLin = test.map((r) => lpT(r, 0, 1));
const lpBlend = test.map((r) => lpT(r, blend.a, blend.b));
const lpHalf = test.map((r) => lpT(r, 0.5, 0.5));
log(`検証 ${test.length}レース：本番（木）${ll(lpProd).toFixed(4)}、線形だけ ${ll(lpLin).toFixed(4)}（${paired(lpProd, lpLin)}）、混合（木 ${blend.a}・線形 ${blend.b}）${ll(lpBlend).toFixed(4)}（${paired(lpProd, lpBlend)}）、半々 ${ll(lpHalf).toFixed(4)}（${paired(lpProd, lpHalf)}）`);
// 線形モデルの係数の大きい順（標準化した特徴量あたり）
const coef = linCols.map((f, j) => ({ name: names[f], w: linAll.w[j] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
log(`線形モデルの係数（絶対値の大きい順）：${coef.slice(0, 15).map((c) => `${c.name} ${c.w.toFixed(3)}`).join('、')}`);
if (process.env.OUT) {
  await writeFile(process.env.OUT, JSON.stringify({ testStart: TEST_START, rounds: ROUNDS, lambdas: LAMBDAS, bestLambda, oof: { base: baseLL / FOLDS, gbdt: gbdtLL / FOLDS, lin: perLambdaLL, cv: { gbdt: cvG / oof.length, lin: cvL / oof.length, blend: cvB / oof.length } }, blend, test: { n: test.length, prod: ll(lpProd), lin: ll(lpLin), blend: ll(lpBlend), half: ll(lpHalf) }, coef }, null, 1));
  log(`書き出しました：${process.env.OUT}`);
}

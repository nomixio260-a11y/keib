#!/usr/bin/env node
// 着順ごとの温度（1着・2着・3着の紛れの大きさ）を、学習データの内側ではなく分割外（out-of-fold）のスコアで推定し直し、
// 検証期間で 1着の対数損失と 2着内・3着内（複勝）の二値の対数損失を比べる。シミュレーション（PL）の精度改善の検証。
//   node scripts/temps-check.mjs   環境変数：ROUNDS=820、FOLDS=5、TEST_START、OUT

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { readJson, DATA_DIR } from '../src/collector/store.js';
import { DEFAULT_PARAMS, groupRaces, flatten, makeThresholds, binize, trainBoost, evalTrees, dateFolds, fitTemps } from './lib/boost.mjs';
import { GBDT_MODEL } from '../src/engine/gbdtModel.js';
import { treeSum, baseOf } from '../src/engine/gbdt.js';
import { exactPL } from '../src/engine/simulate.js';

const TEST_START = process.env.TEST_START || '2026-07-01';
const FOLDS = Number(process.env.FOLDS || 5);
const ROUNDS = Number(process.env.ROUNDS || 820);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const TOP16 = ['logq', 'logqGap', 'popRank', 'placeLog', 'placeVsWin', 'placeSpread', 'weightRel', 'jTop3', 'tWin', 'fFormRel', 'siBest4Rel', 'siLast4Rel', 'fSpeedRel', 'closingBest', 'daysSince', 'cEloRel'];
const ds = await readJson(process.env.DATASET_FILE || path.join(DATA_DIR, 'dataset.json'));
const names = ds.names;
const Fn = names.length;
const ix = (k) => names.indexOf(k);
const iLogq = ix('logq');
const racesAll = groupRaces(ds.rows);
const trainRaces = racesAll.filter((rs) => rs[0].date < TEST_START && rs.length >= 2);
const testRaces = racesAll.filter((rs) => rs[0].date >= TEST_START && rs.length >= 5);

// 分割外のスコアを1つにまとめた平らな配列（fitTemps 用）
const folds = dateFolds(trainRaces, FOLDS);
const feats = TOP16.map(ix);
const params = { ...DEFAULT_PARAMS, depth: 2, lr: 0.01, lambda: 10, colsample: 0.5, subsample: 0.6, rounds: ROUNDS, patience: 0 };
const pooled = { races: [], start: [0], finish: [], margin: [] };
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
    pooled.races.push(valid.races[ri]);
    for (let i = a; i < b; i++) { pooled.finish.push(valid.finish[i]); pooled.margin.push(ev.m[i]); }
    pooled.start.push(pooled.finish.length);
  }
  log(`分割 ${k + 1}/${FOLDS}（${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
}
const d = { races: pooled.races, start: Int32Array.from(pooled.start), finish: Int16Array.from(pooled.finish) };
const oofTemps = fitTemps(d, Float64Array.from(pooled.margin));
const prodTemps = GBDT_MODEL.temps || [1, 1, 1];
log(`温度：いま（学習の内側で推定）${JSON.stringify(prodTemps)} → 分割外で推定 ${JSON.stringify(oofTemps)}`);

// 検証期間：1着の対数損失、2着内・3着内の二値の対数損失、PL の 2・3着段階の対数尤度
function evalTemps(temps) {
  let llWin = 0, nWin = 0, llTop3 = 0, nTop3 = 0, llStage = [0, 0, 0], nStage = [0, 0, 0];
  const per = [];
  for (const rs of testRaces) {
    const n = rs.length;
    const k = n >= 8 ? 3 : 2;
    const scores = rs.map((r) => baseOf(r.x[iLogq]) + treeSum(r.x));
    const ex = exactPL(scores, { temps });
    const w = rs.findIndex((r) => r.finish === 1);
    if (w >= 0) { const lp = Math.log(Math.max(ex.win[w], 1e-12)); llWin += lp; nWin++; per.push(lp); }
    const pk = k === 3 ? ex.top3 : ex.top2;
    rs.forEach((r, i) => { const y = r.finish > 0 && r.finish <= k ? 1 : 0; const p = Math.min(1 - 1e-4, Math.max(1e-4, pk[i])); llTop3 += y ? Math.log(p) : Math.log(1 - p); nTop3++; });
    // 段階ごとの条件つき対数尤度（1着を除いた残りの中で2着、…）
    for (let stage = 0; stage < 3; stage++) {
      const target = rs.findIndex((r) => r.finish === stage + 1);
      if (target < 0) continue;
      const alive = rs.map((r, i) => i).filter((i) => rs[i].finish > stage || rs[i].finish === 0);
      const t = temps[stage];
      const mx = Math.max(...alive.map((i) => scores[i] / t));
      const Z = alive.reduce((s, i) => s + Math.exp(scores[i] / t - mx), 0);
      llStage[stage] += scores[target] / t - mx - Math.log(Z);
      nStage[stage]++;
    }
  }
  return { win: -llWin / nWin, top3: -llTop3 / nTop3, stage: llStage.map((v, i) => -v / nStage[i]), per };
}
const a = evalTemps(prodTemps);
const b = evalTemps(oofTemps);
const dd = a.per.map((v, i) => b.per[i] - v);
const m = dd.reduce((s, v) => s + v, 0) / dd.length;
const se = Math.sqrt(dd.reduce((s, v) => s + (v - m) ** 2, 0) / (dd.length - 1) / dd.length);
log(`検証 ${testRaces.length}レース：1着の対数損失 ${a.win.toFixed(4)} → ${b.win.toFixed(4)}（${m >= 0 ? '+' : ''}${m.toFixed(4)} ± ${se.toFixed(4)}）、3着内の二値対数損失 ${a.top3.toFixed(4)} → ${b.top3.toFixed(4)}、段階ごと（1着・2着・3着）${a.stage.map((v) => v.toFixed(4)).join('/')} → ${b.stage.map((v) => v.toFixed(4)).join('/')}`);
if (process.env.OUT) await writeFile(process.env.OUT, JSON.stringify({ prodTemps, oofTemps, test: { prod: a, oof: b, pairedWin: { mean: m, se } } }, null, 1));

#!/usr/bin/env node
// 出力確率の補正を試す：学習期間の分割外（out-of-fold）の予測で「予測勝率の帯ごとの 実際/予測」のずれを測り、
// その補正（帯ごとの対数オッズのずらし）を検証期間に当てて、対数損失が良くなるかを見る。
//   TEST_START=2026-07-01 node scripts/calib-check.mjs
import path from 'node:path';
import { readJson, DATA_DIR } from '../src/collector/store.js';
import { DEFAULT_PARAMS, groupRaces, flatten, makeThresholds, binize, trainBoost, evalTrees, dateFolds, softmax } from './lib/boost.mjs';

const TEST_START = process.env.TEST_START || '2026-07-01';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const ONLY = ['logq', 'logqGap', 'popRank', 'placeLog', 'placeVsWin', 'placeSpread', 'weightRel', 'jTop3', 'tWin', 'fFormRel', 'siBest4Rel', 'siLast4Rel', 'fSpeedRel', 'closingBest', 'daysSince', 'cEloRel'];
const params = { ...DEFAULT_PARAMS, rounds: 500, patience: 0, depth: 2, lr: 0.01, lambda: 10, colsample: 0.5, subsample: 0.6 };
const ds = await readJson(path.join(DATA_DIR, 'dataset.json'));
const names = ds.names;
const Fn = names.length;
const iLogq = names.indexOf('logq');
const feats = ONLY.map((k) => names.indexOf(k));
const races = groupRaces(ds.rows);
const train = races.filter((rs) => rs[0].date < TEST_START);
const test = races.filter((rs) => rs[0].date >= TEST_START);
const folds = dateFolds(train, 5);
const EDGES = [0, 0.02, 0.04, 0.07, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 1.01];
const bandOf = (p) => { let k = 0; while (k < EDGES.length - 2 && p >= EDGES[k + 1]) k++; return k; };

// 1) 分割外の予測を集める
const oof = { sumP: new Float64Array(EDGES.length - 1), sumY: new Float64Array(EDGES.length - 1), n: new Float64Array(EDGES.length - 1) };
let llOof = 0;
let nOof = 0;
for (let k = 0; k < folds.length; k++) {
  const fitRaces = folds.filter((_, j) => j !== k).flat();
  const fit = flatten(fitRaces, Fn, { baseIndex: iLogq });
  const th = makeThresholds(fit);
  binize(fit, th);
  const valid = binize(flatten(folds[k], Fn, { baseIndex: iLogq }), th);
  const r = trainBoost({ fit, valids: [], thresholds: th, feats, params, seed: 1000 + k });
  const res = evalTrees(r.trees, valid);
  for (let i = 0; i < valid.n; i++) {
    const b = bandOf(res.p[i]);
    oof.sumP[b] += res.p[i];
    oof.sumY[b] += valid.y[i];
    oof.n[b]++;
  }
  llOof += res.ll * valid.races.length;
  nOof += valid.races.length;
  log(`分割 ${k + 1}: ${valid.races.length}レース LL ${res.ll.toFixed(4)}`);
}
log(`分割外の対数損失 ${(llOof / nOof).toFixed(4)}`);
// 帯ごとの補正：log(実際/予測) を擬似カウントで 0 に寄せる
const PRIOR = 30;
const shift = [...oof.n].map((n, b) => Math.log((oof.sumY[b] + PRIOR * (oof.sumP[b] / Math.max(n, 1))) / (oof.sumP[b] + PRIOR * (oof.sumP[b] / Math.max(n, 1)))));
for (let b = 0; b < EDGES.length - 1; b++) if (oof.n[b]) log(`  帯 ${(EDGES[b] * 100).toFixed(0)}〜${(Math.min(1, EDGES[b + 1]) * 100).toFixed(0)}%: 予測 ${((oof.sumP[b] / oof.n[b]) * 100).toFixed(2)}% 実際 ${((oof.sumY[b] / oof.n[b]) * 100).toFixed(2)}% (${oof.n[b]}) 補正 ${shift[b] >= 0 ? '+' : ''}${shift[b].toFixed(3)}`);

// 2) 学習期間の全部で学習し、検証期間で補正あり・なしを比べる
const fit = flatten(train, Fn, { baseIndex: iLogq });
const th = makeThresholds(fit);
binize(fit, th);
const tst = binize(flatten(test, Fn, { baseIndex: iLogq }), th);
const r = trainBoost({ fit, valids: [], thresholds: th, feats, params: { ...params, rounds: 600 }, seed: 12345 });
const base = evalTrees(r.trees, tst);
const apply = (gamma = 1, useShift = true) => {
  const m = new Float64Array(tst.n);
  for (let i = 0; i < tst.n; i++) m[i] = base.m[i];
  // 一度ソフトマックスで確率にしてから、帯の補正を対数オッズに足して、レース内で正規化し直す
  const p = new Float64Array(tst.n);
  softmax(tst, m, p);
  const m2 = new Float64Array(tst.n);
  for (let i = 0; i < tst.n; i++) {
    const q = Math.min(Math.max(p[i], 1e-6), 1 - 1e-6);
    const logit = Math.log(q / (1 - q)) * gamma + (useShift ? shift[bandOf(q)] : 0);
    m2[i] = logit;
  }
  // レース内の正規化はソフトマックスで行う（ロジット → 確率 → 正規化と同等ではないので、確率に戻して正規化）
  const p2 = new Float64Array(tst.n);
  for (let i = 0; i < tst.n; i++) p2[i] = 1 / (1 + Math.exp(-m2[i]));
  const m3 = new Float64Array(tst.n);
  for (let i = 0; i < tst.n; i++) m3[i] = Math.log(p2[i]);
  const out = new Float64Array(tst.n);
  return softmax(tst, m3, out);
};
log(`検証期間 ${test.length}レース：補正なし LL ${base.ll.toFixed(4)} top1 ${(base.top1 * 100).toFixed(1)}%`);
const withShift = apply(1, true);
log(`  帯の補正あり LL ${withShift.ll.toFixed(4)} top1 ${(withShift.top1 * 100).toFixed(1)}%（差 ${(withShift.ll - base.ll >= 0 ? '+' : '') + (withShift.ll - base.ll).toFixed(4)}）`);
for (const g of [0.95, 1.05, 1.1]) {
  const v = apply(g, false);
  log(`  対数オッズ×${g} LL ${v.ll.toFixed(4)}（差 ${(v.ll - base.ll >= 0 ? '+' : '') + (v.ll - base.ll).toFixed(4)}）`);
}

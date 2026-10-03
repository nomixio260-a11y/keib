#!/usr/bin/env node
// 勾配ブースティングの設定（木の深さ・学習率・正則化・特徴量の組）を、学習期間の中だけで交差検証して選ぶ。
// 検証期間（TEST_START 以降）には触らない。日付の連続したブロックで FOLDS 分割し、各ブロックを順に判定用にする。
//
//   node scripts/cv-gbdt.mjs                 … 既定の設定の候補を比べる
//   CONFIGS='[{"depth":2,"lr":0.03}]' node scripts/cv-gbdt.mjs
//   環境変数：TEST_START、FOLDS=5、NO_MARKET=1、FEATS_DROP、FEATS_ONLY、DATASET_FILE、MAX_ROUNDS
//   設定には drop:[特徴量名] / only:[特徴量名] も書ける（特徴量の組の比較用）

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { readJson, DATA_DIR } from '../src/collector/store.js';
import { DEFAULT_PARAMS, groupRaces, flatten, makeThresholds, binize, softmax, trainBoost, dateFolds } from './lib/boost.mjs';

const TEST_START = process.env.TEST_START || '2026-07-01';
const FOLDS = Number(process.env.FOLDS || 5);
const NO_MARKET = process.env.NO_MARKET === '1';
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 500);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const ds = await readJson(process.env.DATASET_FILE || path.join(DATA_DIR, 'dataset.json'));
if (!ds) throw new Error('data/dataset.json がありません。先に node scripts/dataset.mjs');
const names = ds.names;
const Fn = names.length;
const iLogq = names.indexOf('logq');
const marketCols = new Set(['logq', 'logqGap', 'popRank', 'placeKnown', 'placeLog', 'placeVsWin', 'placeSpread'].map((k) => names.indexOf(k)));

const trainRaces = groupRaces(ds.rows).filter((rs) => rs[0].date < TEST_START);
const folds = dateFolds(trainRaces, FOLDS);
log(`学習期間 ${trainRaces[0][0].date}〜${trainRaces[trainRaces.length - 1][0].date}・${trainRaces.length}レースを ${FOLDS} 分割（${folds.map((f) => f.length).join('/')}）`);

const envDrop = (process.env.FEATS_DROP || '').split(',').filter(Boolean);
const envOnly = (process.env.FEATS_ONLY || '').split(',').filter(Boolean);
const toIdx = (list) => list.map((k) => { const i = names.indexOf(k); if (i < 0) throw new Error(`特徴量がありません: ${k}`); return i; });

const DEFAULT_CONFIGS = [
  { depth: 3, lr: 0.04, lambda: 5 },
  { depth: 2, lr: 0.04, lambda: 5 },
  { depth: 2, lr: 0.02, lambda: 10 },
  { depth: 3, lr: 0.02, lambda: 20 },
  { depth: 4, lr: 0.02, lambda: 20, minH: 10 },
  { depth: 2, lr: 0.03, lambda: 30, colsample: 0.5 },
  { depth: 1, lr: 0.05, lambda: 5 },
];
const configs = process.env.CONFIGS ? JSON.parse(process.env.CONFIGS) : DEFAULT_CONFIGS;

// 分割ごとの学習・判定データは設定に共通なので先に作る
const splits = folds.map((valid, k) => {
  const fitRaces = folds.filter((_, j) => j !== k).flat();
  const fit = flatten(fitRaces, Fn, { baseIndex: NO_MARKET ? -1 : iLogq });
  const thresholds = makeThresholds(fit);
  binize(fit, thresholds);
  const v = binize(flatten(valid, Fn, { baseIndex: NO_MARKET ? -1 : iLogq }), thresholds);
  const p = new Float64Array(v.n);
  const base = softmax(v, Float64Array.from(v.base), p);
  return { fit, valid: v, thresholds, base };
});
const baseLL = splits.reduce((a, s) => a + s.base.ll, 0) / splits.length;
const baseTop1 = splits.reduce((a, s) => a + s.base.top1, 0) / splits.length;
log(`出発点（${NO_MARKET ? '一様' : '市場のみ'}）の判定 LL ${baseLL.toFixed(4)} top1 ${(baseTop1 * 100).toFixed(1)}%`);

const results = [];
for (const cfg of configs) {
  const t0 = Date.now();
  const drop = new Set(toIdx([...envDrop, ...(cfg.drop || [])]));
  const only = toIdx([...envOnly, ...(cfg.only || [])]);
  const feats = [...Array(Fn).keys()].filter((f) => !(NO_MARKET && marketCols.has(f)) && !drop.has(f) && (!only.length || only.includes(f)));
  const params = { ...DEFAULT_PARAMS, rounds: MAX_ROUNDS, patience: Number(process.env.PATIENCE || 250), ...cfg };
  delete params.drop;
  delete params.only;
  delete params.beta;
  // beta：出発点を beta × log(市場確率) にする（人気薄の過大評価の補正を出発点に入れる試み）
  const beta = cfg.beta ?? 1;
  for (const s of splits) for (const d of [s.fit, s.valid]) for (let i = 0; i < d.n; i++) d.base[i] = d.base0[i] * beta;
  // 木なし（出発点だけ）の判定 LL：beta の効果がどれだけかを分けて見る
  const betaOnly = splits.reduce((a, s) => a + softmax(s.valid, Float64Array.from(s.valid.base), new Float64Array(s.valid.n)).ll, 0) / splits.length;
  const curves = splits.map((s, k) => trainBoost({ fit: s.fit, valids: [s.valid], thresholds: s.thresholds, feats, params, seed: 1000 + k }).curve);
  // ラウンドごとの平均。早く止まった分割がある先は比べられないので、いちばん短い分割の長さまで
  const R = Math.min(...curves.map((c) => c.length));
  let best = { round: 0, ll: baseLL, top1: baseTop1 };
  for (let r = 0; r < R; r++) {
    const ll = curves.reduce((a, c) => a + c[Math.min(r, c.length - 1)].valid[0], 0) / curves.length;
    const top1 = curves.reduce((a, c) => a + c[Math.min(r, c.length - 1)].top1[0], 0) / curves.length;
    if (ll > best.ll) best = { round: r + 1, ll, top1 };
  }
  // 分割ごとの、その分割の出発点との差
  const perFold = curves.map((c, k) => (c[Math.min(best.round - 1, c.length - 1)]?.valid[0] ?? NaN) - splits[k].base.ll);
  const row = { cfg: JSON.stringify(cfg), feats: feats.length, round: best.round, ll: best.ll, gain: best.ll - baseLL, top1: best.top1, perFold, sec: (Date.now() - t0) / 1000 };
  results.push(row);
  log(`${row.cfg} 特徴量${feats.length}: 最良 ${best.round}本 LL ${best.ll.toFixed(4)}（出発点との差 ${(best.ll - baseLL >= 0 ? '+' : '') + (best.ll - baseLL).toFixed(4)}） top1 ${(best.top1 * 100).toFixed(1)}%（出発点 ${(baseTop1 * 100).toFixed(1)}%） 分割ごと ${perFold.map((v) => (v >= 0 ? '+' : '') + v.toFixed(4)).join(' ')}${beta !== 1 ? ` 出発点だけ ${(betaOnly - baseLL >= 0 ? '+' : '') + (betaOnly - baseLL).toFixed(4)}` : ''} ${row.sec.toFixed(0)}秒`);
}
results.sort((a, b) => b.ll - a.ll);
console.log('\n設定 | 特徴量 | 木の本数 | 判定LL | 出発点との差 | top1');
for (const r of results) console.log(`${r.cfg} | ${r.feats} | ${r.round} | ${r.ll.toFixed(4)} | ${(r.gain >= 0 ? '+' : '') + r.gain.toFixed(4)} | ${(r.top1 * 100).toFixed(1)}%`);
if (process.env.CV_OUT) await writeFile(process.env.CV_OUT, JSON.stringify({ testStart: TEST_START, folds: FOLDS, baseLL, baseTop1, results }, null, 1));

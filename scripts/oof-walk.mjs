#!/usr/bin/env node
// 学習期間の「分割外の予測」を、未来のデータを使わない形（前進検証・walk-forward）で作る。
//
//   node scripts/oof-walk.mjs            … data/oof-walk.json（2024-01 以降の学習期間を四半期ごとに、その前のレースだけで学習して予測）
//
// 以前の分割外の予測（miss-analysis の oof-scores.json）は、日付で5つに分けて「ほかの4つ」で学習していたので、2023年のレースを
// 2024〜2026年のレースで学習したモデルで予測していた（未来の情報が混ざる）。買い方を選ぶ長い期間の検証は、こちらを使う。
// 設定は本番のモデル（GBDT_MODEL.params）と同じ。木の本数は本番の 1/1.2（miss-analysis と同じ）。

import path from 'node:path';
import { readJson, writeJson, DATA_DIR } from '../src/collector/store.js';
import { DEFAULT_PARAMS, groupRaces, flatten, makeThresholds, binize, trainBoost, evalTrees, compactTrees } from './lib/boost.mjs';
import { GBDT_MODEL } from '../src/engine/gbdtModel.js';

const TEST_START = process.env.TEST_START || '2026-07-01';
const FROM = process.env.WALK_FROM || '2024-01-01';
const OUT = process.env.WALK_OUT || path.join(DATA_DIR, 'oof-walk.json');
// 区間ごとのモデル（木）も残す（発走前のオッズで予想し直す検証に使う。スコア = log(市場確率) + 木の合計）
const MODELS_OUT = process.env.WALK_MODELS || path.join(DATA_DIR, 'oof-walk-models.json');
const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

const P = GBDT_MODEL.params;
const ds = await readJson(process.env.WALK_DS || path.join(DATA_DIR, 'dataset.json'));
if (!ds) throw new Error('data/dataset.json がありません（node scripts/dataset.mjs）');
const Fn = ds.names.length;
const iLogq = ds.names.indexOf('logq');
const races = groupRaces(ds.rows).filter((rs) => rs.length >= 2 && rs.some((r) => r.y) && rs[0].date < TEST_START);
const feats = (P.only?.length ? P.only : ds.names).map((k) => ds.names.indexOf(k)).filter((i) => i >= 0);
const params = { ...DEFAULT_PARAMS, depth: P.depth, lr: P.lr, lambda: P.lambda, colsample: P.colsample, subsample: P.subsample, rounds: Math.round((P.rounds || 1000) / 1.2), patience: 0 };

// 四半期の区切り
const blocks = [];
for (let d = new Date(`${FROM}T00:00:00Z`); d.toISOString().slice(0, 10) < TEST_START; d.setUTCMonth(d.getUTCMonth() + 3)) {
  const start = d.toISOString().slice(0, 10);
  const e = new Date(d);
  e.setUTCMonth(e.getUTCMonth() + 3);
  const end = e.toISOString().slice(0, 10) < TEST_START ? e.toISOString().slice(0, 10) : TEST_START;
  blocks.push({ start, end });
}
log(`学習期間 ${races[0][0].date}〜${races[races.length - 1][0].date}・${races.length}レース。前進検証 ${blocks.length}区間（${FROM}〜${TEST_START}）`);
const scores = {};
const blockInfo = [];
const models = [];
for (const [k, b] of blocks.entries()) {
  const t0 = Date.now();
  const trainRaces = races.filter((rs) => rs[0].date < b.start);
  const testRaces = races.filter((rs) => rs[0].date >= b.start && rs[0].date < b.end);
  if (!testRaces.length) continue;
  const fit = flatten(trainRaces, Fn, { baseIndex: iLogq });
  const thresholds = makeThresholds(fit);
  binize(fit, thresholds);
  const valid = binize(flatten(testRaces, Fn, { baseIndex: iLogq }), thresholds);
  const r = trainBoost({ fit, valids: [], thresholds, feats, params, seed: 2000 + k });
  const m = evalTrees(r.trees, valid).m;
  for (let ri = 0; ri < valid.races.length; ri++) scores[valid.races[ri][0].raceId] = valid.races[ri].map((row, i) => [row.number, m[valid.start[ri] + i]]);
  blockInfo.push({ ...b, train: trainRaces.length, test: testRaces.length });
  models.push({ ...b, base: 'logq', trees: compactTrees(r.trees) });
  log(`区間 ${k + 1}/${blocks.length} ${b.start}〜${b.end}：学習 ${trainRaces.length}・予測 ${testRaces.length}レース（${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
}
await writeJson(OUT, { kind: 'walk-forward', from: FROM, to: TEST_START, params: { ...params, only: P.only }, blocks: blockInfo, scores });
await writeJson(MODELS_OUT, { names: ds.names, models });
log(`書き出し：${path.relative(process.cwd(), OUT)}（${Object.keys(scores).length}レース）`);

#!/usr/bin/env node
// 特徴量の組や設定の違うモデルを同じデータで学習し、スコア（木の合計）を平均したモデルを作る実験。
//   CONFIGS='[{"only":[...]},{"drop":[...]}]' TEST_START=2026-07-01 node scripts/ensemble.mjs [--write] [DUMP_TEST=file]
// 各設定は train-gbdt と同じ意味（depth/lr/lambda/colsample/subsample/rounds/only/drop）。葉の値を 1/N にして木をつなげるだけなので、
// 書き出したモデルは src/engine/gbdt.js でそのまま動く。

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { readJson, DATA_DIR, ROOT } from '../src/collector/store.js';
import { DEFAULT_PARAMS, groupRaces, flatten, makeThresholds, binize, trainBoost, evalTrees, fitTemps, compactTrees } from './lib/boost.mjs';

const TEST_START = process.env.TEST_START || '2026-07-01';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const configs = JSON.parse(process.env.CONFIGS || '[]');
if (!configs.length) throw new Error('CONFIGS を指定してください');
const ds = await readJson(path.join(DATA_DIR, 'dataset.json'));
const names = ds.names;
const Fn = names.length;
const iLogq = names.indexOf('logq');
const racesAll = groupRaces(ds.rows);
const trainRaces = racesAll.filter((rs) => rs[0].date < TEST_START);
const testRaces = racesAll.filter((rs) => rs[0].date >= TEST_START);
const fit = flatten(trainRaces, Fn, { baseIndex: iLogq });
const thresholds = makeThresholds(fit);
binize(fit, thresholds);
const test = binize(flatten(testRaces, Fn, { baseIndex: iLogq }), thresholds);
const base0 = evalTrees([], test);
log(`学習 ${trainRaces.length}・検証 ${testRaces.length}（${TEST_START}〜）・出発点 検証 ${base0.ll.toFixed(4)} top1 ${(base0.top1 * 100).toFixed(1)}%`);
const toIdx = (list) => list.map((k) => { const i = names.indexOf(k); if (i < 0) throw new Error(`特徴量がありません: ${k}`); return i; });
const all = [];
const N = configs.length;
for (const cfg of configs) {
  const drop = new Set(toIdx(cfg.drop || []));
  const only = toIdx(cfg.only || []);
  const feats = [...Array(Fn).keys()].filter((f) => !drop.has(f) && (!only.length || only.includes(f)));
  const params = { ...DEFAULT_PARAMS, rounds: cfg.rounds || 600, patience: 0, depth: cfg.depth ?? 2, lr: cfg.lr ?? 0.01, lambda: cfg.lambda ?? 10, colsample: cfg.colsample ?? 0.5, subsample: cfg.subsample ?? 0.6 };
  const r = trainBoost({ fit, valids: [], thresholds, feats, params, seed: cfg.seed || 12345 });
  const single = evalTrees(r.trees, test);
  log(`  特徴量${feats.length}・${r.trees.length}本：単独で検証 ${single.ll.toFixed(4)} top1 ${(single.top1 * 100).toFixed(1)}%`);
  all.push(...r.trees.map((t) => t.map((nd) => (nd.leaf != null ? { leaf: nd.leaf / N } : nd))));
}
const res = evalTrees(all, test);
log(`平均（${N}モデル）：検証 ${res.ll.toFixed(4)}（出発点 ${base0.ll.toFixed(4)}） top1 ${(res.top1 * 100).toFixed(1)}%`);
if (process.env.DUMP_TEST) {
  const perRace = [];
  for (let ri = 0; ri < test.races.length; ri++) {
    const a = test.start[ri];
    const b = test.start[ri + 1];
    let lp = null;
    let best = a;
    for (let i = a; i < b; i++) {
      if (res.p[i] > res.p[best]) best = i;
      if (test.y[i]) lp = Math.log(Math.max(res.p[i], 1e-12));
    }
    perRace.push({ id: test.races[ri][0].raceId, date: test.races[ri][0].date, lp, hit: test.y[best] ? 1 : 0 });
  }
  await writeFile(process.env.DUMP_TEST, JSON.stringify(perRace));
}
if (process.argv.includes('--write')) {
  const temps = fitTemps(fit, evalTrees(all, fit).m);
  const model = {
    names,
    base: 'logq',
    baseScale: 1,
    trees: compactTrees(all),
    trainedOn: { races: trainRaces.length, from: trainRaces[0]?.[0].date, to: trainRaces[trainRaces.length - 1]?.[0].date },
    test: { from: TEST_START, races: testRaces.length, ll: +res.ll.toFixed(4), baseLL: +base0.ll.toFixed(4), top1: +res.test?.top1 ?? +res.top1.toFixed(4), baseTop1: +base0.top1.toFixed(4) },
    params: { rounds: all.length, ensemble: configs.map((c) => ({ features: (c.only || []).length || `drop ${(c.drop || []).length}`, lr: c.lr ?? 0.01, rounds: c.rounds || 600 })) },
    temps,
  };
  const file = path.join(ROOT, 'src/engine/gbdtModel.js');
  await writeFile(file, `// scripts/ensemble.mjs が実際のレース結果（JRA）から学習（複数モデルの平均）。手で編集しないでください。\nexport const GBDT_MODEL = ${JSON.stringify(model)};\n`);
  log(`書き出しました：${path.relative(ROOT, file)}（${(JSON.stringify(model).length / 1024).toFixed(0)} KB）`);
}

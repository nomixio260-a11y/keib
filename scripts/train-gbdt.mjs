#!/usr/bin/env node
// 勾配ブースティング（レースごとのソフトマックス尤度をニュートン法で最適化する決定木の集まり）を学習する。
//
//   node scripts/train-gbdt.mjs                 … data/dataset.json で学習し、学習に使っていない期間で評価、
//                                                 src/engine/gbdtModel.js に書き出す
//   環境変数：TEST_START=2026-07-01（検証の開始日）、ROUNDS、DEPTH、LR、LAMBDA、MIN_H、COLSAMPLE、SUBSAMPLE、
//             FIXED_ROUNDS=n（交差検証で選んだ本数。学習期間の全部で学習し早期終了しない）、BAGS=n（乱数の違う n 個を平均）、
//             TOPK=3（何着までの順位で学ぶか。1なら1着だけ）、STAGE_W=0.5（2着以降の重み）、
//             NO_MARKET=1（人気を使わない）、FEATS_DROP / FEATS_ONLY（特徴量名をコンマ区切り）、--dry（書き出さない）
//
// 各馬のスコア = 市場（単勝オッズの対数確率）＋ 木の合計。1着の確率はレース内のソフトマックス。
// 市場を出発点にして「オッズにまだ織り込まれていない分」だけを木が学ぶので、市場より悪くなりにくい。
// 設定は scripts/cv-gbdt.mjs（学習期間の中の交差検証）で選び、検証期間は最後の確認にだけ使う。

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { readJson, DATA_DIR, ROOT } from '../src/collector/store.js';
import { DEFAULT_PARAMS, groupRaces, flatten, makeThresholds, binize, softmax, trainBoost, evalTrees, fitTemps, importance, compactTrees } from './lib/boost.mjs';

const TEST_START = process.env.TEST_START || '2026-07-01';
const NO_MARKET = process.env.NO_MARKET === '1';
const FIXED_ROUNDS = Number(process.env.FIXED_ROUNDS || 0);
const BAGS = Math.max(1, Number(process.env.BAGS || 1));
const SEED = Number(process.env.SEED || 12345);
const BETA = Number(process.env.BETA || 1);
const params = {
  ...DEFAULT_PARAMS,
  rounds: Number(process.env.ROUNDS || (FIXED_ROUNDS || DEFAULT_PARAMS.rounds)),
  depth: Number(process.env.DEPTH || DEFAULT_PARAMS.depth),
  lr: Number(process.env.LR || DEFAULT_PARAMS.lr),
  lambda: Number(process.env.LAMBDA || DEFAULT_PARAMS.lambda),
  minH: Number(process.env.MIN_H || DEFAULT_PARAMS.minH),
  colsample: Number(process.env.COLSAMPLE || DEFAULT_PARAMS.colsample),
  subsample: Number(process.env.SUBSAMPLE || DEFAULT_PARAMS.subsample),
  patience: FIXED_ROUNDS ? 0 : DEFAULT_PARAMS.patience,
  topk: Number(process.env.TOPK || DEFAULT_PARAMS.topk),
  stageWeight: Number(process.env.STAGE_W || DEFAULT_PARAMS.stageWeight),
  halfLife: Number(process.env.HALF_LIFE || DEFAULT_PARAMS.halfLife),
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const ds = await readJson(process.env.DATASET_FILE || path.join(DATA_DIR, 'dataset.json'));
if (!ds) throw new Error('data/dataset.json がありません。先に node scripts/dataset.mjs');
const names = ds.names;
const Fn = names.length;
const iLogq = names.indexOf('logq');
const marketCols = new Set(['logq', 'logqGap', 'popRank', 'placeKnown', 'placeLog', 'placeVsWin', 'placeSpread'].map((k) => names.indexOf(k)));
const baseIndex = NO_MARKET ? -1 : iLogq;

const racesAll = groupRaces(ds.rows);
const trainRaces = racesAll.filter((rs) => rs[0].date < TEST_START);
const testRaces = racesAll.filter((rs) => rs[0].date >= TEST_START);
// 本数が決まっていなければ、学習の最後の15%を早期終了の判定用に
const cut = FIXED_ROUNDS ? trainRaces.length : Math.floor(trainRaces.length * 0.85);
const fitRaces = trainRaces.slice(0, cut);
const validRaces = trainRaces.slice(cut);
log(`学習 ${fitRaces.length}レース・判定 ${validRaces.length}・検証 ${testRaces.length}（${TEST_START}〜）${FIXED_ROUNDS ? `・木 ${FIXED_ROUNDS}本固定` : ''}${BAGS > 1 ? `・${BAGS}個の平均` : ''}`);

const fit = flatten(fitRaces, Fn, { baseIndex });
const thresholds = makeThresholds(fit);
binize(fit, thresholds);
const valid = validRaces.length ? binize(flatten(validRaces, Fn, { baseIndex }), thresholds) : null;
const test = binize(flatten(testRaces, Fn, { baseIndex }), thresholds);
if (BETA !== 1) for (const d of [fit, valid, test]) if (d) for (let i = 0; i < d.n; i++) d.base[i] = d.base0[i] * BETA;

const base0 = { fit: evalTrees([], fit), valid: valid ? evalTrees([], valid) : null, test: evalTrees([], test) };
log(`出発点（${NO_MARKET ? '一様' : '市場のみ'}）：学習 ${base0.fit.ll.toFixed(4)}${valid ? ` 判定 ${base0.valid.ll.toFixed(4)}` : ''} 検証 ${base0.test.ll.toFixed(4)} top1 ${(base0.test.top1 * 100).toFixed(1)}%`);

const drop = new Set((process.env.FEATS_DROP || '').split(',').filter(Boolean).map((k) => names.indexOf(k)));
const only = (process.env.FEATS_ONLY || '').split(',').filter(Boolean).map((k) => names.indexOf(k));
const feats = [...Array(Fn).keys()].filter((f) => !(NO_MARKET && marketCols.has(f)) && !drop.has(f) && (!only.length || only.includes(f)));
log(`使う特徴量 ${feats.length}・設定 ${JSON.stringify({ depth: params.depth, lr: params.lr, lambda: params.lambda, minH: params.minH, colsample: params.colsample, subsample: params.subsample, topk: params.topk, stageWeight: params.stageWeight })}`);

// 学習（BAGS>1 なら乱数の違うモデルを平均：葉の値を 1/BAGS にして木をつなげる）
const all = [];
for (let b = 0; b < BAGS; b++) {
  const valids = valid ? [valid, test] : [test];
  const r = trainBoost({ fit, valids, thresholds, feats, params, seed: SEED + b * 7919, log: BAGS === 1 ? log : null, logEvery: 50 });
  const keep = r.trees.slice(0, FIXED_ROUNDS || r.best.round || r.trees.length);
  if (BAGS > 1) log(`  ${b + 1}/${BAGS}: ${keep.length}本`);
  all.push(...keep.map((t) => t.map((nd) => (nd.leaf != null ? { leaf: nd.leaf / BAGS } : nd))));
}
const res = { fit: evalTrees(all, fit), valid: valid ? evalTrees(all, valid) : null, test: evalTrees(all, test) };
log(`採用 ${all.length}本：学習 ${res.fit.ll.toFixed(4)}${valid ? ` 判定 ${res.valid.ll.toFixed(4)}` : ''} 検証 ${res.test.ll.toFixed(4)}（出発点 ${base0.test.ll.toFixed(4)}） top1 ${(res.test.top1 * 100).toFixed(1)}%（出発点 ${(base0.test.top1 * 100).toFixed(1)}%）`);
for (const c of res.test.cal) if (c.n) log(`  予測 ${(c.lo * 100).toFixed(0)}〜${(Math.min(1, c.hi) * 100).toFixed(0)}%: 平均 ${((c.sum / c.n) * 100).toFixed(1)}% 実際 ${((c.win / c.n) * 100).toFixed(1)}% (${c.n})`);

// 馬体重を隠したレースと見えているレースで検証の成績を分ける
{
  const seg = (hidden) => {
    let ll = 0;
    let n = 0;
    let top1 = 0;
    for (let ri = 0; ri < test.races.length; ri++) {
      const a = test.start[ri];
      const b = test.start[ri + 1];
      if (test.bwHidden[a] !== hidden) continue;
      n++;
      let best = a;
      for (let i = a; i < b; i++) {
        if (res.test.p[i] > res.test.p[best]) best = i;
        if (test.y[i]) ll += Math.log(Math.max(res.test.p[i], 1e-12));
      }
      if (test.y[best]) top1++;
    }
    return n ? `${n}レース LL ${(ll / n).toFixed(4)} top1 ${((top1 / n) * 100).toFixed(1)}%` : 'なし';
  };
  log(`検証（馬体重あり）：${seg(0)} ／（馬体重なし）：${seg(1)}`);
}

const temps = fitTemps(fit, res.fit.m);
log('着順ごとの温度', temps);
const imp = importance(all, names);
log('利得の大きい特徴量', imp.slice(0, 15).map((r) => `${r.name}:${r.count}`).join(' '));

if (!process.argv.includes('--dry')) {
  const model = {
    names,
    base: NO_MARKET ? 'none' : 'logq',
    baseScale: BETA,
    trees: compactTrees(all),
    trainedOn: { races: fitRaces.length + validRaces.length, from: trainRaces[0]?.[0].date, to: trainRaces[trainRaces.length - 1]?.[0].date },
    test: { from: TEST_START, races: testRaces.length, ll: +res.test.ll.toFixed(4), baseLL: +base0.test.ll.toFixed(4), top1: +res.test.top1.toFixed(4), baseTop1: +base0.test.top1.toFixed(4) },
    params: { rounds: all.length, depth: params.depth, lr: params.lr, lambda: params.lambda, colsample: params.colsample, subsample: params.subsample, topk: params.topk, stageWeight: params.stageWeight, halfLife: params.halfLife, beta: BETA, bags: BAGS, drop: [...drop].map((f) => names[f]) },
    temps,
  };
  const file = path.join(ROOT, 'src/engine', NO_MARKET ? 'gbdtModelAi.js' : 'gbdtModel.js');
  await writeFile(file, `// scripts/train-gbdt.mjs が実際のレース結果（JRA）から学習。手で編集しないでください。\nexport const GBDT_MODEL = ${JSON.stringify(model)};\n`);
  log(`書き出しました：${path.relative(ROOT, file)}（${(JSON.stringify(model).length / 1024).toFixed(0)} KB）`);
}

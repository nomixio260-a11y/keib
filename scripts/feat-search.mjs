#!/usr/bin/env node
// 特徴量の自動探索（全要素の分析）：いま使っている組（TOP16）に 1つ足す／1つ抜くを全特徴量について試し、
// 交差検証の判定 LL の変化を測る。学習期間の中だけで行い、検証期間（TEST_START 以降）には触らない。
// 本番の設定（学習率 0.01・最大 1000本）では 1候補あたり数分かかるので、ここでは速い代理設定
// （学習率 0.05・最大 220本・直近 2分割だけ）でふるい分け、+0.001 を超えた候補だけ npm run cv の本番設定で確かめる。
//
//   node scripts/feat-search.mjs            … 全候補（97項目）を試して表にする
//   環境変数：BASE_FEATS（カンマ区切り。既定は TOP16）、FOLDS_USE=2（直近いくつの分割を判定に使うか）、
//             ROUNDS=220、LR=0.05、LIMIT=n（候補の数を制限。試運転用）、OUT=結果の JSON

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { readJson, DATA_DIR } from '../src/collector/store.js';
import { DEFAULT_PARAMS, groupRaces, flatten, makeThresholds, binize, softmax, trainBoost, dateFolds } from './lib/boost.mjs';

const TEST_START = process.env.TEST_START || '2026-07-01';
const FOLDS = Number(process.env.FOLDS || 5);
const FOLDS_USE = Number(process.env.FOLDS_USE || 2);
const ROUNDS = Number(process.env.ROUNDS || 220);
const LR = Number(process.env.LR || 0.05);
const LIMIT = Number(process.env.LIMIT || 0);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const TOP16 = ['logq', 'logqGap', 'popRank', 'placeLog', 'placeVsWin', 'placeSpread', 'weightRel', 'jTop3', 'tWin', 'fFormRel', 'siBest4Rel', 'siLast4Rel', 'fSpeedRel', 'closingBest', 'daysSince', 'cEloRel'];
const baseFeats = (process.env.BASE_FEATS || '').split(',').filter(Boolean);
const BASE = baseFeats.length ? baseFeats : TOP16;

const ds = await readJson(process.env.DATASET_FILE || path.join(DATA_DIR, 'dataset.json'));
if (!ds) throw new Error('data/dataset.json がありません。先に node scripts/dataset.mjs');
const names = ds.names;
const Fn = names.length;
const iLogq = names.indexOf('logq');
const idx = (k) => { const i = names.indexOf(k); if (i < 0) throw new Error(`特徴量がありません: ${k}`); return i; };
// 馬体重は発走1時間前まで出ない情報なので候補から外す（交差検証で過学習もした）
const EXCLUDE = new Set(['bodyWeight', 'bwDiff', 'bwKnown']);

const trainRaces = groupRaces(ds.rows).filter((rs) => rs[0].date < TEST_START);
const folds = dateFolds(trainRaces, FOLDS);
const useIdx = [...Array(FOLDS).keys()].slice(FOLDS - FOLDS_USE);
log(`学習期間 ${trainRaces[0][0].date}〜${trainRaces[trainRaces.length - 1][0].date}・${trainRaces.length}レース、判定に使う分割 ${useIdx.map((k) => k + 1).join('・')}／${FOLDS}（代理設定：学習率 ${LR}・最大 ${ROUNDS}本）`);
const splits = useIdx.map((k) => {
  const fit = flatten(folds.filter((_, j) => j !== k).flat(), Fn, { baseIndex: iLogq });
  const thresholds = makeThresholds(fit);
  binize(fit, thresholds);
  const valid = binize(flatten(folds[k], Fn, { baseIndex: iLogq }), thresholds);
  const base = softmax(valid, Float64Array.from(valid.base), new Float64Array(valid.n));
  return { fit, valid, thresholds, base };
});
const params = { ...DEFAULT_PARAMS, depth: 2, lr: LR, lambda: 10, colsample: 0.5, subsample: 0.6, rounds: ROUNDS, patience: 60 };

/** 特徴量の組で学習し、判定 LL（分割の平均・最良ラウンド）を返す。乱数の種は固定（組の違いだけを見る） */
function score(featNames) {
  const feats = featNames.map(idx);
  const curves = splits.map((s, k) => trainBoost({ fit: s.fit, valids: [s.valid], thresholds: s.thresholds, feats, params, seed: 1000 + k }).curve);
  const R = Math.min(...curves.map((c) => c.length));
  let best = -Infinity;
  for (let r = 0; r < R; r++) {
    const ll = curves.reduce((a, c) => a + c[Math.min(r, c.length - 1)].valid[0], 0) / curves.length;
    if (ll > best) best = ll;
  }
  return best;
}

const t0 = Date.now();
const baseLL = splits.reduce((a, s) => a + s.base.ll, 0) / splits.length;
const refLL = score(BASE);
log(`出発点（市場のみ）${baseLL.toFixed(4)}、いまの組（${BASE.length}項目）${refLL.toFixed(4)}（差 ${(refLL - baseLL >= 0 ? '+' : '') + (refLL - baseLL).toFixed(4)}、${((Date.now() - t0) / 1000).toFixed(0)}秒）`);

const results = [];
const candidates = [
  ...names.filter((k) => !BASE.includes(k) && !EXCLUDE.has(k)).map((k) => ({ op: 'add', feat: k, feats: [...BASE, k] })),
  ...BASE.filter((k) => k !== 'logq').map((k) => ({ op: 'drop', feat: k, feats: BASE.filter((x) => x !== k) })),
];
const todo = LIMIT ? candidates.slice(0, LIMIT) : candidates;
for (const c of todo) {
  const t1 = Date.now();
  const ll = score(c.feats);
  const row = { op: c.op, feat: c.feat, ll, delta: ll - refLL };
  results.push(row);
  log(`${c.op === 'add' ? '＋' : '－'}${c.feat.padEnd(14)} ${ll.toFixed(4)}（${(row.delta >= 0 ? '+' : '') + row.delta.toFixed(4)}）${((Date.now() - t1) / 1000).toFixed(0)}秒`);
}
results.sort((a, b) => b.delta - a.delta);
console.log('\n操作 | 特徴量 | 判定LL | いまの組との差');
for (const r of results) console.log(`${r.op} | ${r.feat} | ${r.ll.toFixed(4)} | ${(r.delta >= 0 ? '+' : '') + r.delta.toFixed(4)}`);
if (process.env.OUT) await writeFile(process.env.OUT, JSON.stringify({ testStart: TEST_START, base: BASE, baseLL, refLL, params, results }, null, 1));
log(`完了（${((Date.now() - t0) / 60000).toFixed(1)}分）`);

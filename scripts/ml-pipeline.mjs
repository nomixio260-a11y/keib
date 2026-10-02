#!/usr/bin/env node
// 機械学習モデルを作り直す一連の手順：データセット → 交差検証で設定を選ぶ → 選んだ設定で学習して書き出す。
//
//   node scripts/ml-pipeline.mjs
//   環境変数：TEST_START=2026-07-01（検証の開始日。これ以降は設定選びに使わない）、DATASET_START=2024-12-01、
//             BAGS=5（乱数の違うモデルを平均する個数）、FOLDS=5、SKIP_DATASET=1（データセットを作り直さない）
//
// 候補の設定（木の深さ・学習率・正則化・外す特徴量）は CANDIDATES。交差検証で最良のものと木の本数を選び、
// 学習期間の全部で学習する（分割より2割ほどデータが増えるので本数も2割増やす）。検証期間の成績は最後に1回だけ見る。

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { ROOT } from '../src/collector/store.js';

const TEST_START = process.env.TEST_START || '2026-07-01';
const DATASET_START = process.env.DATASET_START || '2024-12-01';
const BAGS = process.env.BAGS || '5';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const run = (args, env = {}) => execFileSync('node', args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, TEST_START, ...env } });

// 馬体重は交差検証で外したほうが良かった（レースごとのばらつきが大きく過学習しやすい）。
const NO_BW = ['bodyWeight', 'bwDiff', 'bwKnown'];
const CANDIDATES = [
  { depth: 2, lr: 0.02, lambda: 10, colsample: 0.4, subsample: 0.6, drop: NO_BW },
  { depth: 2, lr: 0.04, lambda: 5, drop: NO_BW },
  { depth: 3, lr: 0.02, lambda: 20, colsample: 0.5, subsample: 0.7, drop: NO_BW },
  { depth: 2, lr: 0.02, lambda: 10, colsample: 0.4, subsample: 0.6 },
  { depth: 1, lr: 0.05, lambda: 5, drop: NO_BW },
];

if (process.env.SKIP_DATASET !== '1') {
  log('データセットを作成');
  run([path.join(ROOT, 'scripts/dataset.mjs')], { DATASET_START, DATASET_STATS: 'pretest' });
}
const tmp = mkdtempSync(path.join(os.tmpdir(), 'keib-cv-'));
const cvOut = path.join(tmp, 'cv.json');
log('交差検証で設定を選ぶ');
run([path.join(ROOT, 'scripts/cv-gbdt.mjs')], { CONFIGS: JSON.stringify(CANDIDATES), CV_OUT: cvOut, FOLDS: process.env.FOLDS || '5' });
const cv = JSON.parse(await readFile(cvOut, 'utf8'));
const best = cv.results[0];
const cfg = JSON.parse(best.cfg);
const rounds = Math.max(10, Math.round(best.round * 1.2));
log(`選んだ設定 ${best.cfg}・木 ${best.round}本（判定 LL ${best.ll.toFixed(4)}、出発点との差 ${(best.gain >= 0 ? '+' : '') + best.gain.toFixed(4)}）→ 全部で学習するので ${rounds}本`);
run([path.join(ROOT, 'scripts/train-gbdt.mjs')], {
  FIXED_ROUNDS: String(rounds),
  BAGS,
  DEPTH: String(cfg.depth),
  LR: String(cfg.lr),
  LAMBDA: String(cfg.lambda),
  ...(cfg.minH ? { MIN_H: String(cfg.minH) } : {}),
  ...(cfg.colsample ? { COLSAMPLE: String(cfg.colsample) } : {}),
  ...(cfg.subsample ? { SUBSAMPLE: String(cfg.subsample) } : {}),
  FEATS_DROP: (cfg.drop || []).join(','),
});
log('完了。次は CAL_START=… TEST_START=… node scripts/evaluate.mjs で検証期間の成績を確認してください');

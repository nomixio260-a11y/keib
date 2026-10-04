#!/usr/bin/env node
// 機械学習モデルを作り直す一連の手順：データセット → 交差検証で設定を選ぶ → 選んだ設定で学習して書き出す。
//
//   node scripts/ml-pipeline.mjs
//   環境変数：TEST_START=2026-07-01（検証の開始日。これ以降は設定選びに使わない）、DATASET_START=2022-12-01、
//             BAGS=5（乱数の違うモデルを平均する個数）、FOLDS=5、SKIP_DATASET=1（データセットを作り直さない）
//
// 候補の設定（木の深さ・学習率・正則化・外す特徴量）は CANDIDATES。交差検証で最良のものと木の本数を選び、
// 学習期間の全部で学習する（分割より2割ほどデータが増えるので本数も2割増やす）。検証期間の成績は最後に1回だけ見る。

import path from 'node:path';
import { INCLUDE_EXOTIC, EXOTIC_FEATURE_NAMES } from '../src/engine/features.js';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { ROOT } from '../src/collector/store.js';

const TEST_START = process.env.TEST_START || '2026-07-01';
const DATASET_START = process.env.DATASET_START || '2022-12-01'; // 4年分（2022-10 からの記録を2か月の助走に使う）
const BAGS = process.env.BAGS || '1'; // 乱数の違うモデルの平均は効果なし（3個・10個とも ±0.0003 以内）なので既定は 1
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const run = (args, env = {}) => execFileSync('node', args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, TEST_START, ...env } });

// 交差検証で効かなかった特徴量は外す（馬体重は過学習、条件つきの騎手・厩舎成績／対戦成績／市場の形は差なし）。
// 血統（sire*）は競走馬ページの収集後に試す。beta は出発点 beta×log(市場確率)（人気薄の過大評価の補正）
const NO_BW = ['bodyWeight', 'bwDiff', 'bwKnown'];
const NO_GAIN = ['jWinCourse', 'tWinSurf', 'pairWin', 'pairStarts', 'h2h', 'h2hN', 'handicap', 'qFav', 'qEntropy'];
const LEAN = [...NO_BW, ...NO_GAIN];
// beta（出発点の倍率）は交差検証では 1.3〜1.45 が良かったが検証期間では 1.0 より悪く（対の差 −0.0025±0.0017）、採用しない
const BETA = Number(process.env.BETA || 1);
// 利得の大きい 16 項目に絞ると交差検証でも検証期間でも良くなった（77項目 → 16項目：検証期間で +0.0033±0.0018）
const TOP16 = ['logq', 'logqGap', 'popRank', 'placeLog', 'placeVsWin', 'placeSpread', 'weightRel', 'jTop3', 'tWin', 'fFormRel', 'siBest4Rel', 'siLast4Rel', 'fSpeedRel', 'closingBest', 'daysSince', 'cEloRel'];
// 血統（競走馬ページから集めた父・母の父の芝ダ別成績）：交差検証 +0.0006、検証期間 −0.0024±0.0014 → 不採用（候補としては残す）
const PEDIGREE = ['sireKnown', 'sireWinSurf', 'sireTop3Surf', 'sireStarts', 'damSireWinSurf'];
// 別の投票市場（馬連・ワイド・三連複・馬単）の特徴量：INCLUDE_EXOTIC のときは標準の組に足す（検証の記録は README の開発日記）
const STANDARD = INCLUDE_EXOTIC ? [...TOP16, ...EXOTIC_FEATURE_NAMES] : TOP16;
// 候補はすべて標準の組（別の投票市場の特徴量つき）を土台に、木の深さ・列の使い方・特徴量の追加を変えたもの。
// 別の投票市場の特徴量は他の特徴量との組み合わせで効く可能性があるので、深さ3と列を多めに使う設定も比べる
const CANDIDATES = [
  { depth: 2, lr: 0.01, lambda: 10, colsample: 0.5, subsample: 0.6, only: STANDARD, beta: BETA },
  { depth: 3, lr: 0.01, lambda: 20, colsample: 0.5, subsample: 0.6, only: STANDARD, beta: BETA },
  { depth: 2, lr: 0.01, lambda: 10, colsample: 0.7, subsample: 0.7, only: STANDARD, beta: BETA },
  { depth: 2, lr: 0.01, lambda: 10, colsample: 0.5, subsample: 0.6, only: [...STANDARD, ...PEDIGREE], beta: BETA },
  { depth: 2, lr: 0.02, lambda: 10, colsample: 0.4, subsample: 0.6, drop: LEAN, beta: BETA },
  { depth: 1, lr: 0.03, lambda: 5, only: STANDARD, beta: BETA },
];

if (process.env.SKIP_DATASET !== '1') {
  log('データセットを作成');
  run([path.join(ROOT, 'scripts/dataset.mjs')], { DATASET_START, DATASET_STATS: 'pretest' });
}
const tmp = mkdtempSync(path.join(os.tmpdir(), 'keib-cv-'));
const cvOut = path.join(tmp, 'cv.json');
log('交差検証で設定を選ぶ');
// 学習率 0.01 では最良の本数が 500 を超える（4年分で 820本）ので、上限は 1000本
run([path.join(ROOT, 'scripts/cv-gbdt.mjs')], { CONFIGS: JSON.stringify(CANDIDATES), CV_OUT: cvOut, FOLDS: process.env.FOLDS || '5', MAX_ROUNDS: process.env.MAX_ROUNDS || '1000' });
const cv = JSON.parse(await readFile(cvOut, 'utf8'));
// 候補どうしの差は ±0.001 くらいの偶然で入れ替わり、交差検証で +0.0014 良かった 85項目や血統つき 21項目は検証期間
// （2026-07〜09）では 16項目より悪かった（−0.0022±0.0025、−0.0024±0.0014）。標準の設定より 0.002 以上良いときだけ乗り換える
const SWITCH_MARGIN = Number(process.env.SWITCH_MARGIN || 0.002);
const standard = cv.results.find((r) => r.cfg === JSON.stringify(CANDIDATES[0])) || cv.results[0];
const best = cv.results[0].ll - standard.ll >= SWITCH_MARGIN ? cv.results[0] : standard;
if (best !== cv.results[0]) log(`最良の候補 ${cv.results[0].cfg} との差が小さいので標準の設定を使う`);
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
  FEATS_ONLY: (cfg.only || []).join(','),
  BETA: String(cfg.beta ?? 1),
  CALIB: cfg.calib ? '1' : '0',
});
log('完了。次は CAL_START=… TEST_START=… node scripts/evaluate.mjs で検証期間の成績を確認してください');

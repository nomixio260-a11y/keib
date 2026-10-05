#!/usr/bin/env node
// 買い方を決めるための「発走前のオッズで見た買い目の候補」を書き出す（買い方の研究用。scripts/stake-model.mjs が読む）。
//
//   node scripts/candidates.mjs                      … data/candidates/m10s1.{bin,json}（発走10分前・乱数1）
//   CAND_MIN=5 CAND_SEED=2 node scripts/candidates.mjs … 発走5分前・乱数2（data/candidates/m5s2）
//
// 確定オッズ（発走後に決まる）で買い目を選ぶと、買う時点では知りえない情報で選ぶことになる（2026-10-05 の点検）。
// 記録したオッズの推移（data/odds。data ブランチの odds/）から「発走 CAND_MIN 分前 → 確定」のずれを取り、確定オッズに
// 足して予想し直す（src/engine/oddsDrift.js）。精算は実際の払戻（払戻は確定オッズで決まる）。
//  - 学習期間（2024-01〜検証の開始日の前）：前進検証の区間のモデル（data/oof-walk-models.json。その区間より前のレースだけで
//    学習）で、データセットの特徴量のうちオッズから作る列だけ、揺らしたカードで作り直して予想する
//  - 検証期間：配信中のモデル
// 1行が1点の候補（単勝・複勝・馬連・ワイド・三連複）。列は FIELDS（type は TYPES の番号、payout は実際の払戻（100円あたり）、外れは 0）

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { readJson, loadHistory, attachFinalExoticOdds, DATA_DIR } from '../src/collector/store.js';
import { GBDT_MODEL } from '../src/engine/gbdtModel.js';
import { treeSum } from '../src/engine/gbdt.js';
import { raceFeatures, FEATURE_NAMES } from '../src/engine/features.js';
import { predictRace, PRESETS } from '../src/engine/model.js';
import { priceTicket } from '../src/engine/bets.js';
import { payoutOf } from '../src/engine/backtest.js';
import { indexHistory, preRaceCard, attachCareer } from '../src/data/history.js';
import { makePerturber, driftSummary } from '../src/engine/oddsDrift.js';
import { usable, statsForEngine } from './calibrate.mjs';
import { loadDrift } from './lib/drift.mjs';

export const FIELDS = ['set', 'race', 'type', 'pAi', 'pMkt', 'odds', 'oddsMax', 'est', 'n', 'payout', 'grade', 'upset', 'num'];
export const TYPES = ['win', 'place', 'quinella', 'wide', 'trio'];
export const CAND_DIR = process.env.CAND_DIR || path.join(DATA_DIR, 'candidates');

const TEST_START = process.env.TEST_START || '2026-07-01';
const MIN = Number(process.env.CAND_MIN || 10);
const SEED = String(process.env.CAND_SEED || 1);
const OUT = process.env.CAND_OUT || `m${MIN}s${SEED}`;
const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

const all = await loadHistory();
const index = indexHistory(all);
const stats = statsForEngine(
  all.filter((r) => r.date < TEST_START),
  all,
);
const drift = await loadDrift(all, index, MIN);
if (drift.samples.length < 100) throw new Error(`オッズの推移の記録が少なすぎます（${drift.samples.length}頭。data ブランチの odds/ を data/odds に）`);
if (drift.near < drift.races * 0.8) throw new Error(`発走${MIN}分前の30分以内の記録があるのは ${drift.near}/${drift.races}レースだけです（data/odds が古い）`);
const perturb = makePerturber(drift.samples);
log(`ずれの標本：${drift.races}レース・${drift.days}日・${drift.samples.length}頭（${JSON.stringify(driftSummary(drift.samples))}）`);

// 前進検証の予測（区間のモデル）と、データセットの特徴量（その時点の統計で作ったもの）
const walk = await readJson(path.join(DATA_DIR, 'oof-walk.json'));
const WM = await readJson(path.join(DATA_DIR, 'oof-walk-models.json'));
const DS = await readJson(path.join(DATA_DIR, 'dataset.json'));
if (!walk || !WM || !DS) throw new Error('data/oof-walk.json・oof-walk-models.json・dataset.json が必要です（node scripts/dataset.mjs → node scripts/oof-walk.mjs）');
if (DS.names.join(',') !== FEATURE_NAMES.join(',') || WM.names?.join(',') !== FEATURE_NAMES.join(',')) throw new Error('特徴量の並びが違います（データセットと区間のモデルを作り直す）');
const rowsOf = new Map();
for (const r of DS.rows) (rowsOf.get(r.raceId) || rowsOf.set(r.raceId, new Map()).get(r.raceId)).set(r.number, r.x);
DS.rows = null;
const ODDS_FEATS = ['logq', 'logqGap', 'popRank', 'placeKnown', 'placeLog', 'placeVsWin', 'placeSpread', 'logqShin', 'logqShinGap', 'placeRankDiff', 'qFav', 'qEntropy', 'exoticKnown', 'q2Log', 'q2VsWin', 'top2VsHv', 'wideVsHv', 'trioVsHv', 'exWinLog', 'exVsWin']
  .map((k) => FEATURE_NAMES.indexOf(k))
  .filter((j) => j >= 0);
const I_LOGQ = FEATURE_NAMES.indexOf('logq');
const I_EXK = FEATURE_NAMES.indexOf('exoticKnown');
const I_PLK = FEATURE_NAMES.indexOf('placeKnown');
const modelFor = (date) => WM.models.find((m) => date >= m.start && date < m.end) || null;

const GR = { S: 3, A: 2, B: 1, C: 0 };
const rows = [];
const races = [];
let rescored = 0;
for (const set of ['oof', 'hold']) {
  const recs = set === 'oof' ? all.filter((r) => r.date < TEST_START && usable(r) && walk.scores[r.id]) : all.filter((r) => r.date >= TEST_START && usable(r));
  const cards = recs.map((r) => preRaceCard(r, index));
  await attachFinalExoticOdds(cards);
  if (set === 'hold') attachCareer(cards, index, { stats });
  let k = 0;
  for (const card0 of cards) {
    if (!card0.result?.length) continue;
    const card = perturb(card0, `${card0.id}|${SEED}`);
    const opts = { weights: PRESETS.ml.weights, noise: 1, stats, ml: true, sims: 0 };
    if (set === 'oof') {
      const xs = rowsOf.get(card0.id);
      const model = modelFor(card0.date);
      if (!xs || !model) continue;
      // オッズから作る特徴量だけ、揺らしたカードで作り直す（ほかの特徴量はその時点の統計で作ったデータセットのまま）
      const sample = xs.values().next().value;
      const fcard = structuredClone(card);
      if (sample[I_EXK] === 0) fcard.exoticOdds = null;
      if (sample[I_PLK] === 0) for (const e of fcard.entries) Object.assign(e, { placeMin: null, placeMax: null });
      const fx = raceFeatures(fcard, { stats, careerOf: () => null });
      const byNum = new Map(fx.rows.map((r) => [r.entry.number, r.x]));
      const sc = [];
      for (const [num, x0] of xs) {
        const xp = byNum.get(num);
        const x = Array.from(x0);
        if (xp) for (const j of ODDS_FEATS) x[j] = Math.round(xp[j] * 1e4) / 1e4;
        sc.push([num, x[I_LOGQ] + treeSum(x, model)]);
      }
      Object.assign(opts, { mlScores: new Map(sc), mlTemps: GBDT_MODEL.temps });
      rescored++;
    }
    const pred = predictRace(card, opts);
    if (pred.empty || pred.noOdds) continue;
    const ri = races.length;
    races.push({ id: card.id, date: card.date, set });
    const n = pred.rows.length;
    const byP = pred.rows.map((_, i) => i).sort((a, b) => pred.rows[b].pWin - pred.rows[a].pWin);
    const c = pred.confidence || {};
    const push = (type, idx) => {
      const t = priceTicket({ type, idx }, pred, 0);
      if (!(t.p > 0) || !t.odds) return;
      const pay = payoutOf(card0, type, t.nums) || 0;
      rows.push([set === 'oof' ? 0 : 1, ri, TYPES.indexOf(type), t.p, t.pMarket ?? 0, t.odds, t.oddsMax || 0, t.estimated ? 1 : 0, n, pay, GR[c.grade] ?? 0, c.upsetProb ?? 0, t.nums.reduce((a, v) => a * 100 + v, 0)]);
    };
    for (let i = 0; i < n; i++) {
      if (pred.rows[i].odds) push('win', [i]);
      if (pred.placeCount) push('place', [i]);
    }
    // 組み合わせは AI の上位だけ（馬連・ワイドは7頭、三連複は6頭）
    const pair = byP.slice(0, Math.min(n, 7));
    const tri = byP.slice(0, Math.min(n, 6));
    for (let a = 0; a < pair.length; a++)
      for (let b = a + 1; b < pair.length; b++) {
        const [x, y] = [pair[a], pair[b]].sort((u, v) => u - v);
        push('quinella', [x, y]);
        if (n >= 8) push('wide', [x, y]);
      }
    for (let a = 0; a < tri.length; a++) for (let b = a + 1; b < tri.length; b++) for (let d = b + 1; d < tri.length; d++) push('trio', [tri[a], tri[b], tri[d]].sort((u, v) => u - v));
    if (++k % 3000 === 0) log(`${set} ${k}レース（${rows.length}点）`);
  }
}
const buf = new Float64Array(rows.length * FIELDS.length);
rows.forEach((r, i) => r.forEach((v, j) => (buf[i * FIELDS.length + j] = v)));
await mkdir(CAND_DIR, { recursive: true });
await writeFile(path.join(CAND_DIR, `${OUT}.bin`), Buffer.from(buf.buffer));
await writeFile(path.join(CAND_DIR, `${OUT}.json`), JSON.stringify({ fields: FIELDS, types: TYPES, n: rows.length, minutes: MIN, seed: SEED, testStart: TEST_START, drift: { races: drift.races, days: drift.days, horses: drift.samples.length }, races }));
log(`書き出しました：${path.join(CAND_DIR, OUT)}（${rows.length}点・${races.length}レース。区間のモデルで予想し直し ${rescored}）`);

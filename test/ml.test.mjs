// 機械学習モデル（勾配ブースティング）と特徴量

import test from 'node:test';
import assert from 'node:assert/strict';

import { GBDT_READY, treeSum, gbdtScores } from '../src/engine/gbdt.js';
import { GBDT_MODEL } from '../src/engine/gbdtModel.js';
import { raceFeatures, FEATURE_NAMES, careerSnapshot, careerFromRow } from '../src/engine/features.js';
import { predictRace, PRESETS, DEFAULT_PRESET, confidenceOf, VOLATILITY_CUTS } from '../src/engine/model.js';
import { honmeiConfidence, legacyGrade, gradeOf } from '../src/engine/confidence.js';
import { makeRace } from './fixtures/race.mjs';

test('モデルと特徴量の並びが一致している', () => {
  assert.equal(GBDT_READY, true);
  assert.deepEqual(GBDT_MODEL.names, FEATURE_NAMES);
  assert.equal(DEFAULT_PRESET, 'ml');
  assert.equal(PRESETS.ml.ml, true);
  assert.equal(GBDT_MODEL.temps.length, 3);
});

test('特徴量に NaN がなく、取消馬は含まない', () => {
  const race = makeRace({ seed: 11, n: 12 });
  race.entries[2].scratched = true;
  race.entries[0].career = { starts: 10, wins: 2, top3: 5, siBest: 90, siMean: 85, posMean: 0.6, bestClass: 3 };
  const fx = raceFeatures(race);
  assert.equal(fx.rows.length, 11);
  for (const r of fx.rows) {
    assert.equal(r.x.length, FEATURE_NAMES.length);
    for (const v of r.x) assert.ok(Number.isFinite(v));
  }
  const i = FEATURE_NAMES.indexOf('cKnown');
  assert.equal(fx.rows[0].x[i], 1);
  assert.equal(fx.rows[1].x[i], 0);
});

test('機械学習の予想は確率の合計が1で、線形モデルと違う結果になる', () => {
  const race = makeRace({ seed: 12, n: 14 });
  const ml = predictRace(race, { ml: true, sims: 3000 });
  const lin = predictRace(race, { weights: PRESETS.balance.weights, sims: 3000 });
  assert.equal(ml.ml, true);
  assert.ok(Math.abs(ml.rows.reduce((a, r) => a + r.pWin, 0) - 1) < 1e-9);
  assert.ok(ml.rows.every((r) => Number.isFinite(r.mlAdj)));
  assert.notDeepEqual(ml.rows.map((r) => r.pWin.toFixed(4)), lin.rows.map((r) => r.pWin.toFixed(4)));
  // 同じ入力なら同じ結果
  const again = predictRace(race, { ml: true, sims: 3000 });
  assert.deepEqual(again.rows.map((r) => r.pWin), ml.rows.map((r) => r.pWin));
  const g = gbdtScores(race);
  assert.ok(g.rows.every((r) => Number.isFinite(treeSum(r.x))));
});

test('通算要約', () => {
  const runs = [
    { date: '2026-09-01', course: '東京', surface: '芝', distance: 1600, going: '良', time: 94.0, weight: 56, finish: 1, fieldSize: 12, grade: '2勝' },
    { date: '2026-08-01', course: '東京', surface: '芝', distance: 1600, going: '良', time: 95.0, weight: 56, finish: 4, fieldSize: 12, grade: '1勝' },
  ];
  const c = careerSnapshot(runs);
  assert.equal(c.starts, 2);
  assert.equal(c.wins, 1);
  assert.equal(c.top3, 1);
  assert.equal(c.bestClass, 2);
  assert.ok(c.siBest > c.siMean);
  assert.deepEqual(careerFromRow([3, 1, 2, 88.5, 84.2, 0.5, 2]), { starts: 3, wins: 1, top3: 2, siBest: 88.5, siMean: 84.2, posMean: 0.5, bestClass: 2, elo: null });
  assert.equal(careerFromRow([3, 1, 2, 88.5, 84.2, 0.5, 2, 1540.5]).elo, 1540.5);
  assert.equal(careerFromRow(null), null);
});

test('複勝の確率（Harville）は合計が払戻対象の頭数になる', async () => {
  const { harvilleTopK } = await import('../src/engine/features.js');
  const q = [0.4, 0.25, 0.15, 0.1, 0.06, 0.04];
  const p3 = harvilleTopK(q, 3);
  assert.ok(Math.abs(p3.reduce((a, b) => a + b, 0) - 3) < 1e-9);
  assert.ok(p3[0] > p3[1] && p3[1] > p3[2] && p3[5] < 0.3);
  const p2 = harvilleTopK(q, 2);
  assert.ok(Math.abs(p2.reduce((a, b) => a + b, 0) - 2) < 1e-9);
});

test('対戦成績のレーティングは先着した馬が上がり、その日より前の値だけが参照される', async () => {
  const { computeRatings, ratingBefore } = await import('../src/data/history.js');
  const recs = [
    { id: '2026010101', date: '2026-01-01', runners: [{ horseId: 'h1', finish: 1 }, { horseId: 'h2', finish: 2 }, { horseId: 'h3', finish: 3 }] },
    { id: '2026020101', date: '2026-02-01', runners: [{ horseId: 'h1', finish: 2 }, { horseId: 'h2', finish: 1 }, { horseId: 'h4', finish: 3 }] },
    { id: '2026030101', date: '2026-03-01', jump: true, runners: [{ horseId: 'h1', finish: 5 }, { horseId: 'h2', finish: 1 }] },
  ];
  const r = computeRatings(recs);
  assert.ok(r.current.get('h1') > 1500 && r.current.get('h3') < 1500);
  assert.equal(ratingBefore(r, 'h4', '2026-02-01'), null, '初出走の馬は前の値がない');
  assert.ok(ratingBefore(r, 'h1', '2026-02-01') > ratingBefore(r, 'h1', '2026-03-01'), '2着に負けて下がる');
  assert.equal(ratingBefore(r, 'h1', '2026-04-01'), ratingBefore(r, 'h1', '2026-03-01'), '障害レースは使わない');
  assert.equal(ratingBefore(r, 'h1', '2026-01-01'), null);
});

test('結果の記録から作る出馬表は馬番順（着順の並びが特徴量に漏れない）', async () => {
  const { indexHistory, preRaceCard } = await import('../src/data/history.js');
  const rec = {
    id: '2026050505', date: '2026-05-05', course: '東京', raceNo: 5, surface: '芝', distance: 1600, grade: '未勝利', runners: [
      { number: 7, frame: 4, name: 'ウィナー', horseId: 'w', finish: 1, odds: 8.0, popularity: 3 },
      { number: 2, frame: 1, name: 'セカンド', horseId: 's', finish: 2, odds: 2.0, popularity: 1 },
      { number: 5, frame: 3, name: 'サード', horseId: 't', finish: 3, odds: 4.0, popularity: 2 },
    ],
    payouts: {},
  };
  const card = preRaceCard(rec, indexHistory([rec]));
  assert.deepEqual(card.entries.map((e) => e.number), [2, 5, 7]);
  assert.deepEqual(card.result, [7, 2, 5]);
});

test('プラケット・ルースの厳密計算はシミュレーションと一致し、確率の合計が合う', async () => {
  const { exactPL, simulatePL, comboProbs } = await import('../src/engine/simulate.js');
  const scores = [1.2, 0.4, 0, -0.3, -1, -1.5];
  const temps = [0.95, 1.2, 1.4];
  const ex = exactPL(scores, { temps });
  const sum = (a) => Array.from(a).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum(ex.win) - 1) < 1e-9);
  assert.ok(Math.abs(sum(ex.top2) - 2) < 1e-9);
  assert.ok(Math.abs(sum(ex.top3) - 3) < 1e-9);
  assert.ok(Math.abs(sum(ex.combos.quinella) - 1) < 1e-9);
  assert.ok(Math.abs(sum(ex.combos.trio) - 1) < 1e-9);
  assert.ok(Math.abs(sum(ex.combos.wide) - 3) < 1e-9);
  const sim = simulatePL(scores, { sims: 60000, seed: 3, temps });
  const c = comboProbs(sim);
  for (let i = 0; i < scores.length; i++) {
    assert.ok(Math.abs(sim.win[i] - ex.win[i]) < 0.01, `win ${i}`);
    assert.ok(Math.abs(sim.top3[i] - ex.top3[i]) < 0.012, `top3 ${i}`);
  }
  assert.ok(Math.abs(c.quinella[0 * 6 + 1] - ex.combos.quinella[0 * 6 + 1]) < 0.01);
});

test('荒れ度：人気3頭以外が勝つ確率で 堅い／普通／荒れ に分かれる', () => {
  const mk = (pWins, qs) => pWins.map((pWin, i) => ({ pWin, marketProb: qs[i], entry: { number: i + 1 } }));
  const solid = confidenceOf(mk([0.5, 0.25, 0.1, 0.05, 0.05, 0.05], [0.45, 0.25, 0.12, 0.08, 0.06, 0.04]));
  assert.equal(solid.volatility, '堅い');
  assert.ok(Math.abs(solid.upsetProb - 0.15) < 1e-9);
  assert.ok(Math.abs(solid.favWinProb - 0.5) < 1e-9);
  const wild = confidenceOf(mk([0.2, 0.15, 0.15, 0.15, 0.15, 0.1, 0.1], [0.3, 0.2, 0.15, 0.12, 0.1, 0.08, 0.05]));
  assert.equal(wild.volatility, '荒れ');
  assert.ok(wild.upsetProb >= VOLATILITY_CUTS[1]);
  assert.ok(wild.upset > solid.upset);
  // 3頭以下は荒れ度を出さない
  assert.equal(confidenceOf(mk([0.5, 0.3, 0.2], [0.5, 0.3, 0.2])).upsetProb, 0);
});

test('自信度：◎が勝つ確率で S/A/B/C（2番手との差は使わない）、モデルがなければ従来の決め方', () => {
  const mk = (ps) => ps.map((pWin, i) => ({ pWin, pTop2: Math.min(1, pWin * 1.8), pTop3: Math.min(1, pWin * 2.4), marketProb: ps[i], entry: { number: i + 1 } }));
  const model = { win: { raw: true }, place: { raw: true }, cuts: [0.42, 0.3, 0.2] };
  const rows = mk([0.33, 0.3, 0.2, 0.1, 0.05, 0.02]);
  // 2番手との差が 3pt でも、◎が勝つ確率が 30% 以上なら A（従来の決め方では B）
  assert.equal(honmeiConfidence(rows, { placeCount: 2, model }).grade, 'A');
  assert.equal(honmeiConfidence(rows, { placeCount: 2, model: null }).grade, 'B');
  assert.equal(legacyGrade(0.35, 0.3), 'B');
  assert.equal(gradeOf(0.5, model.cuts), 'S');
  assert.equal(gradeOf(0.19, model.cuts), 'C');
  const c = honmeiConfidence(rows, { placeCount: 2, model });
  assert.ok(Math.abs(c.winProb - 0.33) < 1e-9);
  assert.ok(Math.abs(c.placeProb - 0.33 * 1.8) < 1e-9);
  // 複勝がない頭数（4頭以下）では複勝圏の確率を出さない
  assert.equal(honmeiConfidence(mk([0.5, 0.3, 0.2]), { placeCount: 0, model }).placeProb, null);
});

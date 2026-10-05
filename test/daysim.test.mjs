// 1日の損失の上限（的中重視の自動）と、その日の収支の見込み（シミュレーション）

import test from 'node:test';
import assert from 'node:assert/strict';

import { predictRace } from '../src/engine/model.js';
import { recommendBets, AUTO_STAKE, resolveLossLimit, LOSS_LIMIT_OPTIONS } from '../src/engine/bets.js';
import { raceOutcomes, simulateDay } from '../src/engine/daySim.js';
import { makeRace } from './fixtures/race.mjs';

const withPlace = (race) => {
  for (const e of race.entries) Object.assign(e, { placeMin: Math.round((1 + e.popularity * 0.15) * 10) / 10, placeMax: Math.round((1.3 + e.popularity * 0.4) * 10) / 10 });
  return race;
};

test('1日の損失の上限：その日の確定した収支が −予算×倍数 以下なら、残りのレースは金額を半分に（なしを選べば変えない）', () => {
  assert.equal(resolveLossLimit('auto'), AUTO_STAKE.dayLoss.mult);
  assert.equal(resolveLossLimit(0), 0);
  assert.equal(resolveLossLimit(6), 6);
  assert.ok(LOSS_LIMIT_OPTIONS.some((o) => o.value === 'auto') && LOSS_LIMIT_OPTIONS.some((o) => o.value === 0));
  let checked = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const race = withPlace(makeRace({ seed }));
    const fav = race.entries.find((e) => e.popularity === 1);
    if (seed % 2) for (const p of fav.past) Object.assign(p, { finish: 1, popularity: 1, margin: -0.8, time: Math.round((p.time - 1.5) * 10) / 10 });
    const pred = predictRace(race, { sims: 0 });
    const base = recommendBets(pred, { budget: 3000 });
    if (!base.tickets.length) continue;
    assert.equal(base.dayCut, false);
    // 上限の手前（−11,900円）では変えない
    const near = recommendBets(pred, { budget: 3000, dayPnl: -AUTO_STAKE.dayLoss.mult * 3000 + 100 });
    assert.deepEqual(near.tickets.map((t) => t.stake), base.tickets.map((t) => t.stake));
    // 上限（−12,000円）に達したら金額は半分（100円単位・利益 100円未満になる買い目は買わない）
    const cut = recommendBets(pred, { budget: 3000, dayPnl: -AUTO_STAKE.dayLoss.mult * 3000 });
    assert.equal(cut.dayCut, true);
    // 半分にすると利益が 100円に届かない買い目は、届く最小の金額（元の金額まで）
    for (const t of cut.tickets) {
      const orig = base.tickets.find((x) => x.type === t.type && x.idx.join() === t.idx.join());
      if (orig) assert.ok(t.stake <= orig.stake && (t.stake <= Math.floor(orig.stake / 2 / 100) * 100 + 100 || t.stake === Math.ceil(AUTO_STAKE.minProfit / (t.odds - 1) / 100) * 100), `${t.stake} ${orig.stake} ${t.odds}`);
    }
    assert.ok(cut.used <= base.used, `${cut.used} ${base.used}`);
    for (const t of cut.tickets) assert.ok(t.stake * (t.odds - 1) >= AUTO_STAKE.minProfit - 1e-9);
    // なし（0）なら変えない
    const off = recommendBets(pred, { budget: 3000, dayPnl: -1e9, lossLimit: 0 });
    assert.equal(off.dayCut, false);
    assert.deepEqual(off.tickets.map((t) => t.stake), base.tickets.map((t) => t.stake));
    checked++;
  }
  assert.ok(checked > 0, '買い目のあるレースで確かめている');
});

test('人気馬（当たる確率 70% 以上）の主な買い目は、期待値 1.02 に届かないと金額が半分', () => {
  let thin = 0;
  // 1番人気を大本命にして、複勝の下限〜上限を少しずつ上げ、期待値が 1.00〜1.02 になる場面を作る
  for (let seed = 1; seed <= 12 && thin < 3; seed++) for (let k = 0; k <= 40 && thin < 3; k++) {
    const race = withPlace(makeRace({ seed }));
    const fav = race.entries.find((e) => e.popularity === 1);
    for (const p of fav.past) Object.assign(p, { finish: 1, popularity: 1, margin: -0.8, time: Math.round((p.time - 1.5) * 10) / 10 });
    // 下限 1.1 倍のまま上限を少しずつ広げる（払戻の見込みが少しずつ上がる）
    Object.assign(fav, { placeMin: 1.1, placeMax: Math.round((1.1 + k * 0.01) * 100) / 100 });
    const pred = predictRace(race, { sims: 0 });
    const rec = recommendBets(pred, { budget: 3000 });
    for (const t of rec.tickets) {
      if (t.auto === 'extra') continue;
      const f = (t.ev - 1) / (t.oddsExp - 1);
      const full = Math.floor((3000 * Math.min(1, f / AUTO_STAKE.fullAt)) / 100) * 100;
      if (t.pHit >= AUTO_STAKE.hiP && t.ev < AUTO_STAKE.hiEv) {
        assert.equal(t.favThin, true);
        assert.ok(t.stake <= Math.floor((full * AUTO_STAKE.hiCut) / 100) * 100 + 1e-9, `${t.stake} ${full}`);
        thin++;
      } else assert.ok(!t.favThin);
    }
  }
  assert.ok(thin > 0, '人気馬で期待値に余裕のない主な買い目があるレースで確かめている');
});

test('その日の収支の見込み：確定したレースは実際の収支、まだのレースは着順の確率から。上限で金額を半分にすると最悪が小さくなる', () => {
  // 単勝 3倍・1,000円が 50% で当たる（+2,000円）か外れる（−1,000円）レースを、まだ 6レース
  const pred = { placeCount: 3, exact: { probs: Float64Array.from([0.5, 0.5]), triples: Int16Array.from([0, 1, 2, 1, 0, 2]) } };
  const full = [{ type: 'win', idx: [0], stake: 1000, odds: 3 }];
  const cut = [{ type: 'win', idx: [0], stake: 500, odds: 3 }];
  const out = raceOutcomes(pred, full, cut);
  assert.deepEqual(Array.from(out.full.ret), [3000, 0]);
  assert.deepEqual(Array.from(out.cut.ret), [1500, 0]);
  const items = [{ settled: true, pnl: -3000, pnlNoLimit: -3000 }, ...Array.from({ length: 6 }, () => ({ settled: false, out }))];
  const a = simulateDay(items, { sims: 20000, seed: 'x', limit: 4000 });
  const b = simulateDay(items, { sims: 20000, seed: 'x', limit: 4000 });
  assert.deepEqual(a, b, '同じ入力なら同じ結果');
  assert.equal(a.races, 6);
  // 上限なし：平均 −3,000 + 6 × 500 = 0
  assert.ok(Math.abs(a.noLimit.mean) < 150, String(a.noLimit.mean));
  assert.ok(Math.abs(a.noLimit.worst - -9000) < 1e-9);
  // 上限あり：−4,000 に達したら半分なので最悪は −3,000 −1,000 −500×5 = −6,500
  assert.ok(Math.abs(a.withLimit.worst - -6500) < 1e-9, String(a.withLimit.worst));
  assert.ok(a.withLimit.reachRate > 0.4 && a.withLimit.reachRate < 0.6);
  assert.ok(a.withLimit.q05 >= a.noLimit.q05);
});

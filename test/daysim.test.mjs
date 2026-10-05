// 1日の予算（的中重視の自動・朝にまとめて買う前提）と、その日の収支の見込み（シミュレーション）

import test from 'node:test';
import assert from 'node:assert/strict';

import { predictRace } from '../src/engine/model.js';
import { recommendBets, planDay, ticketSharpe, AUTO_STAKE, resolveDayBudget, DAY_BUDGET_OPTIONS } from '../src/engine/bets.js';
import { raceOutcomes, simulateDay } from '../src/engine/daySim.js';
import { makeRace } from './fixtures/race.mjs';

const withPlace = (race) => {
  for (const e of race.entries) Object.assign(e, { placeMin: Math.round((1 + e.popularity * 0.15) * 10) / 10, placeMax: Math.round((1.3 + e.popularity * 0.4) * 10) / 10 });
  return race;
};

/** 買い目のあるレースを集めた「1日」（1R 3,000円） */
function dayItems(budget = 3000) {
  const items = [];
  for (let seed = 1; seed <= 40; seed++) {
    const race = withPlace(makeRace({ seed, id: `test-${seed}` }));
    // 発走順（40レースを10分おき）
    const m = 10 * 60 + seed * 10;
    Object.assign(race, { raceNo: ((seed - 1) % 12) + 1, startTime: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` });
    const fav = race.entries.find((e) => e.popularity === 1);
    if (seed % 2) for (const p of fav.past) Object.assign(p, { finish: 1, popularity: 1, margin: -0.8, time: Math.round((p.time - 1.5) * 10) / 10 });
    const pred = predictRace(race, { sims: 0 });
    items.push({ pred, rec: recommendBets(pred, { budget }) });
  }
  return items;
}
const key = (t) => `${t.type}:${t.idx.join('-')}`;

test('1日の予算：合計が予算の範囲内なら買い目を変えない。超えたら発走の早いレースから順に予算まで（後のレースの買い目も結果も見ない）', () => {
  assert.equal(resolveDayBudget('auto'), AUTO_STAKE.dayBudget.mult);
  assert.equal(resolveDayBudget(0), 0);
  assert.equal(resolveDayBudget(10), 10);
  assert.ok(DAY_BUDGET_OPTIONS.some((o) => o.value === 'auto') && DAY_BUDGET_OPTIONS.some((o) => o.value === 0));
  const items = dayItems();
  const all = items.flatMap((it) => it.rec.tickets);
  const total = all.reduce((a, t) => a + t.stake, 0);
  const races = items.filter((it) => it.rec.tickets.length).length;
  assert.ok(races >= 3 && total > 2 * 3000, `買い目のあるレースが十分ある（${races}R・${total}円）`);

  // 予算の範囲内（倍数を大きく）・なし（0）なら同じ買い目
  for (const dayBudget of [1000, 0]) {
    const same = planDay(items, { budget: 3000, dayBudget });
    same.forEach((rec, i) => {
      assert.deepEqual(rec.tickets.map((t) => [key(t), t.stake]), items[i].rec.tickets.map((t) => [key(t), t.stake]));
      assert.equal(rec.day.over, false);
      assert.equal(rec.day.total, total);
      assert.equal(rec.day.races, races);
    });
  }

  // 1日の予算 = 1R の2倍（6,000円）：合計は予算まで、金額は元の金額まで、利益 100円に届かない額にはしない
  const limit = 2 * 3000;
  const plan = planDay(items, { budget: 3000, dayBudget: 2 });
  const kept = plan.flatMap((rec) => rec.tickets);
  const used = kept.reduce((a, t) => a + t.stake, 0);
  assert.ok(used <= limit && used > 0, `${used}`);
  assert.equal(plan[0].day.used, used);
  assert.equal(plan[0].day.limit, limit);
  assert.equal(plan[0].day.over, true);
  for (const t of kept) {
    const orig = all.find((x) => key(x) === key(t) && x.pHit === t.pHit);
    assert.ok(orig && t.stake <= orig.stake && t.stake >= 100);
    assert.equal(t.dayCut, t.stake < orig.stake);
    assert.ok(t.stake * (t.odds - 1) >= AUTO_STAKE.minProfit - 1e-9);
  }
  // 発走順に先着：最初に買い目のあるレースは元の金額のまま入る。入らなかったレースより後のレースは、前のレースの残りしか使えない
  const firstIdx = items.findIndex((it) => it.rec.tickets.length);
  assert.deepEqual(plan[firstIdx].tickets.map((t) => [key(t), t.stake]), items[firstIdx].rec.tickets.map((t) => [key(t), t.stake]));
  const lastKept = Math.max(...plan.map((rec, i) => (rec.tickets.length ? i : -1)));
  const firstOut = plan.findIndex((rec, i) => items[i].rec.tickets.length && !rec.tickets.length);
  assert.ok(firstOut > firstIdx, '予算に入らないのは後のレース');
  // 後のレースの買い目を変えても、前のレースの買い目は変わらない（後のレースのオッズを見ていない）
  const changed = items.map((it, i) => (i > lastKept ? { ...it, rec: { ...it.rec, tickets: it.rec.tickets.map((t) => ({ ...t, pHit: Math.min(0.99, (t.pHit ?? t.p) * 1.5) })) } } : it));
  const plan2 = planDay(changed, { budget: 3000, dayBudget: 2 });
  for (let i = 0; i <= lastKept; i++) assert.deepEqual(plan2[i].tickets.map((t) => t.stake), plan[i].tickets.map((t) => t.stake));
  assert.ok(ticketSharpe(all[0]) > -Infinity);
  // 入らなかった買い目は「1日の予算」の理由つきで、買い目が全部入らなかったレースは見送り
  const out = plan.flatMap((rec) => (rec.dropped || []).filter((t) => t.why === 'day'));
  assert.ok(out.length > 0);
  const skipped = plan.filter((rec, i) => items[i].rec.tickets.length && !rec.tickets.length);
  assert.ok(skipped.length > 0);
  for (const rec of skipped) {
    assert.equal(rec.skipped, true);
    assert.match(rec.skipReason, /1日の予算/);
    assert.equal(rec.used, 0);
  }
  // 1日の予算は結果を見ない：同じ買い目なら何度でも同じ
  assert.deepEqual(planDay(items, { budget: 3000, dayBudget: 2 }).map((r) => r.tickets.map((t) => t.stake)), plan.map((r) => r.tickets.map((t) => t.stake)));
});

test('期待値の余裕：人気馬（当たる確率 70% 以上）でも、期待値が 1.2 に届かない買い目は買わない（発走前のオッズは確定までに動く）', () => {
  let below = 0;
  let above = 0;
  // 1番人気を大本命にして、複勝の上限を少しずつ広げ、期待値が 1.2 をまたぐ場面を作る
  for (let seed = 1; seed <= 12; seed++) for (let k = 0; k <= 60; k += 3) {
    const race = withPlace(makeRace({ seed }));
    const fav = race.entries.find((e) => e.popularity === 1);
    for (const p of fav.past) Object.assign(p, { finish: 1, popularity: 1, margin: -0.8, time: Math.round((p.time - 1.5) * 10) / 10 });
    Object.assign(fav, { odds: 1.6, placeMin: 1.3, placeMax: Math.round((1.3 + k * 0.03) * 100) / 100 });
    const pred = predictRace(race, { sims: 0 });
    const rec = recommendBets(pred, { budget: 3000 });
    const i = pred.rows.findIndex((r) => r.entry.number === fav.number);
    const pTop3 = pred.rows[i].pTop3;
    if (!(pTop3 >= AUTO_STAKE.hiP)) continue;
    const t = rec.tickets.find((x) => x.type === 'place' && x.idx[0] === i);
    const cand = rec.dropped?.find((x) => x.type === 'place' && x.idx[0] === i);
    const ev = t ? t.ev : cand ? cand.ev : null;
    if (ev == null) continue;
    if (ev < AUTO_STAKE.minEv) {
      assert.ok(!t, `期待値 ${ev.toFixed(3)} は買わない`);
      below++;
    } else if (t) {
      assert.ok(!t.favThin);
      above++;
    }
  }
  assert.ok(below > 0, '期待値 1.2 未満の人気馬の複勝を見送る場面で確かめている');
  assert.ok(above >= 0);
});

test('その日の収支の見込み：確定したレースは実際の収支、まだのレースは着順の確率から。買うレースを減らすと最悪が小さくなる', () => {
  // 単勝 3倍・1,000円が 50% で当たる（+2,000円）か外れる（−1,000円）レースが、まだ 6レース
  const pred = { placeCount: 3, exact: { probs: Float64Array.from([0.5, 0.5]), triples: Int16Array.from([0, 1, 2, 1, 0, 2]) } };
  const full = [{ type: 'win', idx: [0], stake: 1000, odds: 3 }];
  const out = raceOutcomes(pred, full);
  assert.deepEqual(Array.from(out.ret), [3000, 0]);
  assert.equal(out.stake, 1000);
  const items = [{ settled: true, pnl: -3000 }, ...Array.from({ length: 6 }, () => ({ settled: false, out }))];
  const a = simulateDay(items, { sims: 20000, seed: 'x' });
  const b = simulateDay(items, { sims: 20000, seed: 'x' });
  assert.deepEqual(a, b, '同じ入力なら同じ結果');
  assert.equal(a.races, 6);
  // 平均 −3,000 + 6 × 500 = 0、最悪 −3,000 − 6,000
  assert.ok(Math.abs(a.mean) < 150, String(a.mean));
  assert.ok(Math.abs(a.worst - -9000) < 1e-9);
  // 後ろの 3レースを買わない（1日の予算で入らなかった）とき：同じ seed なら同じ結果の引き方で、最悪は −6,000
  const none = raceOutcomes(pred, []);
  const plan = simulateDay([items[0], ...items.slice(1, 4), ...Array.from({ length: 3 }, () => ({ settled: false, out: none }))], { sims: 20000, seed: 'x' });
  assert.equal(plan.races, 3);
  assert.ok(Math.abs(plan.worst - -6000) < 1e-9, String(plan.worst));
  assert.ok(plan.q05 >= a.q05);
});

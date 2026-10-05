// 1日の予算（的中重視の自動・朝にまとめて買う前提）と、その日の収支の見込み（シミュレーション）

import test from 'node:test';
import assert from 'node:assert/strict';

import { predictRace } from '../src/engine/model.js';
import { recommendBets, planDay, ticketSharpe, AUTO_STAKE, resolveDayBudget, DAY_BUDGET_OPTIONS, autoShare, pickAuto, expectedReturn, profitOk, minStakeFor, oddsFresh } from '../src/engine/bets.js';
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

test('自動の金額：強い買い目（当たる確率 55% 以上・期待値 1.2 以上）は有利さに応じて上限まで、それ以外はレースごとの期待回収率 R̂ に応じて。R̂ が下限に届かなければ見送り', () => {
  const A = AUTO_STAKE;
  const [L1, L2] = A.adjust;
  // 強い買い目：有利さ 3% 以上で全額、それより小さければ比例
  assert.deepEqual(autoShare({ type: 'place', p: 0.6, odds: 1.8, ev: 1.25, kelly: 0.31, r: 0.9 }), { share: 1, level: 'strong' });
  assert.equal(autoShare({ type: 'place', p: 0.6, odds: 1.8, ev: 1.25, kelly: 0.015, r: null }).share, 0.5);
  // 1.1 倍以下は当たる確率 lowP 以上だけ
  assert.equal(autoShare({ type: 'place', p: 0.7, odds: 1.1, ev: 1.25, kelly: 0.5, r: null }).share, 0);
  assert.equal(autoShare({ type: 'place', p: 0.85, odds: 1.1, ev: 1.25, kelly: 0.5, r: null }).level, 'strong');
  // レースごとの調整：R̂ が下限ちょうどで share、0.01 上がるごとに slope × 0.01、上限は全額（複勝）
  const base = { type: 'place', p: 0.52, odds: 2.1, ev: 1.05, kelly: 0.05 };
  assert.deepEqual(autoShare({ ...base, r: L1.minR - 0.001 }), { share: 0, level: null });
  assert.ok(Math.abs(autoShare({ ...base, r: L1.minR }).share - L1.share) < 1e-9);
  assert.ok(Math.abs(autoShare({ ...base, r: L1.minR + 0.02 }).share - (L1.share + L1.slope * 0.02)) < 1e-9);
  assert.equal(autoShare({ ...base, r: 2 }).share, 1);
  // 単勝は R̂ の下限が高い（minRBy.win。直前のオッズでは単勝の R̂ 0.92〜0.96 は損だった）
  const winMin = L1.minRBy.win;
  assert.ok(winMin > L1.minR);
  assert.equal(autoShare({ ...base, type: 'win', r: winMin - 0.001 }).share, 0);
  assert.ok(Math.abs(autoShare({ ...base, type: 'win', r: winMin }).share - L1.share) < 1e-9);
  assert.ok(Math.abs(autoShare({ ...base, type: 'win', r: winMin + 0.01 }).share - (L1.share + L1.slope * 0.01)) < 1e-9);
  // 当たる確率が1つ目の下限（45%）未満は、複勝で R̂ が2つ目の下限以上のときだけ（単勝は買わない）
  assert.equal(autoShare({ ...base, type: 'win', p: L1.minP - 0.03, r: 1.0 }).share, 0);
  assert.ok(autoShare({ ...base, type: 'place', p: L1.minP - 0.03, r: L2.minR + 0.01 }).share > 0);
  assert.equal(autoShare({ ...base, type: 'place', p: 0.35, r: 1.2 }).share, 0);
  // ワイドなど自動で使わない券種は 0
  assert.equal(autoShare({ ...base, type: 'wide', p: 0.6, r: 1.2 }).share, 0);
  // pickAuto：割合のいちばん大きい1点。当たっても利益が 100円に届かなければ見送り（2番目に替えない）
  const a = { ...base, type: 'place', idx: [0], p: 0.6, odds: 1.6, r: 1.0 };
  const b = { ...base, type: 'win', idx: [1], p: 0.55, odds: 2.4, r: 0.99 };
  const { picked } = pickAuto([b, a], 1000);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].idx[0], 0);
  assert.equal(picked[0].stake, Math.floor((1000 * autoShare(a).share) / 100) * 100);
  // いちばん割合の大きい買い目（1.15 倍・予算 500円）が当たっても利益 75円 → 当たって 100円にするには 700円（予算の 40% を超える）→ 見送り
  // （2番目の単勝には替えない。参加の買い目の条件にも届かない）
  const thin = pickAuto([{ ...a, odds: 1.15, r: 1.0 }, b], 500);
  assert.equal(thin.ranked[0].idx[0], 0);
  assert.equal(thin.picked.length, 0);
  assert.equal(thin.ranked[0].why, 'thin');
});

test('利益 100円の判定と、届く最低額（オッズは 0.1 倍刻み。小数の誤差で落とさない）', () => {
  assert.ok(profitOk(500, 1.2));
  assert.ok(!profitOk(400, 1.2));
  assert.ok(profitOk(100, 2.0));
  assert.ok(!profitOk(100, 1.9));
  assert.equal(minStakeFor(1.2), 500);
  assert.equal(minStakeFor(1.3), 400);
  assert.equal(minStakeFor(1.5), 200);
  assert.equal(minStakeFor(2.0), 100);
  assert.equal(minStakeFor(1.0), Infinity);
  for (let o = 1.1; o < 5; o += 0.1) {
    const odds = Math.round(o * 10) / 10;
    const need = minStakeFor(odds);
    assert.ok(profitOk(need, odds) && !profitOk(need - 100, odds), `${odds} ${need}`);
  }
});

test('利益 100円に届かない金額は届く最低額まで上げる（予算の minStakeUp まで）。ほかに買い目がなければ参加の買い目（オッズが新しいときだけ）', () => {
  const A = AUTO_STAKE;
  const [L1] = A.adjust;
  // R̂ が下限ちょうど → 予算の 20%（200円）。1.3 倍では当たって +60円 → 400円（予算の 40%）に上げる
  const t = { type: 'place', idx: [0], p: 0.62, odds: 1.3, ev: 1.05, kelly: 0.05, r: L1.minR };
  const up = pickAuto([t], 1000);
  assert.equal(up.picked.length, 1);
  assert.equal(up.picked[0].stake, 400);
  assert.equal(up.picked[0].raised, true);
  assert.equal(up.picked[0].auto, 'adjust');
  // オッズが古いときは上げない（参加の買い目も出さない）→ 見送り
  assert.equal(pickAuto([t], 1000, A, { fresh: false }).picked.length, 0);
  // 1.2 倍は 500円要る（予算の 40% を超える）→ 上げない。参加の買い目（当たる確率 55% 以上・R̂ 0.90 以上、40% まで）にも届かない
  assert.equal(pickAuto([{ ...t, odds: 1.2 }], 1000).picked.length, 0);
  // 参加の買い目：R̂ が下限に届かない（強い買い目でもない）複勝で、当たる確率 55% 以上・R̂ 0.90 以上 → 当たって +100円の最低額
  const j1 = { type: 'place', idx: [1], p: 0.58, odds: 1.4, ev: 0.98, kelly: 0, r: A.join.minR + 0.005 };
  const j2 = { type: 'place', idx: [2], p: 0.7, odds: 1.25, ev: 0.97, kelly: 0, r: A.join.minR + 0.01 };
  const w = { type: 'win', idx: [3], p: 0.6, odds: 1.8, ev: 1.08, kelly: 0.1, r: 0.93 };
  const jp = pickAuto([j1, j2, w], 1000);
  assert.equal(jp.picked.length, 1);
  assert.equal(jp.picked[0].auto, 'join');
  assert.equal(jp.picked[0].idx[0], 2); // 当たる確率の高い方
  assert.equal(jp.picked[0].stake, minStakeFor(1.25));
  assert.ok(profitOk(jp.picked[0].stake, 1.25));
  assert.equal(jp.ranked.length, 0);
  assert.equal(pickAuto([j1, j2, w], 1000, A, { fresh: false }).picked.length, 0);
  // 当たる確率・R̂ が足りない複勝、単勝は参加の買い目にしない
  assert.equal(pickAuto([{ ...j1, p: A.join.minP - 0.01 }, { ...j2, r: A.join.minR - 0.01 }, w], 1000).picked.length, 0);
  // 予算が小さいと最低額が予算の 40% を超える → 見送り
  assert.equal(pickAuto([j2], 500).picked.length, 0);
});

test('オッズの新しさ：発走の freshMin 分前より後に取ったオッズ・結果の出たレース・時刻のわからないレースは新しい', () => {
  const race = { date: '2026-10-10', startTime: '15:40' };
  const at = (min) => new Date(Date.parse('2026-10-10T15:40:00+09:00') - min * 60000).toISOString();
  assert.ok(oddsFresh({ ...race, oddsAt: at(3) }));
  assert.ok(oddsFresh({ ...race, oddsAt: at(AUTO_STAKE.freshMin) }));
  assert.ok(!oddsFresh({ ...race, oddsAt: at(AUTO_STAKE.freshMin + 1) }));
  assert.ok(!oddsFresh({ ...race, oddsAt: at(60) }));
  assert.ok(oddsFresh({ ...race, oddsAt: at(60), result: [1, 2, 3] }));
  assert.ok(oddsFresh({ ...race }));
  assert.ok(oddsFresh({ ...race, oddsAt: at(60), result: [1, 2, 3], oddsBefore: 1 }));
  assert.ok(!oddsFresh({ ...race, result: [1, 2, 3], oddsBefore: 10 }));
});

test('1日の予算：参加の買い目・最低額へ上げた買い目は、最後の reserve 倍を使わない（発走順に先着、その時点までに使った額だけで決まる）', () => {
  const base = predictRace(makeRace({ seed: 3 }), { sims: 0 });
  const mk = (i, t) => ({ pred: { ...base, race: { ...base.race, id: `R${i}`, date: '2026-10-10', startTime: `1${i}:00`, raceNo: i } }, rec: { auto: true, budget: 1000, tickets: [t] } });
  const strong = (i) => mk(i, { type: 'place', idx: [0], p: 0.6, odds: 2.0, oddsExp: 2.0, stake: 1000, auto: 'strong' });
  const join = (i) => mk(i, { type: 'place', idx: [0], p: 0.7, odds: 1.4, oddsExp: 1.4, stake: 300, auto: 'join' });
  // 強い買い目 4,000円のあと、参加の買い目は 7,000 − 2,000（残す分）− 4,000 = 1,000円まで（300円 × 3）、4つ目は見送り。最後の強い買い目は残した分で買える
  const items = [strong(0), strong(1), strong(2), strong(3), join(4), join(5), join(6), join(7), strong(8)];
  const out = planDay(items, { budget: 1000, dayBudget: 'auto' });
  assert.deepEqual(out.map((r) => r.tickets.reduce((a, t) => a + t.stake, 0)), [1000, 1000, 1000, 1000, 300, 300, 300, 0, 1000]);
  assert.match(out[7].skipReason, /残りが少ない/);
  // 合計が予算の範囲内で、参加の買い目が残す分にかからなければそのまま
  const few = planDay([strong(0), join(1), join(2)], { budget: 1000, dayBudget: 'auto' });
  assert.deepEqual(few.map((r) => r.tickets[0].stake), [1000, 300, 300]);
  assert.equal(few[0].day.over, false);
});

test('自動の買い目は、レースごとの期待回収率 R̂ と1つの式（autoShare）で決めた金額', () => {
  let adjust = 0;
  let strong = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const race = withPlace(makeRace({ seed }));
    const fav = race.entries.find((e) => e.popularity === 1);
    if (seed % 2) for (const p of fav.past) Object.assign(p, { finish: 1, popularity: 1, margin: -0.8, time: Math.round((p.time - 1.5) * 10) / 10 });
    const pred = predictRace(race, { sims: 0 });
    const rec = recommendBets(pred, { budget: 3000 });
    assert.ok(rec.tickets.length <= 1);
    for (const t of rec.tickets) {
      assert.ok(['win', 'place'].includes(t.type));
      assert.equal(t.r, expectedReturn(t, pred.rows.length));
      assert.ok(profitOk(t.stake, t.odds));
      if (t.auto === 'join') {
        // 参加の買い目：当たる確率・R̂ の下限以上の複勝を、当たって +100円の最低額で
        assert.equal(t.type, 'place');
        assert.ok(t.p >= AUTO_STAKE.join.minP && t.r >= AUTO_STAKE.join.minR);
        assert.equal(t.stake, minStakeFor(t.odds));
        adjust++;
        continue;
      }
      const { share, level } = autoShare(t);
      assert.equal(t.auto, level);
      assert.equal(t.stake, t.raised ? minStakeFor(t.odds) : Math.floor((3000 * share) / 100) * 100);
      if (level === 'adjust') {
        assert.ok(t.r >= Math.min(...AUTO_STAKE.adjust.map((L) => L.minR)) - 1e-12);
        adjust++;
      } else strong++;
    }
    // 買わなかった候補（自信が足りない）は、どちらの条件も満たさない
    for (const t of rec.dropped || []) if (t.why === 'weak') assert.equal(autoShare(t).share, 0);
  }
  assert.ok(adjust + strong > 0, `買い目のある場面で確かめている（調整 ${adjust}・強い ${strong}）`);
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

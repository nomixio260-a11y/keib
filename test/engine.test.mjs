import test from 'node:test';
import assert from 'node:assert/strict';

import { frameOf, drawBias } from '../src/engine/constants.js';
import { baseTime, speedFigure } from '../src/engine/speed.js';
import { formatTime, parseTime, daysBetween, addDays } from '../src/engine/util.js';
import { harville, impliedWinProbs, estimateOdds } from '../src/engine/market.js';
import { simulate, comboProbs } from '../src/engine/simulate.js';
import { predictRace, DEFAULT_WEIGHTS, DEFAULT_PRESET, PRESETS, FACTORS, coefficients } from '../src/engine/model.js';
import { recommendBets, evaluateTickets, ticketHits, allocate, evaluateFormations, STRATEGIES, ticketsToText } from '../src/engine/bets.js';
import { payoutKey, payoutOf, runBacktest } from '../src/engine/backtest.js';
import { horseComment, paceComment } from '../src/engine/comments.js';
import { makeRace, makeResultRaces } from './fixtures/race.mjs';

const sum = (a) => Array.from(a).reduce((x, y) => x + y, 0);
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

const mainRace = makeRace({ n: 14, seed: 3 });

test('枠番の割り当て（JRA方式）', () => {
  const frames = (n) => Array.from({ length: n }, (_, i) => frameOf(i + 1, n));
  assert.deepEqual(frames(8), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(frames(12), [1, 2, 3, 4, 5, 5, 6, 6, 7, 7, 8, 8]);
  assert.deepEqual(frames(16), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8]);
  assert.deepEqual(frames(18), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 7, 8, 8, 8]);
});

test('コース固有の枠順傾向', () => {
  assert.ok(drawBias('新潟', '芝', 1000) < 0, '新潟直線1000mは外枠有利');
  assert.ok(drawBias('中山', '芝', 1600) > 0.5, '中山芝1600は内枠有利');
});

test('スピード指数：基準タイムちょうど・55kgなら80', () => {
  const t = baseTime('芝', 1600, '良', '東京');
  close(speedFigure({ surface: '芝', distance: 1600, going: '良', course: '東京', time: t, weight: 55 }), 80);
  // 斤量が2kg重いと+4
  close(speedFigure({ surface: '芝', distance: 1600, going: '良', course: '東京', time: t, weight: 57 }), 84);
  // 1秒速いと約+10.6（1600m）
  const fast = speedFigure({ surface: '芝', distance: 1600, going: '良', course: '東京', time: t - 1, weight: 55 });
  assert.ok(fast > 90 && fast < 91.5, String(fast));
  assert.equal(speedFigure({ surface: '芝', distance: 1600 }), null);
});

test('芝は道悪で時計がかかり、ダートは速くなる', () => {
  assert.ok(baseTime('芝', 2000, '不良') > baseTime('芝', 2000, '良'));
  assert.ok(baseTime('ダ', 1800, '重') < baseTime('ダ', 1800, '良'));
});

test('タイムの書式と解釈', () => {
  assert.equal(formatTime(94.5), '1:34.5');
  assert.equal(formatTime(69.0), '1:09.0');
  assert.equal(formatTime(59.3), '59.3');
  assert.equal(formatTime(120.0), '2:00.0');
  assert.equal(parseTime('1:34.5'), 94.5);
  assert.equal(parseTime('1.34.5'), 94.5);
  assert.equal(parseTime('94.5'), 94.5);
  assert.equal(parseTime(''), null);
  assert.equal(parseTime('abc'), null);
});

test('日付計算', () => {
  assert.equal(daysBetween('2026-09-06', '2026-10-04'), 28);
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
});

test('オッズ → 市場確率は合計1', () => {
  const q = impliedWinProbs([2.5, 4.0, 8.0, null, 30]);
  close(sum(q), 1);
  assert.ok(q[0] > q[1] && q[1] > q[2]);
  assert.equal(estimateOdds('win', 0), null);
  close(estimateOdds('quinella', 0.1), 7.7);
});

test('割引ハーヴィル式の確率は整合している', () => {
  const q = impliedWinProbs([2.2, 3.5, 6.0, 9.0, 15, 25, 40, 80]);
  const h = harville(q);
  close(sum(h.win), 1);
  close(sum(h.exacta), 1);
  close(sum(h.quinella), 1);
  close(sum(h.trifecta), 1);
  close(sum(h.trio), 1);
  close(sum(h.top2), 2);
  close(sum(h.top3), 3);
  close(sum(h.wide), 3);
  // 人気馬ほど3着内に入りやすい
  assert.ok(h.top3[0] > h.top3[7]);
});

test('モンテカルロ：確率の合計と再現性', () => {
  const s = [1.2, 0.8, 0.3, 0, -0.4, -1];
  const sig = s.map(() => 1.5);
  const a = simulate(s, sig, { sims: 5000, seed: 42 });
  const b = simulate(s, sig, { sims: 5000, seed: 42 });
  assert.deepEqual(Array.from(a.win), Array.from(b.win));
  close(sum(a.win), 1);
  close(sum(a.top3), 3, 1e-9);
  for (let i = 0; i < s.length; i++) close(sum(a.posDist.subarray(i * s.length, (i + 1) * s.length)), 1, 1e-9);
  assert.ok(a.win[0] > a.win[5]);
  const c = comboProbs(a);
  close(sum(c.exacta), 1, 1e-9);
  close(sum(c.trio), 1, 1e-9);
  close(sum(c.wide), 3, 1e-9);
});

test('予想：確率・印・指数', () => {
  const pred = predictRace(mainRace, { sims: 8000 });
  assert.equal(pred.n, mainRace.entries.length);
  close(pred.rows.reduce((a, r) => a + r.pWin, 0), 1, 1e-9);
  for (const r of pred.rows) {
    assert.ok(r.pWin <= r.pTop2 && r.pTop2 <= r.pTop3);
    assert.ok(Number.isFinite(r.index));
  }
  const marks = pred.rows.map((r) => r.mark);
  for (const m of ['◎', '○', '▲']) assert.equal(marks.filter((x) => x === m).length, 1, m);
  assert.ok(marks.filter((x) => x === '△').length <= 2);
  const honmei = pred.rows.find((r) => r.mark === '◎');
  assert.equal(honmei, pred.order[0]);
  close(pred.rows.reduce((a, r) => a + r.index, 0) / pred.n, 50, 1e-9);
  assert.ok(['S', 'A', 'B', 'C'].includes(pred.confidence.grade));
  assert.ok(pred.confidence.upset >= 1 && pred.confidence.upset <= 5);
  assert.ok(['H', 'M', 'S'].includes(pred.pace.label));
});

test('予想：同じ入力なら同じ結果、取消馬は除外', () => {
  const a = predictRace(mainRace, { sims: 4000 });
  const b = predictRace(mainRace, { sims: 4000 });
  assert.deepEqual(
    a.rows.map((r) => r.pWin),
    b.rows.map((r) => r.pWin),
  );
  const race = { ...mainRace, entries: mainRace.entries.map((e, i) => (i === 0 ? { ...e, scratched: true } : e)) };
  const c = predictRace(race, { sims: 4000 });
  assert.equal(c.n, mainRace.entries.length - 1);
  assert.ok(!c.rows.some((r) => r.entry.number === mainRace.entries[0].number));
});

test('ウェイト：0にしたファクターは寄与しない', () => {
  const weights = Object.fromEntries(FACTORS.map((f) => [f.key, f.key === 'speed' ? 40 : 0]));
  const coefs = coefficients(weights);
  assert.ok(coefs.speed > 0);
  assert.equal(coefs.jockey, 0);
  const pred = predictRace(mainRace, { sims: 3000, weights });
  for (const r of pred.rows) assert.ok(r.contrib.jockey === 0);
  // AI単独のプリセットはオッズを使わない
  assert.equal(PRESETS.ai.weights.market, 0);
  assert.ok(DEFAULT_WEIGHTS === PRESETS[DEFAULT_PRESET].weights);
});

test('買い目：予算内・100円単位・期待値の条件', () => {
  const pred = predictRace(mainRace, { sims: 8000 });
  for (const strategy of Object.keys(STRATEGIES)) {
    const rec = recommendBets(pred, { budget: 3000, strategy });
    const total = rec.tickets.reduce((a, t) => a + t.stake, 0);
    assert.ok(total <= 3000, `${strategy}: ${total}`);
    for (const t of rec.tickets) {
      assert.equal(t.stake % 100, 0);
      assert.ok(t.stake >= 100);
      assert.ok(t.ev >= STRATEGIES[strategy].minEv - 1e-9);
    }
    if (rec.tickets.length) {
      assert.ok(rec.stats.hitRate >= 0 && rec.stats.hitRate <= 1);
      assert.ok(rec.stats.profitRate <= rec.stats.hitRate + 1e-9);
      assert.match(ticketsToText('テスト', rec.tickets), /合計/);
    }
  }
});

test('払戻均等の配分', () => {
  const tickets = [
    { odds: 2.0, p: 0.4 },
    { odds: 4.0, p: 0.2 },
    { odds: 8.0, p: 0.1 },
  ];
  allocate(tickets, 1400, 'equal');
  assert.deepEqual(
    tickets.map((t) => t.stake),
    [800, 400, 200],
  );
});

test('的中判定', () => {
  const [a, b, c] = [3, 7, 1];
  assert.ok(ticketHits({ type: 'win', idx: [3] }, a, b, c));
  assert.ok(ticketHits({ type: 'place', idx: [1] }, a, b, c, 3));
  assert.ok(!ticketHits({ type: 'place', idx: [1] }, a, b, c, 2));
  assert.ok(ticketHits({ type: 'quinella', idx: [3, 7] }, a, b, c));
  assert.ok(ticketHits({ type: 'quinella', idx: [7, 3] }, a, b, c));
  assert.ok(ticketHits({ type: 'wide', idx: [1, 3] }, a, b, c));
  assert.ok(ticketHits({ type: 'exacta', idx: [3, 7] }, a, b, c));
  assert.ok(!ticketHits({ type: 'exacta', idx: [7, 3] }, a, b, c));
  assert.ok(ticketHits({ type: 'trio', idx: [1, 3, 7] }, a, b, c));
  assert.ok(ticketHits({ type: 'trifecta', idx: [3, 7, 1] }, a, b, c));
  assert.ok(!ticketHits({ type: 'trifecta', idx: [3, 1, 7] }, a, b, c));
});

test('フォーメーションの点数', () => {
  const pred = predictRace(mainRace, { sims: 5000 });
  const f = Object.fromEntries(evaluateFormations(pred).map((x) => [x.key, x]));
  const partners = pred.rows.filter((r) => ['○', '▲', '△'].includes(r.mark)).length;
  const hasStar = pred.rows.some((r) => r.mark === '☆');
  assert.equal(f.win.points, 1);
  assert.equal(f.wide.points, partners);
  const p5 = partners + (hasStar ? 1 : 0);
  assert.equal(f['trio-axis'].points, (p5 * (p5 - 1)) / 2);
  assert.equal(f['trio-box'].points, 4);
  assert.equal(f.trifecta.points, 2 * partners - 2);
  const ev = evaluateTickets(f.win.tickets, pred);
  close(ev.hitRate, pred.rows.find((r) => r.mark === '◎').pWin, 1e-9);
});

test('払戻表のキー', () => {
  assert.equal(payoutKey('quinella', [7, 3]), '3-7');
  assert.equal(payoutKey('exacta', [7, 3]), '7>3');
  assert.equal(payoutKey('trio', [9, 2, 5]), '2-5-9');
  assert.equal(payoutKey('trifecta', [9, 2, 5]), '9>2>5');
  const race = { payouts: { trio: { '2-5-9': 12340 } } };
  assert.equal(payoutOf(race, 'trio', [5, 9, 2]), 12340);
  assert.equal(payoutOf(race, 'trio', [5, 9, 3]), 0);
});

test('短評と展開コメント', () => {
  const pred = predictRace(mainRace, { sims: 3000 });
  const c = horseComment(pred.order[0], pred, {});
  assert.ok(Array.isArray(c.pros) && Array.isArray(c.cons));
  assert.ok(c.pros.length > 0, 'AI上位の馬には良い材料がある');
  const p = paceComment(pred);
  assert.match(p.name, /ペース/);
  assert.ok(p.text.length > 10);
});

test('バックテストが動く', async () => {
  const races = makeResultRaces(12, 99);
  const res = await runBacktest(races, {}, { sims: 1500 });
  assert.equal(res.races, 12);
  const win = res.strategies.find((s) => s.key === 'win');
  assert.equal(win.bets, 12);
  assert.ok(win.roi >= 0);
  assert.equal(win.curve.length, 12);
  assert.ok(res.ai.winRate >= 0 && res.ai.winRate <= 1);
  const calN = res.calibration.ai.reduce((a, b) => a + b.n, 0);
  assert.equal(calN, races.reduce((a, r) => a + r.entries.length, 0));
});

test('市場モデル：正規モデルの当てはめで単勝の確率を再現する', async () => {
  const { fitNormalStrengths, normalWinProbs } = await import('../src/engine/market.js');
  const q = [0.32, 0.2, 0.14, 0.1, 0.08, 0.06, 0.04, 0.03, 0.02, 0.01];
  const p = normalWinProbs(fitNormalStrengths(q), 1);
  q.forEach((v, i) => assert.ok(Math.abs(p[i] - v) < 0.004, `${i}: ${p[i]} vs ${v}`));
  // 馬ごとにばらつきが違っても確率の合計は1
  close(sum(normalWinProbs([1, 0, -1], [0.5, 1, 2])), 1, 1e-9);
});

test('期待値にオッズを混ぜると、AIとオッズの中間になる', async () => {
  const { priceTicket } = await import('../src/engine/bets.js');
  const pred = predictRace(mainRace, { sims: 4000 });
  const i = pred.rows.findIndex((r) => r.mark === '◎');
  const ai = priceTicket({ type: 'win', idx: [i] }, pred, 0);
  const half = priceTicket({ type: 'win', idx: [i] }, pred, 0.5);
  const mkt = priceTicket({ type: 'win', idx: [i] }, pred, 1);
  close(half.pEv, (ai.p + mkt.pMarket) / 2, 1e-12);
  close(half.ev, (ai.ev + mkt.ev) / 2, 1e-9);
});

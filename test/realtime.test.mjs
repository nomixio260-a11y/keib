// 実データのバンドル（過去・今日・これから）と発走時刻まわり

import test from 'node:test';
import assert from 'node:assert/strict';

import { jstParts, startMs, raceStatus, untilText } from '../src/engine/raceTime.js';
import { emptyBundle, addPastDaysFromHistory, mergeBundle, pruneBundle, cardTtl } from '../src/collector/bundle.js';
import { indexHistory, preRaceCard, computeStats, jockeyRates } from '../src/data/history.js';
import { speedFigure } from '../src/engine/speed.js';
import { predictRace } from '../src/engine/model.js';
import { recommendBets, evaluateFormations } from '../src/engine/bets.js';
import { makeRace } from './fixtures/race.mjs';

const MIN = 60 * 1000;

test('日本時間と発走までの状態', () => {
  const ms = Date.parse('2026-10-03T15:20:00Z'); // 日本時間 10/4 0:20
  assert.deepEqual(jstParts(ms), { date: '2026-10-04', time: '00:20', ym: '2026-10' });
  const race = { date: '2026-10-04', startTime: '15:45' };
  const st = startMs(race);
  assert.equal(st, Date.parse('2026-10-04T06:45:00Z'));
  assert.equal(raceStatus(race, st - 60 * MIN), 'open');
  assert.equal(raceStatus(race, st - 2 * MIN), 'closing');
  assert.equal(raceStatus(race, st + MIN), 'live');
  assert.equal(raceStatus({ ...race, result: [3, 1, 2] }, st + MIN), 'result');
  assert.equal(raceStatus({ date: '2026-10-04' }), 'open');
  assert.equal(untilText(5 * MIN), 'あと5分');
  assert.equal(untilText(65 * MIN), 'あと1時間5分');
});

test('出馬表を取り直す間隔は発走が近いほど短い', () => {
  const race = { date: '2026-10-04', startTime: '15:45' };
  const st = startMs(race);
  assert.equal(cardTtl(race, st - 30 * MIN), 2 * MIN);
  assert.equal(cardTtl(race, st - 2 * 60 * MIN), 10 * MIN);
  assert.equal(cardTtl(race, st - 24 * 60 * MIN), 30 * MIN);
  assert.equal(cardTtl(race, st + MIN), 3 * MIN);
  assert.equal(cardTtl(null, st), 10 * MIN);
});

// 結果の記録（data/history と同じ形）を作る
function record(id, date, horses, { course = '東京', distance = 1600, surface = '芝', time0 = 94 } = {}) {
  return {
    id,
    source: 'JRA',
    date,
    course,
    courseCode: '05',
    raceNo: 1,
    startTime: '10:00',
    name: `記録${id}`,
    grade: '2勝',
    surface,
    distance,
    going: '良',
    fieldSize: horses.length,
    runners: horses.map((h, k) => ({
      number: k + 1,
      frame: k + 1,
      name: h,
      horseId: h,
      finish: k + 1,
      status: '',
      time: time0 + k * 0.2,
      margin: k === 0 ? -0.2 : k * 0.2,
      last3f: 34 + k * 0.1,
      passing: [k + 1, k + 1],
      weight: 56,
      jockey: `J${k % 3}`,
      popularity: k + 1,
      odds: 2 + k * 3,
    })),
    payouts: { win: { 1: 200 }, place: { 1: 110, 2: 150, 3: 200 } },
  };
}

test('レース前時点の出馬表は、そのレースより前の走だけを使う', () => {
  const horses = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const recs = [record('r1', '2026-09-01', horses), record('r2', '2026-09-08', [...horses].reverse()), record('r3', '2026-09-15', horses)];
  const index = indexHistory(recs);
  const card = preRaceCard(recs[1], index);
  const a = card.entries.find((e) => e.name === 'A');
  assert.equal(a.past.length, 1);
  assert.equal(a.past[0].date, '2026-09-01');
  assert.deepEqual(card.result.slice(0, 3), [1, 2, 3]);
  const later = preRaceCard(recs[2], index);
  assert.equal(later.entries.find((e) => e.name === 'A').past.length, 2);
  assert.equal(later.entries.find((e) => e.name === 'A').past[0].date, '2026-09-08');
});

test('実データの統計：基準タイムと騎手成績', () => {
  const horses = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const recs = Array.from({ length: 5 }, (_, k) => record(`s${k}`, `2026-08-0${k + 1}`, horses, { time0: 94 + k * 0.1 }));
  const s = computeStats(recs);
  const [t, n] = s.baseTimes['東京|芝|1600'];
  assert.equal(n, 5);
  assert.ok(Math.abs(t - 94.2) < 1e-6, String(t));
  assert.equal(s.jockeys.J0.starts, 15);
  assert.equal(s.jockeys.J0.wins, 5);
  const jr = jockeyRates(s.jockeys);
  assert.ok(jr.rates.J0.winRate > jr.average.winRate);
});

test('バンドル：過去の開催日・前回の引き継ぎ・古い日の削除', () => {
  const horses = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const recs = ['2026-09-20', '2026-09-21', '2026-09-27', '2026-09-28'].map((d, k) => record(`p${k}`, d, horses));
  const bundle = emptyBundle();
  addPastDaysFromHistory(bundle, recs, indexHistory(recs), ['2026-09-27', '2026-09-28']);
  assert.deepEqual(
    bundle.days.map((d) => d.date),
    ['2026-09-27', '2026-09-28'],
  );
  const r = bundle.days[0].races[0];
  assert.equal(r.status, 'result');
  assert.deepEqual(r.result.slice(0, 3), [1, 2, 3]);
  assert.equal(r.finishes[1], 1);
  assert.equal(r.payouts.win[1], 200);
  assert.equal(r.resultRows.length, 8);

  // 前回のバンドル：結果が付いたレースは引き継ぐ
  const prev = { days: [{ date: '2026-10-04', races: [{ id: 'x1', date: '2026-10-04', course: '東京', raceNo: 1, status: 'result', result: [2, 1], entries: [] }] }] };
  mergeBundle(bundle, prev);
  assert.equal(bundle.days.length, 3);
  assert.deepEqual(bundle.days[2].venues, ['東京']);

  pruneBundle(bundle, { keepPast: 1, today: '2026-10-04' });
  assert.deepEqual(
    bundle.days.map((d) => d.date),
    ['2026-09-28', '2026-10-04'],
  );
});

test('地方・海外の競馬場ではスピード指数を出さない', () => {
  const run = { surface: '芝', distance: 2400, going: '良', time: 150.2, weight: 57 };
  assert.ok(speedFigure({ ...run, course: '東京' }) != null);
  assert.equal(speedFigure({ ...run, course: '英' }), null);
  assert.equal(speedFigure({ ...run, surface: 'ダ', course: '大井' }), null);
});

test('オッズ発表前は買い目を出さない', () => {
  const race = makeRace({ seed: 5 });
  race.entries.forEach((e) => {
    e.odds = null;
    e.popularity = null;
  });
  const pred = predictRace(race, { sims: 2000 });
  assert.equal(pred.noOdds, true);
  assert.ok(pred.rows.every((r) => r.ev == null && r.placeOdds == null));
  const rec = recommendBets(pred, { budget: 3000 });
  assert.equal(rec.noOdds, true);
  assert.equal(rec.tickets.length, 0);
  assert.deepEqual(evaluateFormations(pred), []);
  // 勝率は出る
  assert.ok(Math.abs(pred.rows.reduce((a, r) => a + r.pWin, 0) - 1) < 1e-9);
  // オッズがないうちは、オッズを使わない「AI単独」で予想する（機械学習はオッズが出発点のため）
  assert.equal(pred.aiOnly, true);
  assert.equal(pred.ml, false);
  assert.equal(predictRace(race, { sims: 2000, keepPresetWithoutOdds: true }).aiOnly, false);
  assert.equal(predictRace(makeRace({ seed: 5 }), { sims: 2000 }).aiOnly, false);
});

test('障害レースは予想の対象外', () => {
  const race = { ...makeRace({ seed: 6 }), surface: '障', jump: true };
  const pred = predictRace(race, { sims: 1000 });
  assert.equal(pred.empty, true);
  assert.equal(pred.jump, true);
});

test('開催日ごとの馬場差：時計がかかった日は指数が上がる', async () => {
  const { computeDayVariants } = await import('../src/data/history.js');
  const stats = { baseTimes: { '東京|芝|1600': [94, 30] }, goingAdj: { '芝|良': 0 }, classAdj: { '芝|2勝': 0 } };
  const rec = (id, date, t) => ({ id, date, course: '東京', surface: '芝', distance: 1600, going: '良', grade: '2勝', runners: [{ number: 1, finish: 1, time: t }] });
  // 遅い日（+0.8秒×4レース）と標準の日
  const v = computeDayVariants([rec('a', '2026-09-05', 94.8), rec('b', '2026-09-05', 94.8), rec('c', '2026-09-05', 94.8), rec('d', '2026-09-05', 94.8), rec('e', '2026-09-06', 94)], stats);
  assert.ok(v['2026-09-05|東京|芝'] > 0.3, String(v['2026-09-05|東京|芝']));
  assert.equal(v['2026-09-06|東京|芝'], 0);
  const run = { date: '2026-09-05', course: '東京', surface: '芝', distance: 1600, going: '良', time: 95, weight: 55 };
  const withVar = speedFigure(run, { ...stats, dayVariant: v });
  const without = speedFigure(run, stats);
  assert.ok(withVar > without, `${withVar} > ${without}`);
});

test('バンドルの確定レースから最近の馬場差を作る', async () => {
  const { bundleRecords, attachDayVariants } = await import('../src/collector/bundle.js');
  const race = (id, date, t) => ({ id, date, course: '東京', surface: '芝', distance: 1600, going: '良', grade: '2勝', status: 'result', resultRows: [{ number: 1, finish: 1, time: t }], entries: [] });
  const bundle = { days: [{ date: '2026-09-27', races: [race('a', '2026-09-27', 95), race('b', '2026-09-27', 95), race('c', '2026-09-27', 95)] }] };
  assert.equal(bundleRecords(bundle).length, 3);
  const stats = { baseTimes: { '東京|芝|1600': [94, 30] }, goingAdj: {}, classAdj: {}, dayVariant: { '2026-09-20|東京|芝': 0.1 } };
  attachDayVariants(bundle, [], stats, { today: '2026-10-02' });
  assert.ok(bundle.dayVariant['2026-09-27|東京|芝'] > 0.3);
  // 統計にすでにある日は入れない
  assert.equal(bundle.dayVariant['2026-09-20|東京|芝'], undefined);
});

test('スピード指数ファクターは同じ芝ダでの最高値（斤量で補正）', async () => {
  const { computeRaceFactors } = await import('../src/engine/factors.js');
  const stats = { baseTimes: { '東京|芝|1600': [94, 30], '東京|ダ|1600': [97, 30] }, goingAdj: {}, classAdj: {} };
  const run = (time, surface = '芝', date = '2026-09-01') => ({ date, course: '東京', surface, distance: 1600, going: '良', time, weight: 55, fieldSize: 12, finish: 3 });
  const race = {
    id: 't',
    date: '2026-10-04',
    course: '東京',
    surface: '芝',
    distance: 1600,
    going: '良',
    grade: '2勝',
    entries: [
      { number: 1, frame: 1, name: 'A', weight: 57, past: [run(95), run(93.6), run(96, 'ダ')] },
      { number: 2, frame: 2, name: 'B', weight: 55, past: [run(96, 'ダ')] },
    ],
  };
  const fx = computeRaceFactors(race, { stats });
  const best = 80 + (1000 * (94 - 93.6)) / 94; // 同じ芝での最高値
  assert.ok(Math.abs(fx.rows[0].raw.speed - (best - 4)) < 1e-6, String(fx.rows[0].raw.speed)); // 57kg は −4
  // 同じ芝ダの走がなければ、別の芝ダの値から5ポイント引く
  const dirt = 80 + (1000 * (97 - 96)) / 97;
  assert.ok(Math.abs(fx.rows[1].raw.speed - (dirt - 5)) < 1e-6, String(fx.rows[1].raw.speed));
});

test('実際の複勝オッズがあれば下限で期待値を計算する', async () => {
  const { priceTicket } = await import('../src/engine/bets.js');
  const race = makeRace({ seed: 8 });
  race.entries.forEach((e) => {
    e.placeMin = 1.6;
    e.placeMax = 2.4;
  });
  const pred = predictRace(race, { sims: 2000 });
  const t = priceTicket({ type: 'place', idx: [0] }, pred, 0.5);
  assert.equal(t.odds, 1.6);
  assert.equal(t.oddsMax, 2.4);
  assert.equal(t.estimated, false);
  assert.equal(pred.rows[0].placeOdds, 1.6);
  // 実オッズがなければ推定
  const plain = predictRace(makeRace({ seed: 8 }), { sims: 2000 });
  assert.equal(priceTicket({ type: 'place', idx: [0] }, plain, 0.5).estimated, true);
});

test('オッズの推移を記録する（同じ時刻は重ねない）', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { appendOddsSnapshot, readJson } = await import('../src/collector/store.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'keib-odds-'));
  const race = { id: '202605040211', date: '2026-10-04', course: '東京', raceNo: 11, oddsAt: '2026-10-04T05:00:00Z', entries: [{ number: 1, odds: 3.2, placeMin: 1.3, placeMax: 1.6 }, { number: 2, odds: null }] };
  assert.equal(await appendOddsSnapshot(race, dir), true);
  assert.equal(await appendOddsSnapshot(race, dir), false);
  // 時刻が違ってもオッズが同じなら記録しない
  assert.equal(await appendOddsSnapshot({ ...race, oddsAt: '2026-10-04T05:00:00.003Z' }, dir), false);
  assert.equal(await appendOddsSnapshot({ ...race, oddsAt: '2026-10-04T05:10:00Z', entries: [{ number: 1, odds: 2.9 }] }, dir), true);
  const doc = await readJson(path.join(dir, '2026', '202605040211.json'));
  assert.equal(doc.snapshots.length, 2);
  assert.deepEqual(doc.snapshots[0].win, { 1: 3.2 });
  assert.deepEqual(doc.snapshots[0].place, { 1: [1.3, 1.6] });
  assert.deepEqual(doc.snapshots[1].win, { 1: 2.9 });
  await fs.rm(dir, { recursive: true, force: true });
});

test('開催日ごとの馬場差は前回の分も引き継ぐ', async () => {
  const { mergeBundle, attachDayVariants } = await import('../src/collector/bundle.js');
  const stats = { baseTimes: { '東京|芝|1600': [94, 30] }, goingAdj: {}, classAdj: {}, dayVariant: {} };
  const bundle = { days: [] };
  mergeBundle(bundle, { days: [], dayVariant: { '2026-09-27|東京|芝': 0.2 } });
  attachDayVariants(bundle, [], stats, { today: '2026-10-10' });
  assert.equal(bundle.dayVariant['2026-09-27|東京|芝'], 0.2);
  // 古すぎる日は落とす
  attachDayVariants(bundle, [], stats, { today: '2027-06-01' });
  assert.equal(bundle.dayVariant['2026-09-27|東京|芝'], undefined);
});

test('プラケット・ルースのシミュレーションは解析的な確率と一致する', async () => {
  const { simulatePL, comboProbs } = await import('../src/engine/simulate.js');
  const s = [0, Math.log(2), Math.log(3)];
  const sim = simulatePL(s, { sims: 60000, seed: 3, temps: [1, 1, 1] });
  [1 / 6, 2 / 6, 3 / 6].forEach((p, i) => assert.ok(Math.abs(sim.win[i] - p) < 0.01, `${i}: ${sim.win[i]}`));
  // 2着の温度を上げると、1着が決まったあとの残りは平らになる
  const flat = simulatePL(s, { sims: 60000, seed: 4, temps: [1, 100, 100] });
  const c = comboProbs(flat);
  // 3番が勝ったあと、0番と1番が2着になる確率はほぼ半々
  const n = 3;
  const p20 = c.exacta[2 * n + 0];
  const p21 = c.exacta[2 * n + 1];
  assert.ok(Math.abs(p20 / (p20 + p21) - 0.5) < 0.02, String(p20 / (p20 + p21)));
  // 着順の分布は各馬で合計1
  for (let i = 0; i < n; i++) assert.ok(Math.abs(Array.from(sim.posDist.subarray(i * n, i * n + n)).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('馬連・ワイド・3連複は実際のオッズがあればそれで期待値を計算する', async () => {
  const { priceTicket } = await import('../src/engine/bets.js');
  const race = makeRace({ seed: 9 });
  race.exoticOdds = { quinella: { '1-2': 12.3 }, wide: { '1-2': 4.5 }, trio: { '1-2-3': 56.7 } };
  const pred = predictRace(race, { sims: 2000 });
  const i = (num) => pred.rows.findIndex((r) => r.entry.number === num);
  const q = priceTicket({ type: 'quinella', idx: [i(2), i(1)] }, pred, 0.5);
  assert.equal(q.odds, 12.3);
  assert.equal(q.estimated, false);
  assert.equal(priceTicket({ type: 'wide', idx: [i(1), i(2)] }, pred, 0.5).odds, 4.5);
  assert.equal(priceTicket({ type: 'trio', idx: [i(3), i(1), i(2)] }, pred, 0.5).odds, 56.7);
  // 表にない組み合わせは推定
  assert.equal(priceTicket({ type: 'quinella', idx: [i(1), i(3)] }, pred, 0.5).estimated, true);
});

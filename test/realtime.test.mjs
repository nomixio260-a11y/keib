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

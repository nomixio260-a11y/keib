// 検証のごまかし防止：途中までの結果の記録を使わない・過去の日の再現は検証の開始日より前の統計・発走前のオッズの推定

import test from 'node:test';
import assert from 'node:assert/strict';

import { recordCoverage } from '../src/collector/collect.js';
import { resultComplete } from '../src/collector/bundle.js';
import { usable, complete } from '../scripts/calibrate.mjs';
import { REPLAY_STATS } from '../src/engine/replayStats.js';
import { REAL_STATS } from '../src/engine/realStats.js';
import { makePerturber, driftSamples, driftBucket } from '../src/engine/oddsDrift.js';
import { horseFactorValues, factorStat } from '../src/ui/factorView.js';
import { makeRace } from './fixtures/race.mjs';

const runners = (n, { finished = n } = {}) => Array.from({ length: n }, (_, i) => ({ number: i + 1, finish: i < finished ? i + 1 : 0, status: '' }));

test('結果の記録：上位だけの記録（速報）は「途中まで」として扱い、学習・検証に使わない', () => {
  // 16頭立てで5頭だけ記録された（2026-10-04 京都 4・6・8・9R と同じ形）
  const partial = { id: 'x', surface: '芝', runners: runners(5), expectedRunners: 16 };
  assert.deepEqual(recordCoverage(partial, 16), { have: 5, expected: 16, complete: false });
  assert.equal(complete(partial), false);
  assert.equal(usable(partial), false);
  const full = { ...partial, runners: runners(16) };
  assert.equal(recordCoverage(full, 16).complete, true);
  assert.equal(usable(full), true);
  // 取消・除外は頭数に数えない
  const withScratch = { ...partial, runners: [...runners(15), { number: 16, finish: 0, status: '取消' }], expectedRunners: 15 };
  assert.equal(complete(withScratch), true);
  // 画面のバンドル：出走（取消を除く）より結果の行が少なければ、確定として扱わない
  const race = { status: 'result', entries: Array.from({ length: 16 }, (_, i) => ({ number: i + 1 })), resultRows: runners(5) };
  assert.equal(resultComplete(race), false);
  assert.equal(resultComplete({ ...race, resultRows: runners(16) }), true);
});

test('過去の日の再現に使う騎手・厩舎の成績は、検証の開始日より前のレースだけ', () => {
  assert.ok(REPLAY_STATS.to < REPLAY_STATS.asOf, `${REPLAY_STATS.to} < ${REPLAY_STATS.asOf}`);
  assert.ok(REPLAY_STATS.asOf <= '2026-07-01');
  assert.ok(REPLAY_STATS.races < REAL_STATS.races);
  assert.ok(Object.keys(REPLAY_STATS.jockeyRates).length > 100);
  // 全期間の成績とは違う（検証期間の結果が入っていない）
  const name = Object.keys(REPLAY_STATS.jockeyRates).find((k) => REAL_STATS.jockeyRates[k] && REAL_STATS.jockeyRates[k].starts > REPLAY_STATS.jockeyRates[k].starts);
  assert.ok(name, '全期間のほうが騎乗数の多い騎手がいる');
});

test('発走前のオッズの推定：同じ乱数なら同じ・控除はそのまま・払戻は変えない', () => {
  const race = makeRace({ seed: 3 });
  for (const e of race.entries) Object.assign(e, { placeMin: 1.2 + e.popularity * 0.2, placeMax: 1.6 + e.popularity * 0.5 });
  race.exoticOdds = { quinella: { '1-2': 12.3, '1-3': 40.5 }, trio: { '1-2-3': 88.1 } };
  race.payouts = { win: { 1: 350 } };
  // 標本：帯ごとに上下のずれ
  const samples = [];
  for (const o of [1.8, 2.5, 4, 5, 8, 10, 20, 25, 40, 80]) for (const lr of [-0.2, -0.1, 0.05, 0.1, 0.2]) samples.push([o, lr, lr * 0.6]);
  const perturb = makePerturber(samples);
  const a = perturb(race, 'r|1');
  const b = perturb(race, 'r|1');
  const c = perturb(race, 'r|2');
  assert.deepEqual(a.entries.map((e) => e.odds), b.entries.map((e) => e.odds));
  assert.notDeepEqual(a.entries.map((e) => e.odds), c.entries.map((e) => e.odds));
  const inv = (r) => r.entries.reduce((s, e) => s + (e.odds > 1 ? 1 / e.odds : 0), 0);
  assert.ok(Math.abs(inv(a) - inv(race)) / inv(race) < 0.02, `${inv(a)} vs ${inv(race)}`);
  assert.deepEqual(a.payouts, race.payouts);
  assert.notEqual(a.exoticOdds.quinella['1-2'], undefined);
  // 元のレースは変えない
  assert.equal(race.exoticOdds.quinella['1-2'], 12.3);
  // 人気は揺らしたオッズの順
  const byOdds = [...a.entries].filter((e) => e.odds > 1).sort((x, y) => x.odds - y.odds);
  assert.deepEqual(byOdds.map((e) => e.popularity), byOdds.map((_, i) => i + 1));
  assert.equal(driftBucket(2.9), 0);
  assert.equal(driftBucket(31), 4);
});

test('推移の記録から「発走10分前 → 確定」のずれ', () => {
  const card = { entries: [{ number: 1, odds: 2.0, placeMin: 1.2 }, { number: 2, odds: 10, placeMin: 2.5 }] };
  const doc = {
    id: 'r1',
    date: '2026-10-10',
    startTime: '12:00',
    snapshots: [
      { at: '2026-10-10T02:30:00Z', win: { 1: 2.4, 2: 9 }, place: {} },
      { at: '2026-10-10T02:49:00Z', win: { 1: 2.2, 2: 9.5 }, place: { 1: [1.3, 1.5] } },
      { at: '2026-10-10T02:58:00Z', win: { 1: 2.05, 2: 10 }, place: { 1: [1.2, 1.4] } },
    ],
  };
  const s = driftSamples([doc], () => card, 10);
  // 12:00 JST の10分前（02:50Z）以前で最後の記録は 02:49Z
  assert.equal(s.length, 2);
  assert.ok(Math.abs(s[0][1] - Math.log(2.2 / 2.0)) < 1e-12);
  assert.ok(Math.abs(s[0][2] - Math.log(1.3 / 1.2)) < 1e-12);
  assert.equal(s[1][2], null);
});

test('要素ごとの実績：出馬表の1頭の要素の値（前の出走だけから）', () => {
  const race = makeRace({ seed: 5, date: '2026-10-10' });
  const e = race.entries[0];
  const vals = new Map(horseFactorValues(race, e));
  assert.ok(vals.has('rest'));
  assert.ok(vals.has('classChange'));
  assert.ok(vals.has('style'));
  assert.ok(factorStat('popularity', '1番人気')?.n > 1000);
  assert.equal(factorStat('jockey', 'いない騎手'), null);
});

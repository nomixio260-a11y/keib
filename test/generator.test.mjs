import test from 'node:test';
import assert from 'node:assert/strict';

import { generateRaceDay, generateBacktestRaces } from '../src/data/generator.js';
import { payoutKey } from '../src/engine/backtest.js';

test('サンプル開催日は決定論的に生成される', () => {
  const a = generateRaceDay();
  const b = generateRaceDay();
  assert.equal(a.races.length, 24);
  assert.deepEqual(
    a.races.map((r) => r.entries.map((e) => [e.name, e.odds])),
    b.races.map((r) => r.entries.map((e) => [e.name, e.odds])),
  );
});

test('出馬表の整合性', () => {
  const { races } = generateRaceDay();
  const names = new Set();
  for (const race of races) {
    const n = race.entries.length;
    assert.deepEqual(
      race.entries.map((e) => e.number),
      Array.from({ length: n }, (_, i) => i + 1),
    );
    const pops = race.entries.map((e) => e.popularity).sort((x, y) => x - y);
    assert.deepEqual(pops, Array.from({ length: n }, (_, i) => i + 1), '人気は1〜頭数の順位');
    const inv = race.entries.reduce((a, e) => a + 1 / e.odds, 0);
    assert.ok(inv > 1.1 && inv < 1.45, `控除率に見合うオッズ: ${inv}`);
    for (const e of race.entries) {
      assert.ok(e.frame >= 1 && e.frame <= 8);
      assert.ok(e.odds >= 1.1);
      assert.ok(!names.has(e.name), `馬名の重複: ${e.name}`);
      names.add(e.name);
      assert.ok([...e.name].length <= 9);
      for (let k = 0; k < e.past.length; k++) {
        const p = e.past[k];
        assert.ok(p.date < race.date, '過去走はレース日より前');
        if (k > 0) assert.ok(p.date < e.past[k - 1].date, '新しい順');
        assert.ok(p.finish >= 1 && p.finish <= p.fieldSize);
        assert.ok(p.time > 50 && p.time < 250);
      }
    }
    if (race.grade === '新馬') assert.ok(race.entries.every((e) => e.past.length === 0));
    else assert.ok(race.entries.every((e) => e.past.length >= 1));
  }
});

test('バックテスト用レースには結果と払戻がある', () => {
  const races = generateBacktestRaces(20, 5);
  for (const race of races) {
    const nums = race.entries.map((e) => e.number);
    assert.deepEqual([...race.result].sort((a, b) => a - b), nums);
    const [a, b, c] = race.result;
    assert.ok(race.payouts.win[a] >= 110);
    assert.ok(race.payouts.trifecta[payoutKey('trifecta', [a, b, c])] >= 100);
    assert.ok(race.payouts.trio[payoutKey('trio', [a, b, c])] >= 100);
    assert.ok(race.payouts.quinella[payoutKey('quinella', [a, b])] >= 100);
    if (nums.length >= 8) assert.equal(Object.keys(race.payouts.place).length, 3);
  }
});

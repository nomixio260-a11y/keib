// 設定の効果（日ごとの集計）と、設定画面の要約・標準かどうかの判定

import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeDays, effectDelta } from '../src/engine/effect.js';
import { settingsChips, isStandardSettings } from '../src/ui/settingsView.js';
import { DEFAULT_WEIGHTS, DEFAULT_NOISE, DEFAULT_PRESET } from '../src/engine/model.js';
import { DEFAULT_STRATEGY, DEFAULT_TYPES } from '../src/engine/bets.js';

test('日ごとの集計：収支・回収率・負けた日・1回も勝てない日・最悪の日', () => {
  const rows = [
    { date: '2026-10-03', stake: 3000, pay: 4200, hit: true },
    { date: '2026-10-03', stake: 0, pay: 0, hit: false },
    { date: '2026-10-03', stake: 3000, pay: 0, hit: false },
    { date: '2026-10-04', stake: 2000, pay: 0, hit: false },
    { date: '2026-10-04', stake: 1000, pay: 0, hit: false },
    { date: '2026-10-05', stake: 0, pay: 0, hit: false },
  ];
  const s = summarizeDays(rows);
  assert.equal(s.days.length, 3);
  assert.deepEqual(s.days.map((d) => d.date), ['2026-10-03', '2026-10-04', '2026-10-05']);
  assert.equal(s.races, 6);
  assert.equal(s.bets, 4);
  assert.equal(s.hitRaces, 1);
  assert.equal(s.stake, 9000);
  assert.equal(s.pay, 4200);
  assert.equal(s.profit, -4800);
  assert.ok(Math.abs(s.roi - 4200 / 9000) < 1e-12);
  // 買った日は 10/3・10/4 の2日（10/5 は買っていない）。10/3 は −1,800、10/4 は −3,000 で1回も当たっていない
  assert.equal(s.dayCount, 3);
  assert.equal(s.betDays, 2);
  assert.equal(s.loseDays, 2);
  assert.equal(s.noWinDays, 1);
  assert.equal(s.worst, -3000);
  assert.equal(s.best, -1800);
  const empty = summarizeDays([]);
  assert.equal(empty.roi, null);
  assert.equal(empty.worst, null);
  const d = effectDelta(s, { ...s, profit: s.profit + 1000, loseDays: 1 });
  assert.equal(d.profit, 1000);
  assert.equal(d.loseDays, -1);
  assert.equal(effectDelta(null, s), null);
});

test('設定の要約と、標準（予想と買い方。1レースの予算は問わない）かどうか', () => {
  const std = { preset: DEFAULT_PRESET, weights: { ...DEFAULT_WEIGHTS }, noise: DEFAULT_NOISE, strategy: DEFAULT_STRATEGY, betTypes: [...DEFAULT_TYPES], blend: 'auto', keep: 'auto', dayBudget: 'auto', budget: 1000, sims: 50000 };
  const defaults = { weights: DEFAULT_WEIGHTS, noise: DEFAULT_NOISE };
  assert.equal(isStandardSettings(std, defaults), true);
  assert.equal(isStandardSettings({ ...std, budget: 5000 }, defaults), true);
  assert.equal(isStandardSettings({ ...std, strategy: 'balance' }, defaults), false);
  assert.equal(isStandardSettings({ ...std, noise: DEFAULT_NOISE + 0.2 }, defaults), false);
  assert.equal(isStandardSettings({ ...std, dayBudget: 0 }, defaults), false);
  assert.equal(isStandardSettings({ ...std, betTypes: ['win', 'place'] }, defaults), false);
  const chips = settingsChips(std);
  assert.ok(chips.some((c) => c.includes('1R 1,000円')));
  assert.ok(chips.some((c) => c.includes('1日の予算 7倍')));
  assert.ok(settingsChips({ ...std, dayBudget: 0 }).some((c) => c.includes('1日の予算なし')));
});

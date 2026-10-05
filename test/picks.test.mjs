// 発走前の買い目の記録：発走1分前を過ぎたレースは書き換えない・記録した買い目を実際の払戻で精算・1日の予算は記録した金額を先に使う

import test from 'node:test';
import assert from 'node:assert/strict';

import { pickEntry, mergePicks, settlePick, summarizePicks, FREEZE_MS } from '../src/engine/picks.js';
import { dayPicks } from '../src/collector/picksRecorder.js';
import { AUTO_STAKE } from '../src/engine/bets.js';
import { makeRace } from './fixtures/race.mjs';

const T0 = Date.parse('2026-10-10T10:00:00+09:00');
const entry = (at, tickets) => ({ at, oddsAt: at, tickets, used: tickets.reduce((s, t) => s + t.stake, 0), skip: tickets.length ? null : '見送り' });

test('記録：最初の買い目（first）は一度だけ、最後の買い目（last）は発走1分前まで。発走後は書き換えない', () => {
  const start = { a: T0 + 60 * 60000, b: T0 + 20 * 60000 };
  const startOf = (id) => start[id];
  const e1 = entry('t1', [{ type: 'place', nums: [3], stake: 500, odds: 1.4, p: 0.7 }]);
  let { doc, changed } = mergePicks(null, '2026-10-10', { a: e1, b: e1 }, { now: T0, startOf, settings: { budget: 1000 } });
  assert.equal(changed, 2);
  assert.deepEqual(doc.races.a.first, e1);
  assert.deepEqual(doc.races.a.last, e1);
  assert.equal(doc.settings.budget, 1000);
  // 同じ買い目なら書き換えない（記録の時刻も最初のまま）
  ({ doc, changed } = mergePicks(doc, '2026-10-10', { a: entry('t2', e1.tickets) }, { now: T0 + 60000, startOf }));
  assert.equal(changed, 0);
  assert.equal(doc.races.a.last.at, 't1');
  // 買い目が変わったら last だけ書き換える
  const e3 = entry('t3', [{ type: 'win', nums: [5], stake: 300, odds: 4.2, p: 0.3 }]);
  ({ doc, changed } = mergePicks(doc, '2026-10-10', { a: e3 }, { now: T0 + 120000, startOf }));
  assert.equal(changed, 1);
  assert.deepEqual(doc.races.a.first, e1);
  assert.deepEqual(doc.races.a.last, e3);
  // 発走1分前を過ぎたレース（b）は、新しい買い目が来ても書き換えない
  const late = start.b - FREEZE_MS + 1;
  ({ doc, changed } = mergePicks(doc, '2026-10-10', { b: e3 }, { now: late, startOf }));
  assert.equal(changed, 0);
  assert.deepEqual(doc.races.b.last, e1);
  // 記録のない発走済みのレースは足さない
  ({ doc, changed } = mergePicks(doc, '2026-10-10', { c: e3 }, { now: late, startOf: (id) => (id === 'c' ? T0 : startOf(id)) }));
  assert.equal(changed, 0);
  assert.equal(doc.races.c, undefined);
  // 別の日の記録には混ぜない
  const other = mergePicks(doc, '2026-10-11', { a: e3 }, { now: T0, startOf });
  assert.equal(other.doc.date, '2026-10-11');
  assert.deepEqual(Object.keys(other.doc.races), ['a']);
});

test('記録した買い目の精算と集計（結果のないレースは数えない）', () => {
  const race = { id: 'r1', result: [{ number: 3, finish: 1 }], payouts: { place: { 3: 140, 5: 300 }, win: { 3: 250 } } };
  assert.equal(settlePick({ id: 'x' }, entry('t', [])), null);
  const s = settlePick(race, entry('t', [{ type: 'place', nums: [3], stake: 500 }, { type: 'win', nums: [7], stake: 200 }]));
  assert.deepEqual(s, { stake: 700, pay: 700, hits: 1 });
  const docs = [
    { date: '2026-10-10', races: { r1: { first: entry('a', [{ type: 'win', nums: [3], stake: 100 }]), last: entry('b', [{ type: 'place', nums: [3], stake: 500 }]) }, r2: { last: entry('b', [{ type: 'place', nums: [1], stake: 300 }]) } } },
  ];
  const byId = (id) => (id === 'r1' ? race : { id, result: [] });
  const last = summarizePicks(docs, byId, 'last');
  assert.equal(last.recorded, 2);
  assert.equal(last.settled, 1);
  assert.equal(last.bets, 1);
  assert.equal(last.hits, 1);
  assert.equal(last.stake, 500);
  assert.equal(last.pay, 700);
  assert.equal(last.profit, 200);
  const first = summarizePicks(docs, byId, 'first');
  assert.equal(first.recorded, 1);
  assert.equal(first.pay, 250);
});

test('1日分の記録：発走1分前を過ぎたレースは記録しない。発走済みのレースは記録した金額で1日の予算を先に使う', () => {
  const races = [];
  for (let seed = 1; seed <= 12; seed++) {
    const race = makeRace({ seed, id: `r${seed}`, date: '2026-10-10' });
    for (const e of race.entries) Object.assign(e, { placeMin: Math.round((1.2 + e.popularity * 0.3) * 10) / 10, placeMax: Math.round((1.7 + e.popularity * 0.6) * 10) / 10 });
    const fav = race.entries.find((e) => e.popularity === 1);
    for (const p of fav.past) Object.assign(p, { finish: 1, popularity: 1, margin: -0.8, time: Math.round((p.time - 1.5) * 10) / 10 });
    const m = 10 * 60 + seed * 30;
    Object.assign(race, { raceNo: seed, startTime: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` });
    races.push(race);
  }
  // 10:00 の時点：10:30 発走の r1 から全部これから
  const all = dayPicks(races, null, { now: T0 });
  assert.ok(Object.keys(all).length >= 6, `${Object.keys(all).length}`);
  assert.ok(Object.values(all).filter((e) => e.used > 0).length >= 2, '買い目のあるレースがある');
  for (const e of Object.values(all)) {
    assert.ok(e.tickets.every((t) => t.stake >= 100 && t.nums.length >= 1));
    assert.equal(e.used, e.tickets.reduce((s, t) => s + t.stake, 0));
  }
  const totalAll = Object.values(all).reduce((s, e) => s + e.used, 0);
  assert.ok(totalAll <= AUTO_STAKE.dayBudget.mult * 1000, `1日の予算まで（${totalAll}円）`);
  // 11:01 の時点：r1（10:30）・r2（11:00）は発走済み → 記録しない
  const later = dayPicks(races, null, { now: T0 + 61 * 60000 });
  assert.equal(later.r1, undefined);
  assert.equal(later.r2, undefined);
  // 発走済みの r1 に予算いっぱいの記録があれば、これからのレースは買えない（後から予算を取り戻さない）
  const big = { date: '2026-10-10', races: { r1: { first: null, last: { at: 'x', tickets: [{ type: 'place', nums: [races[0].entries.find((e) => e.popularity === 1).number], stake: AUTO_STAKE.dayBudget.mult * 1000, odds: 1.5, p: 0.7 }], used: AUTO_STAKE.dayBudget.mult * 1000, skip: null } } } };
  const after = dayPicks(races, big, { now: T0 + 31 * 60000 });
  assert.ok(Object.keys(after).length >= 5, `${Object.keys(after).length}`);
  let cut = 0;
  for (const [id, e] of Object.entries(after)) {
    assert.equal(e.used, 0);
    // 予算があれば買っていたレースは「1日の予算」で見送り
    if (all[id]?.used > 0) {
      assert.match(e.skip, /1日の予算/);
      cut++;
    }
  }
  assert.ok(cut > 0, '予算があれば買っていたレースで確かめている');
});

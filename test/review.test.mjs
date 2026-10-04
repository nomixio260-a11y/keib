// 外れたレースの分析（src/engine/review.js）：外れ方の型の判定と、期間の集計

import test from 'node:test';
import assert from 'node:assert/strict';

import { reviewRace, reviewSummary, reviewText, verdictOf } from '../src/engine/review.js';

// 5頭：AI の勝率 50%・30%・10%・5%・5%、人気は 1・2・5・3・4
function fixture(winner) {
  const rows = [
    { n: 1, p: 0.5, q: 0.45, pop: 1, mark: '◎' },
    { n: 2, p: 0.3, q: 0.3, pop: 2, mark: '○' },
    { n: 3, p: 0.1, q: 0.06, pop: 5, mark: '▲' },
    { n: 4, p: 0.05, q: 0.12, pop: 3, mark: '△' },
    { n: 5, p: 0.05, q: 0.07, pop: 4, mark: '' },
  ].map((r) => ({ entry: { number: r.n, name: `馬${r.n}`, popularity: r.pop, odds: 0.8 / r.q }, pWin: r.p, marketProb: r.q, mark: r.mark }));
  const order = [...rows].sort((a, b) => b.pWin - a.pWin || a.entry.number - b.entry.number);
  const others = [1, 2, 3, 4, 5].filter((n) => n !== winner);
  const result = [winner, ...others];
  const finishes = Object.fromEntries(result.map((n, i) => [String(n), i + 1]));
  const pred = { empty: false, rows, order, confidence: { grade: 'A', volatility: '普通' } };
  const race = { result, finishes, surface: '芝', grade: '1勝' };
  return { pred, race };
}

test('外れ方の型：◎的中・惜しい外れ（AI 2・3番手）・AI の見落とし（人気馬を4番手以下）・波乱', () => {
  const kind = (w) => {
    const { pred, race } = fixture(w);
    return reviewRace(pred, race).kind;
  };
  assert.equal(kind(1), 'hit');
  assert.equal(kind(2), 'near');
  assert.equal(kind(3), 'near'); // 5番人気でも AI の3番手なら惜しい外れ
  assert.equal(kind(4), 'overlook'); // 3番人気を AI は4番手
  assert.equal(kind(5), 'upset'); // 4番人気・AI 5番手
  const { pred, race } = fixture(2);
  const r = reviewRace(pred, race);
  assert.equal(r.honmei.number, 1);
  assert.equal(r.honmei.fin, 2);
  assert.equal(r.winner.rank, 2);
  assert.equal(r.seg.surface, '芝');
  assert.equal(r.seg.cls, '1〜3勝クラス');
  assert.match(reviewText(r), /AI の2番手/);
  // 結果がなければ null
  assert.equal(reviewRace(pred, { ...race, result: [] }), null);
});

test('期間の集計：◎の勝ち数と見込み、外れ方の内訳、AI推奨の的中と見込み', () => {
  const items = [1, 2, 5, 1, 4].map((w, i) => {
    const { pred, race } = fixture(w);
    return { review: reviewRace(pred, race), bet: i < 3 ? { stake: 1000, hits: i === 0 ? 1 : 0, expHit: 0.8 } : { stake: 0, hits: 0 } };
  });
  const s = reviewSummary(items);
  assert.equal(s.races, 5);
  assert.equal(s.hits, 2);
  assert.ok(Math.abs(s.exp - 2.5) < 1e-9);
  assert.deepEqual(s.kinds, { hit: 2, near: 1, upset: 1, overlook: 1 });
  assert.equal(s.bets.races, 3);
  assert.equal(s.bets.hits, 1);
  assert.ok(Math.abs(s.bets.exp - 2.4) < 1e-9);
  // 5レースでは条件ごとの判定はしない（20レース未満）
  assert.ok(s.segments.every((x) => !x.flag));
  assert.equal(verdictOf(-2.5, 30).key, 'bad');
  assert.equal(verdictOf(2.1, 30).key, 'good');
  assert.equal(verdictOf(0.3, 30).key, 'ok');
});

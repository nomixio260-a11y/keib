#!/usr/bin/env node
// 2着内・3着内（複勝）の確率の当てはまりを検証期間で測る：
//   PL（モデルのスコア＋着順ごとの温度。いまの表示）、複勝オッズから見込まれる確率（別の投票の市場）、単勝オッズからの Harville、
//   それらの対数オッズの平均（混合）。二値の対数損失・Brier・帯ごとの実際の率。
//   node scripts/place-check.mjs   環境変数：TEST_START、DATASET_FILE

import path from 'node:path';
import { readJson, DATA_DIR } from '../src/collector/store.js';
import { groupRaces } from './lib/boost.mjs';
import { GBDT_MODEL } from '../src/engine/gbdtModel.js';
import { treeSum, baseOf } from '../src/engine/gbdt.js';
import { exactPL } from '../src/engine/simulate.js';
import { harvilleTopK } from '../src/engine/features.js';

const TEST_START = process.env.TEST_START || '2026-07-01';
const ds = await readJson(process.env.DATASET_FILE || path.join(DATA_DIR, 'dataset.json'));
const names = ds.names;
const ix = (k) => names.indexOf(k);
const iLogq = ix('logq');
const iPlaceLog = ix('placeLog');
const iPlaceKnown = ix('placeKnown');
const test = groupRaces(ds.rows).filter((rs) => rs[0].date >= TEST_START && rs.length >= 5);
const temps = GBDT_MODEL.temps || [1, 1, 1];
const logitF = (p) => Math.log(Math.max(p, 1e-4) / Math.max(1 - p, 1e-4));
const sig = (u) => 1 / (1 + Math.exp(-u));
const rows = [];
let noPlace = 0;
for (const rs of test) {
  const n = rs.length;
  const k = n >= 8 ? 3 : 2;
  const scores = rs.map((r) => baseOf(r.x[iLogq]) + treeSum(r.x));
  const ex = exactPL(scores, { temps });
  const pModel = k === 3 ? ex.top3 : ex.top2;
  const q = rs.map((r) => Math.exp(r.x[iLogq]));
  const qs = q.reduce((a, b) => a + b, 0);
  const hv = harvilleTopK(q.map((v) => v / qs), k);
  const known = rs.every((r) => r.x[iPlaceKnown] > 0.5);
  if (!known) noPlace++;
  rs.forEach((r, i) => {
    const pPlace = Math.exp(r.x[iPlaceLog]); // 複勝オッズの中央値から（全頭そろわないときは Harville が入っている）
    rows.push({ y: r.finish > 0 && r.finish <= k ? 1 : 0, model: pModel[i], place: pPlace, hv: hv[i], known, k });
  });
}
const clip = (p) => Math.min(1 - 1e-4, Math.max(1e-4, p));
const ll = (f) => -rows.reduce((s, r) => s + (r.y ? Math.log(clip(f(r))) : Math.log(1 - clip(f(r)))), 0) / rows.length;
const brier = (f) => rows.reduce((s, r) => s + (clip(f(r)) - r.y) ** 2, 0) / rows.length;
const cands = {
  'PL（モデル＋温度、いまの表示）': (r) => r.model,
  '複勝オッズから': (r) => r.place,
  '単勝からの Harville': (r) => r.hv,
  '混合：PL と複勝オッズの対数オッズ平均': (r) => sig((logitF(r.model) + logitF(r.place)) / 2),
  '混合：PL 0.3・複勝 0.7': (r) => sig(0.3 * logitF(r.model) + 0.7 * logitF(r.place)),
};
console.log(`検証 ${test.length}レース・${rows.length}頭（複勝オッズが全頭そろわないレース ${noPlace}）。3着内（7頭以下は2着内）の確率`);
console.log('方法 | 二値の対数損失 | Brier');
for (const [k, f] of Object.entries(cands)) console.log(`${k} | ${ll(f).toFixed(4)} | ${brier(f).toFixed(4)}`);
// 帯ごとの当てはまり（PL と 複勝オッズ）
const edges = [0, 0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 1.01];
for (const [label, f] of [['PL', cands['PL（モデル＋温度、いまの表示）']], ['複勝オッズ', cands['複勝オッズから']]]) {
  const b = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], n: 0, p: 0, y: 0 }));
  for (const r of rows) { const p = f(r); const x = b.find((c) => p >= c.lo && p < c.hi); if (x) { x.n++; x.p += p; x.y += r.y; } }
  console.log(`${label}：${b.filter((c) => c.n).map((c) => `${(c.lo * 100).toFixed(0)}〜${(Math.min(1, c.hi) * 100).toFixed(0)}% 予測 ${((c.p / c.n) * 100).toFixed(1)} 実際 ${((c.y / c.n) * 100).toFixed(1)}（${c.n}）`).join(' | ')}`);
}
// 対の比較（レースごとではなく頭ごとの差の平均 ± 標準誤差）
const paired = (fa, fb) => { const d = rows.map((r) => (r.y ? Math.log(clip(fb(r))) - Math.log(clip(fa(r))) : Math.log(1 - clip(fb(r))) - Math.log(1 - clip(fa(r))))); const m = d.reduce((s, v) => s + v, 0) / d.length; const se = Math.sqrt(d.reduce((s, v) => s + (v - m) ** 2, 0) / (d.length - 1) / d.length); return `${m >= 0 ? '+' : ''}${m.toFixed(4)} ± ${se.toFixed(4)}`; };
console.log(`対の比較（PL → 複勝オッズ）${paired(cands['PL（モデル＋温度、いまの表示）'], cands['複勝オッズから'])}、（PL → 混合 平均）${paired(cands['PL（モデル＋温度、いまの表示）'], cands['混合：PL と複勝オッズの対数オッズ平均'])}`);

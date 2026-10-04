#!/usr/bin/env node
// 外れたレースの分析：学習に使っていない予測（学習期間の分割外と検証期間）で、外れ方の型と、AI の見込みからの系統的なずれを調べる。
//   1) 学習期間の分割外のスコア（日付で5分割、配信中のモデルと同じ設定。data/oof-scores.json にキャッシュ）と、検証期間の配信中の
//      モデルで、本番と同じ流れ（predictRace）で予想し、src/engine/review.js で外れ方の型（惜しい外れ・波乱・AI の見落とし）を数える
//   2) ◎が1番人気と違うときの勝率（AI の判断がオッズより当たっているか）
//   3) 条件と馬の型（休み明け・キャリア・昇級・距離変化・前走着順・馬体重・脚質・枠など）ごとに、勝ち数と AI の見込み（勝率の合計）を
//      比べ、学習期間で |z| ≥ 2、検証期間でも同じ向きの区分を探す（◎だけと全馬の両方）
//   4) src/engine/missStats.js に書く（バックテスト画面の「外れたレースの分析」の長期の分析）
//
//   node scripts/miss-analysis.mjs        （npm run miss-analysis。モデルを作り直したら OOF=refresh で分割外を作り直す）

import path from 'node:path';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { readJson, writeJson, loadHistory, attachFinalExoticOdds, DATA_DIR, ROOT } from '../src/collector/store.js';
import { DEFAULT_PARAMS, groupRaces, flatten, makeThresholds, binize, trainBoost, evalTrees, dateFolds } from './lib/boost.mjs';
import { GBDT_MODEL } from '../src/engine/gbdtModel.js';
import { predictRace, PRESETS } from '../src/engine/model.js';
import { reviewRace } from '../src/engine/review.js';
import { indexHistory, preRaceCard, attachCareer } from '../src/data/history.js';
import { usable, statsForEngine } from './calibrate.mjs';

const TEST_START = process.env.TEST_START || '2026-07-01';
const Z_CUT = 2;
const OOF_FILE = path.join(DATA_DIR, 'oof-scores.json');
const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

// ---------- 1) 学習期間の分割外のスコア ----------
const P = GBDT_MODEL.params;
const sig = JSON.stringify({ only: P.only, depth: P.depth, lr: P.lr, lambda: P.lambda, colsample: P.colsample, subsample: P.subsample, rounds: P.rounds, trainedOn: GBDT_MODEL.trainedOn });
const ds = await readJson(path.join(DATA_DIR, 'dataset.json'));
if (!ds) throw new Error('data/dataset.json がありません（node scripts/dataset.mjs）');
let cache = process.env.OOF !== 'refresh' && existsSync(OOF_FILE) ? await readJson(OOF_FILE) : null;
if (cache && cache.sig !== sig) {
  log('分割外のスコアは前のモデルのものなので作り直します');
  cache = null;
}
if (!cache) {
  const Fn = ds.names.length;
  const iLogq = ds.names.indexOf('logq');
  const races = groupRaces(ds.rows).filter((rs) => rs.length >= 2 && rs.some((r) => r.y) && rs[0].date < TEST_START);
  const feats = (P.only?.length ? P.only : ds.names).map((k) => ds.names.indexOf(k)).filter((i) => i >= 0);
  const params = { ...DEFAULT_PARAMS, depth: P.depth, lr: P.lr, lambda: P.lambda, colsample: P.colsample, subsample: P.subsample, rounds: Math.round((P.rounds || 1000) / 1.2), patience: 0 };
  const folds = dateFolds(races, 5);
  const scores = {};
  for (let k = 0; k < 5; k++) {
    const t0 = Date.now();
    const fit = flatten(folds.filter((_, j) => j !== k).flat(), Fn, { baseIndex: iLogq });
    const thresholds = makeThresholds(fit);
    binize(fit, thresholds);
    const valid = binize(flatten(folds[k], Fn, { baseIndex: iLogq }), thresholds);
    const r = trainBoost({ fit, valids: [], thresholds, feats, params, seed: 1000 + k });
    const m = evalTrees(r.trees, valid).m;
    for (let ri = 0; ri < valid.races.length; ri++) scores[valid.races[ri][0].raceId] = valid.races[ri].map((row, i) => [row.number, m[valid.start[ri] + i]]);
    log(`分割外 ${k + 1}/5：${folds[k].length}レース（${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
  }
  cache = { sig, scores };
  await writeJson(OOF_FILE, cache);
}
const FI = Object.fromEntries(ds.names.map((n, i) => [n, i]));
const X = new Map();
for (const r of ds.rows) X.set(`${r.raceId}|${r.number}`, r.x);
ds.rows = null;
const fx = (x, k) => (x && FI[k] != null ? x[FI[k]] : null);

// ---------- 予想と答え合わせ ----------
const all = await loadHistory();
const index = indexHistory(all);
const stats = statsForEngine(all.filter((r) => r.date < TEST_START), all);
const oofCards = all.filter((r) => r.date < TEST_START && usable(r) && cache.scores[r.id]).map((r) => preRaceCard(r, index));
const holdCards = all.filter((r) => r.date >= TEST_START && usable(r)).map((r) => preRaceCard(r, index));
await attachFinalExoticOdds(oofCards);
await attachFinalExoticOdds(holdCards);
attachCareer(holdCards, index, { stats });
const SETS = { oof: { label: '学習期間の分割外', cards: oofCards }, hold: { label: '検証期間', cards: holdCards } };
const recs = { oof: [], hold: [] };
for (const [set, { cards }] of Object.entries(SETS)) {
  for (const card of cards) {
    if (!card.result?.length) continue;
    const opts = { weights: PRESETS.ml.weights, noise: 1, stats, ml: true, sims: 0 };
    if (set === 'oof') Object.assign(opts, { mlScores: new Map(cache.scores[card.id]), mlTemps: GBDT_MODEL.temps });
    const pred = predictRace(card, opts);
    const review = reviewRace(pred, card);
    if (!review) continue;
    const fav = [...pred.rows].sort((a, b) => (b.marketProb ?? 0) - (a.marketProb ?? 0) || a.entry.number - b.entry.number)[0];
    const horses = pred.rows.map((r) => ({ num: r.entry.number, p: r.pWin, q: r.marketProb ?? 0, pop: r.entry.popularity || 0, frame: r.entry.frame || 0, win: card.result[0] === r.entry.number, top: r === pred.order[0], x: X.get(`${card.id}|${r.entry.number}`) }));
    recs[set].push({ card, review, fav: { num: fav.entry.number, p: fav.pWin, q: fav.marketProb ?? 0 }, horses });
  }
  log(`${SETS[set].label}：${recs[set].length}レース`);
}

// ---------- 2) 外れ方の型・◎と1番人気 ----------
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const out = { generatedAt: new Date().toISOString().slice(0, 10), model: { trainedOn: GBDT_MODEL.trainedOn, test: GBDT_MODEL.test }, sets: {} };
for (const [set, rs] of Object.entries(recs)) {
  const s = { label: SETS[set].label, period: `${rs[0].card.date}〜${rs[rs.length - 1].card.date}`, races: rs.length, hits: 0, exp: 0, kinds: { hit: 0, near: 0, upset: 0, overlook: 0 }, honmeiFin: { 2: 0, 3: 0, out: 0 }, favSame: 0, diff: { races: 0, honmei: 0, fav: 0, honmeiAi: 0, favAi: 0, honmeiMkt: 0, favMkt: 0 } };
  for (const { review: r, fav } of rs) {
    s.kinds[r.kind]++;
    s.exp += r.honmei.p;
    if (r.kind === 'hit') s.hits++;
    else s.honmeiFin[r.honmei.fin === 2 ? 2 : r.honmei.fin === 3 ? 3 : 'out']++;
    if (fav.num === r.honmei.number) s.favSame++;
    else {
      const d = s.diff;
      d.races++;
      d.honmeiAi += r.honmei.p;
      d.favAi += fav.p;
      if (r.kind === 'hit') d.honmei++;
      if (r.winner.number === fav.num) d.fav++;
    }
  }
  const d = s.diff;
  out.sets[set] = {
    label: s.label,
    period: s.period,
    races: s.races,
    hits: s.hits,
    hit: s.hits / s.races,
    exp: s.exp / s.races,
    kinds: s.kinds,
    honmeiFin: s.honmeiFin,
    favShare: s.favSame / s.races,
    diff: { races: d.races, honmeiWin: d.honmei / Math.max(1, d.races), favWin: d.fav / Math.max(1, d.races), honmeiAi: d.honmeiAi / Math.max(1, d.races), favAi: d.favAi / Math.max(1, d.races) },
  };
  const o = out.sets[set];
  const miss = o.races - o.hits;
  console.log(`\n[${o.label}] ${o.period}・${o.races}レース  ◎ ${pct(o.hit)}（見込み ${pct(o.exp)}）`);
  console.log(`  外れ ${miss}：惜しい ${pct(o.kinds.near / miss)}・波乱 ${pct(o.kinds.upset / miss)}・AI の見落とし ${pct(o.kinds.overlook / miss)}　外れたときの◎：2着 ${pct(o.honmeiFin[2] / miss)}・3着 ${pct(o.honmeiFin[3] / miss)}・4着以下 ${pct(o.honmeiFin.out / miss)}`);
  console.log(`  ◎＝1番人気 ${pct(o.favShare)}。違うとき（${o.diff.races}R）：◎ ${pct(o.diff.honmeiWin)}（AI ${pct(o.diff.honmeiAi)}）・1番人気 ${pct(o.diff.favWin)}（AI ${pct(o.diff.favAi)}）`);
}

// ---------- 3) 条件と馬の型ごとの校正 ----------
const bands = (edges, labels) => (v) => {
  if (v == null || !Number.isFinite(v)) return null;
  for (let i = 0; i < edges.length; i++) if (v <= edges[i]) return labels[i];
  return labels[labels.length - 1];
};
const cls = (c) => (['新馬', '未勝利'].includes(c.grade) ? c.grade : ['1勝', '2勝', '3勝'].includes(c.grade) ? c.grade : 'オープン・重賞');
const SEGS = {
  芝ダ: (h, c) => c.surface,
  距離: (h, c) => bands([1300, 1700, 2100], ['〜1300m', '1400〜1700m', '1800〜2100m', '2200m〜'])(c.distance),
  頭数: (h, c, n) => bands([9, 13], ['9頭以下', '10〜13頭', '14頭以上'])(n),
  クラス: (h, c) => cls(c),
  馬場: (h, c) => (c.going === '良' ? '良' : c.going === '稍重' ? '稍重' : '重・不良'),
  ハンデ: (h, c) => (/ハンデ/.test(c.weightRule || '') ? 'ハンデ' : 'それ以外'),
  季節: (h, c) => ['冬', '冬', '春', '春', '春', '夏', '夏', '夏', '秋', '秋', '秋', '冬'][Number(c.date.slice(5, 7)) - 1],
  競馬場: (h, c) => c.course,
  人気: (h) => (h.pop === 1 ? '1番人気' : h.pop <= 3 ? '2〜3番人気' : h.pop <= 5 ? '4〜5番人気' : h.pop <= 9 ? '6〜9番人気' : '10番人気〜'),
  'AI÷オッズ': (h) => bands([0.7, 0.9, 1.1, 1.4], ['〜0.7', '0.7〜0.9', '0.9〜1.1', '1.1〜1.4', '1.4〜'])(h.p / Math.max(1e-4, h.q)),
  枠: (h) => (h.frame <= 0 ? null : bands([2, 4, 6], ['1〜2枠', '3〜4枠', '5〜6枠', '7〜8枠'])(h.frame)),
  休み明け: (h) => bands([14, 35, 90, 180, 399], ['〜2週', '3〜5週', '6〜12週', '13〜25週', '26週〜', '初出走'])(fx(h.x, 'daysSince')),
  キャリア: (h) => bands([0, 2, 5, 10], ['初出走', '1〜2戦', '3〜5戦', '6〜10戦', '11戦〜'])(fx(h.x, 'cStarts')),
  クラス変化: (h) => { const v = fx(h.x, 'classDelta'); return v == null ? null : v > 0 ? '昇級' : v < 0 ? '降級' : '同じ'; },
  距離変化: (h) => bands([0, 0.2, 0.4], ['同じ', '200m', '400m', '600m〜'])(fx(h.x, 'distDelta')),
  芝ダ替わり: (h) => bands([0, 2, 4], ['近4走になし', '1〜2走', '3〜4走'])(fx(h.x, 'sameSurf4')),
  前走着順: (h) => { if (!fx(h.x, 'n4')) return null; const n = fx(h.x, 'lastFieldSize') || 16; const fin = Math.round((1 - fx(h.x, 'lastFin')) * (n - 1) + 1); return bands([1, 3, 5, 9], ['1着', '2〜3着', '4〜5着', '6〜9着', '10着〜'])(fin); },
  前走人気: (h) => (fx(h.x, 'n4') ? bands([1, 3, 6], ['1番', '2〜3番', '4〜6番', '7番〜'])(Math.round(Math.exp(fx(h.x, 'lastPop') || 0))) : null),
  騎手替わり: (h) => { const v = fx(h.x, 'jockeyChange'); return v == null ? null : v > 0 ? '替わり' : '同じ'; },
  馬体重増減: (h) => (fx(h.x, 'bwKnown') ? bands([-10, -4, 3, 9], ['−10kg〜', '−8〜−4kg', '−2〜+2kg', '+4〜+8kg', '+10kg〜'])(fx(h.x, 'bwDiff')) : null),
  年齢: (h) => bands([2, 3, 4, 5], ['2歳', '3歳', '4歳', '5歳', '6歳〜'])(fx(h.x, 'age')),
  性別: (h) => { const v = fx(h.x, 'sexF'); return v == null ? null : v > 0 ? '牝' : '牡・セ'; },
  脚質: (h) => (fx(h.x, 'styleKnown') ? bands([0.2, 0.45, 0.7], ['逃げ', '先行', '差し', '追込'])(fx(h.x, 'earlyPos')) : null),
  前走で人気を裏切った: (h) => { const v = fx(h.x, 'lastBeatenFav'); return v == null ? null : v > 0 ? 'はい' : 'いいえ'; },
};
const flagged = [];
let cells = 0;
for (const [who, keep] of [
  ['◎', (h) => h.top],
  ['全馬', () => true],
]) {
  for (const [name, fn] of Object.entries(SEGS)) {
    const acc = { oof: new Map(), hold: new Map() };
    for (const set of ['oof', 'hold'])
      for (const { card, horses } of recs[set])
        for (const h of horses) {
          if (!keep(h)) continue;
          const k = fn(h, card, horses.length);
          if (k == null) continue;
          const a = acc[set].get(k) || acc[set].set(k, { n: 0, w: 0, p: 0, v: 0 }).get(k);
          a.n++;
          if (h.win) a.w++;
          a.p += h.p;
          a.v += h.p * (1 - h.p);
        }
    for (const [k, a0] of acc.oof) {
      cells++;
      const a1 = acc.hold.get(k);
      if (!a1 || a0.n < 100) continue;
      const z0 = (a0.w - a0.p) / Math.sqrt(a0.v);
      const z1 = (a1.w - a1.p) / Math.sqrt(a1.v);
      if (Math.abs(z0) >= Z_CUT && Math.sign(z0) === Math.sign(z1)) flagged.push(`${who}・${name}=${k}（分割外 ${(a0.w / a0.p).toFixed(2)}倍 z ${z0.toFixed(1)}・検証 ${(a1.w / a1.p).toFixed(2)}倍 z ${z1.toFixed(1)}）`);
    }
  }
}
out.calibration = { dims: Object.keys(SEGS).length, cells, zCut: Z_CUT, flagged };
console.log(`\n[校正] ${Object.keys(SEGS).length}項目・${cells}区分（◎だけと全馬）で、分割外 |z| ≥ ${Z_CUT} かつ検証も同じ向き：${flagged.length ? flagged.join('、') : 'なし'}`);

const file = path.join(ROOT, 'src/engine/missStats.js');
await writeFile(file, `// scripts/miss-analysis.mjs が学習に使っていない予測から作る。手で編集しないでください。\nexport const MISS_STATS = ${JSON.stringify(out)};\n`);
log(`書き出しました：${path.relative(ROOT, file)}`);

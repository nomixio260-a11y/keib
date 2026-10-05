#!/usr/bin/env node
// 機械学習用のデータセットを実データ（data/history）から作る。
//   node scripts/dataset.mjs            … data/dataset.json（2025-12-01 以降の平地レース、1行＝1頭）
// 各レースについて、そのレースより前の情報だけで特徴量を作る（過去走・通算・騎手/厩舎の成績はすべて「その日より前」）。

import path from 'node:path';
import { loadHistory, writeJson, readJson, loadHorseInfo, DATA_DIR } from '../src/collector/store.js';
import { indexHistory, preRaceCard, careerBefore } from '../src/data/history.js';
import { raceFeatures, FEATURE_NAMES, exoticFeatures, EXOTIC_FEATURE_NAMES, INCLUDE_EXOTIC } from '../src/engine/features.js';
import { REAL_STATS } from '../src/engine/realStats.js';
import { usable } from './calibrate.mjs';
import { tally, rates, CONDITION_KEYS } from '../src/data/rates.js';

const START = process.env.DATASET_START || '2025-12-01';
const EXTRA_MODE = process.env.DATASET_EXTRA === 'exotic' ? 'exotic' : process.env.DATASET_EXTRA === '1' || process.env.DATASET_EXTRA === 'history' ? 'history' : '';
const EXTRA = !!EXTRA_MODE;
// DATASET_EXTRA=exotic：馬連・ワイド・三連複の確定オッズ（data/odds-final）から、別の投票市場の見方を特徴量に
//   exoticKnown … 3券種のオッズがそろっているか、q2Log … 馬連オッズから推定した各馬の強さ（log 確率。p_ij ∝ exp(s_i+s_j) の最小二乗）、
//   q2VsWin … 馬連の見方と単勝の見方のずれ（q2Log − logq）、top2VsHv … 馬連から見た連対確率と単勝からの Harville 連対確率のずれ、
//   wideVsHv … ワイドから見た3着内確率のずれ、trioVsHv … 三連複から見た3着内確率のずれ（いずれも log 比）
//   exWinLog … 馬単オッズから見た勝率（1着がその馬の組み合わせの合計。log）、exVsWin … 馬単の見方と単勝の見方のずれ（exWinLog − logq）
const EXOTIC_NAMES = EXOTIC_FEATURE_NAMES;
const REQUIRE_EXOTIC = process.env.DATASET_REQUIRE_EXOTIC === '1';
const HISTORY_NAMES = ['hPopResid', 'hMktResid', 'hSurfStarts', 'hSurfTop3', 'hDistTop3', 'hCourseTop3', 'hGoingTop3', 'hPairStarts', 'hPairTop3', 'tDebutWin', 'tDebutStarts', 'jWin90', 'tWin90', 'jMktResid', 'tMktResid'];
// 実験用（DATASET_EXTRA=1）：馬と騎手・厩舎の履歴を深く見る特徴量
//   hPopResid … 過去走で「人気より着順が良かった」度合い（(人気 − 着順)/頭数 の合計を走数+3で割る。市場に過小評価されがちな馬はプラス）
//   hMktResid … 過去走の（勝ち − 市場の勝率）の合計を走数+3で割る（市場の期待より勝ってきた馬はプラス）
//   hSurfStarts/hSurfTop3 … 今日の芝ダでの走数と3着内率（事前分布つき）、hDistTop3 … 同じ芝ダで距離 ±200m、hCourseTop3 … 同じ競馬場、
//   hGoingTop3 … 今日と同じ馬場の区分（良・稍重／重・不良）、hPairStarts/hPairTop3 … 今日の騎手がこの馬に乗った回数と3着内率
//   tDebutWin/tDebutStarts … 厩舎の初出走馬（デビュー戦）の勝率と頭数、jWin90/tWin90 … 騎手・厩舎の直近90日の勝率
//   jMktResid/tMktResid … 騎手・厩舎の「市場の期待より勝ってきた」度合い（(勝ち − 市場の勝率) の合計を走数+30で割る。市場が割安に見積もる騎手・厩舎はプラス）
const WINDOW_DAYS = 90;
const dayNum = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
const jWin = new Map(); // 騎手名 → [{ d, win, top3 }]（日付順）
const tWinQ = new Map();
const debutAcc = new Map(); // 厩舎 → { s, w }（初出走馬の走数・勝ち数。その日より前）
const jResid = new Map(); // 騎手 → { s, r }（走数と (勝ち − 市場の勝率) の合計。その日より前）
const tResid = new Map();
const residOf = (map, key, k = 30) => { const a = key ? map.get(key) : null; return a ? a.r / (a.s + k) : 0; };
const pushRun = (map, key, dn, r) => {
  if (!key) return;
  const q = map.get(key) || map.set(key, []).get(key);
  q.push({ d: dn, win: r.finish === 1 ? 1 : 0, top3: r.finish > 0 && r.finish <= 3 ? 1 : 0 });
};
const windowRate = (map, key, dn, prior = 60, avgW = 0.07, avgT = 0.21) => {
  const q = map.get(key);
  if (!q) return { winRate: avgW, top3Rate: avgT, starts: 0 };
  while (q.length && q[0].d < dn - WINDOW_DAYS) q.shift();
  let s = 0, w = 0, t = 0;
  for (const x of q) { s++; w += x.win; t += x.top3; }
  return { starts: s, winRate: (w + prior * avgW) / (s + prior), top3Rate: (t + prior * avgT) / (s + prior) };
};
const shrink = (k, n, prior, w = 4) => (k + prior * w) / (n + w);
/** 馬の履歴（その日より前の出走）から今日の条件に合わせた集計 */
function horseHistory(index, horseId, date, rec, jockey) {
  const runs = (index.byHorse.get(horseId) || []).filter((h) => h.date < date && h.runner.finish > 0);
  const n = runs.length;
  const top3 = (h) => (h.runner.finish <= 3 ? 1 : 0);
  const sub = (f) => {
    const s = runs.filter(f);
    return { n: s.length, rate: shrink(s.reduce((a, h) => a + top3(h), 0), s.length, 0.21) };
  };
  const popResid = n ? runs.reduce((a, h) => a + (h.runner.popularity > 0 ? (h.runner.popularity - h.runner.finish) / Math.max(1, h.rec.fieldSize || h.rec.runners.length) : 0), 0) / (n + 3) : 0;
  const mktResid = n ? runs.reduce((a, h) => a + ((h.runner.finish === 1 ? 1 : 0) - (h.runner.odds > 1 ? Math.min(0.9, 0.8 / h.runner.odds) : 0.07)), 0) / (n + 3) : 0;
  const heavyToday = rec.going === '重' || rec.going === '不良';
  const surf = sub((h) => h.rec.surface === rec.surface);
  const dist = sub((h) => h.rec.surface === rec.surface && Math.abs((h.rec.distance || 0) - rec.distance) <= 200);
  const course = sub((h) => h.rec.course === rec.course);
  const going = sub((h) => (h.rec.going === '重' || h.rec.going === '不良') === heavyToday);
  const pair = sub((h) => !!jockey && h.runner.jockey === jockey);
  return [popResid, mktResid, surf.n, surf.rate, dist.rate, course.rate, going.rate, pair.n, pair.rate];
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const all = await loadHistory();
const index = indexHistory(all);
const horseInfo = await loadHorseInfo();
// 確定オッズ（馬連・ワイド・三連複）：data/odds-final/{年}/{レースID}.json
const exoticDocs = new Map();
if (process.env.DATASET_EXTRA === 'exotic' || INCLUDE_EXOTIC) {
  const { readdir } = await import('node:fs/promises');
  const dir = path.join(DATA_DIR, 'odds-final');
  for (const y of await readdir(dir).catch(() => [])) for (const f of await readdir(path.join(dir, y)).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    const doc = await readJson(path.join(dir, y, f));
    if (doc?.quinella && doc.wide && doc.trio && doc.exacta) exoticDocs.set(doc.id, doc);
  }
  log(`確定オッズ（馬連・ワイド・三連複）のあるレース：${exoticDocs.size}`);
}
log(`血統のある馬：${horseInfo.size}頭`);
const withPedigree = (r) => {
  const info = horseInfo.get(r.horseId);
  return info ? { ...r, sire: info.sire, damSire: info.damSire } : r;
};
// 統計の期間：DATASET_STATS=full（全期間。既定）、pretest（TEST_START より前のレースだけ。検証期間の情報を基準タイムに混ぜない）、
//   train（2026-03-01 より前）、novariant（開催日ごとの馬場差なし）。開催日ごとの馬場差はその日の結果から決まるので、過去走の指数には常に使う
const { statsForEngine, horseInfoOnce } = await import('./calibrate.mjs');
await horseInfoOnce();
const MODE = process.env.DATASET_STATS || 'full';
let BASE_STATS = REAL_STATS;
const TEST_START = process.env.TEST_START || '2026-07-01';
if (MODE.startsWith('train')) BASE_STATS = statsForEngine(all.filter((r) => r.date < '2026-03-01'), all);
if (MODE.startsWith('pretest')) BASE_STATS = statsForEngine(all.filter((r) => r.date < TEST_START), all);
if (MODE.endsWith('novariant')) BASE_STATS = { ...BASE_STATS, dayVariant: {} };
log(`統計：${MODE}（基準タイム ${Object.keys(BASE_STATS.baseTimes).length}条件・馬場差 ${Object.keys(BASE_STATS.dayVariant || {}).length}日）`);
log(`${all.length}レース。${START} 以降を特徴量に`);

let PERTURB = null;
const PERTURB_SEED = process.env.DATASET_PERTURB_SEED || '1';
if (process.env.DATASET_PERTURB) {
  const { loadDrift } = await import('./lib/drift.mjs');
  const { makePerturber } = await import('../src/engine/oddsDrift.js');
  const minutes = Number(String(process.env.DATASET_PERTURB).replace(/^m/, '')) || 10;
  const d = await loadDrift(all, index, minutes);
  PERTURB = makePerturber(d.samples);
  log(`発走${minutes}分前のオッズ（推定）で特徴量を作ります：ずれの標本 ${d.samples.length}頭（${d.races}レース）`);
}

// 騎手・厩舎の成績は「その日より前」の分だけ（同じ日のレースの結果は混ぜない）。条件つき（騎手×競馬場など）も同じ
const jAcc = {};
const tAcc = {};
const cAcc = Object.fromEntries(Object.keys(CONDITION_KEYS).map((k) => [k, {}]));
let cond = Object.fromEntries(Object.keys(CONDITION_KEYS).map((k) => [k, {}]));

const hash = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
};
const rows = [];
let races = 0;
let currentDate = null;
let jr = rates(jAcc);
let tr = rates(tAcc);
const byDate = new Map();
for (const rec of all) (byDate.get(rec.date) || byDate.set(rec.date, []).get(rec.date)).push(rec);
for (const [date, recs] of [...byDate].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  if (date !== currentDate) {
    jr = rates(jAcc);
    tr = rates(tAcc);
    cond = Object.fromEntries(Object.entries(cAcc).map(([k, t]) => [k, rates(t).rates]));
    currentDate = date;
  }
  for (const rec of recs) {
    if (rec.date >= START && usable(rec)) {
      const card = preRaceCard(rec, index);
      for (const e of card.entries) {
        const info = horseInfo.get(e.horseId);
        if (info) {
          e.sire = info.sire;
          e.damSire = info.damSire;
        }
      }
      // 未来の情報を混ぜない：騎手・厩舎・枠順の成績は「その日より前」の集計だけを使う
      // （REAL_STATS の値は全期間の集計なので、学習では使わない）
      const stats = { ...BASE_STATS, jockeyRates: jr.rates, jockeyAverage: jr.average, trainerRates: tr.rates, trainerAverage: tr.average, draw: {}, ...cond };
      const careerOf = (entry) => careerBefore(index, entry.horseId, rec.date, stats);
      // 馬体重は発走の1時間ほど前に発表される。それより前の時点の予想にも対応できるよう、
      // 一部のレース（3割）では馬体重を隠して特徴量を作る（全頭まとめて隠す：実際にそうなるため）
      const hideBw = hash(rec.id) % 10 < 3;
      const cardX = hideBw ? { ...card, entries: card.entries.map((e) => ({ ...e, bodyWeight: null, bodyWeightDiff: null })) } : card;
      // 別の投票市場のオッズ（INCLUDE_EXOTIC のとき）。発売前の予想にも対応できるよう、2割のレースでは隠して特徴量を作る
      if (INCLUDE_EXOTIC) cardX.exoticOdds = hash(`${rec.id}x`) % 10 < 2 ? null : exoticDocs.get(rec.id) || null;
      // 発走前のオッズで学ぶ（DATASET_PERTURB=m10 など。実験用）：確定オッズに、記録した推移のずれを足したカードで特徴量を作る
      const cardF = PERTURB ? PERTURB(cardX, `${rec.id}|train${PERTURB_SEED}`) : cardX;
      const fx = raceFeatures(cardF, { stats, careerOf, jockeys: jr.rates, trainers: tr.rates });
      const finishOf = Object.fromEntries(rec.runners.map((r) => [r.number, r.finish]));
      // 実験用の追加列（DATASET_EXTRA=1）：馬・騎手・厩舎の履歴の集計（上の EXTRA_NAMES）
      let extra = null;
      if (EXTRA_MODE === 'exotic') {
        const doc = exoticDocs.get(rec.id) || null;
        if (REQUIRE_EXOTIC && !doc) continue;
        const qs = fx.rows.map((r) => r.marketProb);
        const qsum = qs.reduce((a, b) => a + b, 0) || 1;
        extra = exoticFeatures(doc, fx.rows.map((r) => r.number), qs.map((v) => v / qsum));
      } else if (EXTRA) {
        const dn = dayNum(rec.date);
        extra = fx.rows.map((r) => {
          const jw = windowRate(jWin, r.entry.jockey, dn, 60, jr.average.winRate, jr.average.top3Rate);
          const tw = windowRate(tWinQ, r.entry.trainer, dn, 60, tr.average.winRate, tr.average.top3Rate);
          const d = debutAcc.get(r.entry.trainer) || { s: 0, w: 0 };
          return [...horseHistory(index, r.entry.horseId, rec.date, rec, r.entry.jockey), shrink(d.w, d.s, tr.average.winRate, 10), d.s, jw.winRate, tw.winRate, residOf(jResid, r.entry.jockey), residOf(tResid, r.entry.trainer)];
        });
      }
      fx.rows.forEach((r, i) => rows.push({ raceId: rec.id, date: rec.date, number: r.number, finish: finishOf[r.number] || 0, y: finishOf[r.number] === 1 ? 1 : 0, bwHidden: hideBw ? 1 : 0, x: [...Array.from(r.x, (v) => Math.round(v * 1e4) / 1e4), ...(extra ? extra[i].map((v) => Math.round(v * 1e4) / 1e4) : [])] }));
      races++;
    }
  }
  // この日の結果を集計に足す（次の日から使われる）
  for (const rec of recs) for (const r0 of rec.runners) if (r0.finish > 0 || r0.status === '中止') {
    const r = withPedigree(r0);
    tally(jAcc, r.jockey, r);
    tally(tAcc, r.trainer, r);
    if (EXTRA) {
      pushRun(jWin, r.jockey, dayNum(rec.date), r);
      pushRun(tWinQ, r.trainer, dayNum(rec.date), r);
      // 騎手・厩舎の「市場の期待より勝ってきた」度合い
      if (r.finish > 0 && r.odds > 1) {
        const q = Math.min(0.9, 0.8 / r.odds);
        for (const [map, key] of [[jResid, r.jockey], [tResid, r.trainer]]) {
          if (!key) continue;
          const a = map.get(key) || map.set(key, { s: 0, r: 0 }).get(key);
          a.s++;
          a.r += (r.finish === 1 ? 1 : 0) - q;
        }
      }
      // 初出走（この日より前の出走がない）馬の成績を厩舎ごとに
      if (r.horseId && r.trainer && !(index.byHorse.get(r.horseId) || []).some((h) => h.date < rec.date)) {
        const a = debutAcc.get(r.trainer) || debutAcc.set(r.trainer, { s: 0, w: 0 }).get(r.trainer);
        a.s++;
        if (r.finish === 1) a.w++;
      }
    }
    if (!rec.jump && rec.surface !== '障') for (const [k, keyOf] of Object.entries(CONDITION_KEYS)) tally(cAcc[k], keyOf(rec, r), r);
  }
}
const outFile = process.env.DATASET_OUT || path.join(DATA_DIR, 'dataset.json');
await writeJson(outFile, { names: EXTRA ? [...FEATURE_NAMES, ...(EXTRA_MODE === 'exotic' ? EXOTIC_NAMES : HISTORY_NAMES)] : FEATURE_NAMES, start: START, races, rows });
log(`書き出し：${path.relative(process.cwd(), outFile)}（${races}レース・${rows.length}頭・特徴量 ${FEATURE_NAMES.length}）`);

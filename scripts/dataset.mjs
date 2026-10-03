#!/usr/bin/env node
// 機械学習用のデータセットを実データ（data/history）から作る。
//   node scripts/dataset.mjs            … data/dataset.json（2025-12-01 以降の平地レース、1行＝1頭）
// 各レースについて、そのレースより前の情報だけで特徴量を作る（過去走・通算・騎手/厩舎の成績はすべて「その日より前」）。

import path from 'node:path';
import { loadHistory, writeJson, loadHorseInfo, DATA_DIR } from '../src/collector/store.js';
import { indexHistory, preRaceCard, careerBefore } from '../src/data/history.js';
import { raceFeatures, FEATURE_NAMES } from '../src/engine/features.js';
import { REAL_STATS } from '../src/engine/realStats.js';
import { usable } from './calibrate.mjs';
import { tally, rates, CONDITION_KEYS } from '../src/data/rates.js';

const START = process.env.DATASET_START || '2025-12-01';
const EXTRA = process.env.DATASET_EXTRA === '1';
const EXTRA_NAMES = ['logqMid', 'logqMidGap', 'jWin365', 'jTop3_365', 'tWin365', 'tTop3_365'];
// 実験用：直近365日だけの騎手・厩舎成績（累積ではなく最近の調子）
const WINDOW_DAYS = 365;
const dayNum = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
const jWin = new Map(); // 騎手名 → [{ d, win, top3 }]（日付順）
const tWinQ = new Map();
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
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const all = await loadHistory();
const index = indexHistory(all);
const horseInfo = await loadHorseInfo();
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
      const fx = raceFeatures(cardX, { stats, careerOf, jockeys: jr.rates, trainers: tr.rates });
      const finishOf = Object.fromEntries(rec.runners.map((r) => [r.number, r.finish]));
      // 実験用の追加列（DATASET_EXTRA=1）：オッズの表示が 0.1 刻みで切り捨てられている分を中央値（+0.05）で補正した市場確率
      let extra = null;
      if (EXTRA) {
        const inv = fx.rows.map((r) => (r.entry.odds > 1 ? 1 / (r.entry.odds + 0.05) : 0));
        const sum = inv.reduce((a, b) => a + b, 0) || 1;
        const lq = inv.map((v) => Math.log(Math.max(v / sum, 1e-4)));
        const mx = Math.max(...lq);
        const dn = dayNum(rec.date);
        extra = fx.rows.map((r, i) => {
          const jw = windowRate(jWin, r.entry.jockey, dn, 60, jr.average.winRate, jr.average.top3Rate);
          const tw = windowRate(tWinQ, r.entry.trainer, dn, 60, tr.average.winRate, tr.average.top3Rate);
          return [lq[i], lq[i] - mx, jw.winRate, jw.top3Rate, tw.winRate, tw.top3Rate];
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
    }
    if (!rec.jump && rec.surface !== '障') for (const [k, keyOf] of Object.entries(CONDITION_KEYS)) tally(cAcc[k], keyOf(rec, r), r);
  }
}
const outFile = process.env.DATASET_OUT || path.join(DATA_DIR, 'dataset.json');
await writeJson(outFile, { names: EXTRA ? [...FEATURE_NAMES, ...EXTRA_NAMES] : FEATURE_NAMES, start: START, races, rows });
log(`書き出し：${path.relative(process.cwd(), outFile)}（${races}レース・${rows.length}頭・特徴量 ${FEATURE_NAMES.length}）`);

#!/usr/bin/env node
// 要素ごとの実績：騎手・厩舎・父（血統）・枠・脚質・間隔・クラスの上下・距離の変化・馬体重の増減・人気・乗り替わりなどで馬を分け、
// 実際の勝ち数を「単勝オッズ（市場）が見込んだ勝ち数」と比べる（実績 ÷ 見込み。1 より大きいほど市場の見込みより勝っている）。
// あわせて単勝・複勝を全部 100円ずつ買った回収率。学習期間（TEST_START より前）と検証期間に分け、年ごとの安定も見る。
//
//   node scripts/factor-analysis.mjs        … src/data/factorStats.js（画面の「データ」と、各馬の要素の実績に使う）
//
// 未来の情報は使わない：馬の間隔・前走のクラス・脚質は、そのレースより前の出走だけから作る。市場の見込みは確定オッズ
// （発走後に決まるが、ここでは「市場がどう見ていたか」の物差しとして使うだけで、買い目の検証には使わない）。

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadHistory, usable, horseInfoOnce } from './calibrate.mjs';
import { classLevel } from '../src/engine/constants.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_START = process.env.TEST_START || '2026-07-01';
const SIRE_FROM = '2024-01-01';
const all = (await loadHistory()).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.startTime).localeCompare(String(b.startTime)) || a.raceNo - b.raceNo));
const horseInfo = await horseInfoOnce();
const log = (s) => console.log(s);

const dayNum = (d) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86400000);
const distBand = (d) => (d <= 1400 ? '短距離' : d <= 1800 ? 'マイル' : d <= 2200 ? '中距離' : '長距離');
const restBand = (days) => (days == null ? '初出走' : days < 14 ? '連闘〜中1週' : days < 28 ? '中2〜3週' : days < 56 ? '中4〜7週' : days < 112 ? '2〜3か月' : days < 224 ? '4〜7か月' : '8か月以上');
const bwBand = (d) => (d == null ? null : d <= -10 ? '−10kg以下' : d <= -4 ? '−4〜−8kg' : d <= 2 ? '−2〜+2kg' : d <= 8 ? '+4〜+8kg' : '+10kg以上');
const popBand = (p) => (p <= 0 ? null : p <= 5 ? `${p}番人気` : p <= 9 ? '6〜9番人気' : '10番人気以下');
/** 脚質：前の出走（最大4走）の最初のコーナーの位置（頭数で割った値）の平均 */
const styleOf = (runs) => {
  const xs = runs.filter((r) => r.pos1 != null && r.field > 1).slice(-4).map((r) => (r.pos1 - 1) / (r.field - 1));
  if (!xs.length) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return m < 0.12 ? '逃げ' : m < 0.35 ? '先行' : m < 0.65 ? '差し' : '追込';
};
const gateBand = (num, n) => {
  if (n < 8) return null;
  const pos = (num - 1) / (n - 1);
  return pos <= 1 / 3 ? '内' : pos >= 2 / 3 ? '外' : '中';
};

// 集計：groups[要素][値] = { 期間ごと: [頭数, 勝ち, 見込み, 単勝払戻, 複勝払戻, 3着内] }
const PERIOD = (d) => (d >= TEST_START ? 'hold' : d.slice(0, 4));
const groups = {};
const add = (factor, value, period, row) => {
  if (value == null || value === '') return;
  const g = (groups[factor] ||= {});
  const v = (g[value] ||= {});
  const a = (v[period] ||= [0, 0, 0, 0, 0, 0]);
  a[0]++;
  a[1] += row.win;
  a[2] += row.q;
  a[3] += row.winPay;
  a[4] += row.placePay;
  a[5] += row.top3;
};

const lastRuns = new Map(); // horseId → [{ day, level, distance, pos1, field, jockey }]
let races = 0;
for (const rec of all) {
  const runners = rec.runners.filter((r) => r.number > 0);
  const ok = usable(rec) && runners.every((r) => !(r.finish > 0) || r.odds > 1);
  const field = runners.filter((r) => r.finish > 0 || r.status === '中止');
  const period = PERIOD(rec.date);
  if (ok) {
    races++;
    const inv = field.reduce((s, r) => s + (r.odds > 1 ? 1 / r.odds : 0), 0);
    const n = field.length;
    const level = classLevel(rec.grade);
    for (const r of field) {
      if (!(r.odds > 1)) continue;
      const hist = lastRuns.get(r.horseId) || [];
      const last = hist[hist.length - 1] || null;
      const row = {
        win: r.finish === 1 ? 1 : 0,
        top3: r.finish >= 1 && r.finish <= 3 ? 1 : 0,
        q: 1 / r.odds / inv,
        winPay: rec.payouts?.win?.[r.number] ?? 0,
        placePay: rec.payouts?.place?.[r.number] ?? 0,
      };
      add('jockey', r.jockey, period, row);
      add('trainer', r.trainer, period, row);
      // 血統（父）は 2024年から：競走馬のページを集めたのが最近も走っている馬だけなので、2022〜2023年は「血統がわかる＝その後も
      // 走り続けた（強い）馬」に偏る（血統のわかる馬の割合 2023年前半 59% → 2024年から 99.9%）
      const info = rec.date >= SIRE_FROM ? horseInfo.get(r.horseId) : null;
      if (info?.sire) add('sire', info.sire, period, row);
      if (info?.sire) add('sireSurface', `${info.sire}|${rec.surface}`, period, row);
      add('gate', gateBand(r.number, n) && `${rec.surface}|${distBand(rec.distance)}|${gateBand(r.number, n)}`, period, row);
      add('style', styleOf(hist) && `${rec.surface}|${styleOf(hist)}`, period, row);
      add('rest', restBand(last ? dayNum(rec.date) - last.day : null), period, row);
      if (last) {
        const d = level - last.level;
        add('classChange', d > 0 ? '昇級（クラスが上がる）' : d < 0 ? '降級（クラスが下がる）' : '同じクラス', period, row);
        const dd = rec.distance - last.distance;
        add('distChange', dd >= 200 ? '距離延長' : dd <= -200 ? '距離短縮' : '同じ距離', period, row);
        add('jockeyChange', last.jockey && r.jockey ? (last.jockey === r.jockey ? '同じ騎手' : '乗り替わり') : null, period, row);
      }
      add('bodyWeight', bwBand(r.bodyWeightDiff ?? null), period, row);
      add('popularity', popBand(r.popularity || 0), period, row);
      add('going', `${rec.surface}|${rec.going || '良'}|${r.popularity === 1 ? '1番人気' : 'それ以外'}`, period, row);
      add('age', r.age ? `${Math.min(r.age, 6)}歳${r.age >= 6 ? '以上' : ''}` : null, period, row);
      add('sex', r.sex || null, period, row);
    }
  }
  // この出走を馬の履歴に足す（次のレースから使う）
  for (const r of runners) {
    if (!r.horseId || !(r.finish > 0)) continue;
    const h = lastRuns.get(r.horseId) || [];
    h.push({ day: dayNum(rec.date), level: classLevel(rec.grade), distance: rec.distance, pos1: Array.isArray(r.passing) && r.passing.length ? r.passing[0] : null, field: field.length, jockey: r.jockey });
    if (h.length > 6) h.shift();
    lastRuns.set(r.horseId, h);
  }
}

// 書き出し：値ごとに 学習期間の合計・年ごと・検証期間
const years = [...new Set(Object.values(groups).flatMap((g) => Object.values(g).flatMap((v) => Object.keys(v))))].filter((k) => k !== 'hold').sort();
const MIN = { jockey: 300, trainer: 300, sire: 300, sireSurface: 200 };
const r3 = (v) => Math.round(v * 1000) / 1000;
const pack = (a) => (a ? { n: a[0], wins: a[1], exp: r3(a[2]), ae: a[2] ? r3(a[1] / a[2]) : null, winRoi: a[0] ? r3(a[3] / (a[0] * 100)) : null, placeRoi: a[0] ? r3(a[4] / (a[0] * 100)) : null, top3: a[0] ? r3(a[5] / a[0]) : null } : null);
const out = { from: all[0].date, to: all[all.length - 1].date, testStart: TEST_START, sireFrom: SIRE_FROM, races, years, factors: {} };
for (const [factor, g] of Object.entries(groups)) {
  const rows = [];
  for (const [value, per] of Object.entries(g)) {
    const train = [0, 0, 0, 0, 0, 0];
    for (const y of years) if (per[y]) for (let i = 0; i < 6; i++) train[i] += per[y][i];
    if (train[0] < (MIN[factor] || 100)) continue;
    // 実績 ÷ 見込み の確かさ：勝ち数のばらつき（見込みの勝ち数の平方根）で割った z
    const z = train[2] > 0 ? (train[1] - train[2]) / Math.sqrt(train[2]) : 0;
    const byYear = Object.fromEntries(years.filter((y) => per[y]?.[0] >= 30).map((y) => [y, per[y][2] ? r3(per[y][1] / per[y][2]) : null]));
    rows.push({ value, ...pack(train), z: Math.round(z * 100) / 100, byYear, hold: pack(per.hold) });
  }
  rows.sort((a, b) => b.n - a.n);
  out.factors[factor] = rows;
}
// 学習期間で市場の見込みと大きく違い（|z| ≥ 2.5）、検証期間でも同じ向き（30頭以上）の値
out.notable = [];
for (const [factor, rows] of Object.entries(out.factors)) {
  for (const r of rows) {
    if (Math.abs(r.z) < 2.5 || !r.hold || r.hold.n < 30 || r.hold.ae == null) continue;
    const same = (r.ae - 1) * (r.hold.ae - 1) > 0;
    const yearsSame = Object.values(r.byYear).filter((v) => v != null && (v - 1) * (r.ae - 1) > 0).length;
    out.notable.push({ factor, value: r.value, n: r.n, ae: r.ae, z: r.z, holdAe: r.hold.ae, holdN: r.hold.n, sameInHold: same, yearsSame, years: Object.keys(r.byYear).length });
  }
}
out.notable.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
// 画面用に詰める：[値, 頭数, 実績÷見込み, 単勝回収率, 複勝回収率, z, 検証期間の頭数, 検証期間の実績÷見込み, 年ごとの実績÷見込み]
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const compact = {
  from: out.from,
  to: out.to,
  testStart: out.testStart,
  sireFrom: out.sireFrom,
  races: out.races,
  years: out.years,
  cols: ['value', 'n', 'ae', 'winRoi', 'placeRoi', 'z', 'holdN', 'holdAe', 'byYear'],
  factors: Object.fromEntries(Object.entries(out.factors).map(([f, rows]) => [f, rows.map((r) => [r.value, r.n, r2(r.ae), r2(r.winRoi), r2(r.placeRoi), r2(r.z), r.hold?.n ?? 0, r2(r.hold?.ae ?? null), out.years.map((y) => r2(r.byYear[y] ?? null))])])),
  notable: out.notable.map((x) => ({ ...x, ae: r2(x.ae), holdAe: r2(x.holdAe) })),
};
const header = '// scripts/factor-analysis.mjs が実際のレース結果（JRA）から生成。手で編集しないでください。\n';
await writeFile(path.join(root, 'src/data/factorStats.js'), `${header}export const FACTOR_STATS = ${JSON.stringify(compact)};\n`);
log(`書き出しました：src/data/factorStats.js（${out.from}〜${out.to}・${races}レース。要素 ${Object.keys(out.factors).length}・目立つ値 ${out.notable.length}）`);
for (const f of ['popularity', 'rest', 'classChange', 'distChange', 'style', 'jockeyChange', 'bodyWeight', 'going']) {
  log(`\n■ ${f}（学習期間：頭数・実績÷見込み・z・単勝回収率・複勝回収率 | 検証期間：頭数・実績÷見込み）`);
  for (const r of out.factors[f] || []) log(`  ${r.value.padEnd(18)} ${String(r.n).padStart(6)} ${r.ae?.toFixed(3)} z${r.z.toFixed(1).padStart(5)} 単${(r.winRoi * 100).toFixed(0)}% 複${(r.placeRoi * 100).toFixed(0)}% | ${r.hold ? `${r.hold.n} ${r.hold.ae?.toFixed(3)}` : '—'}`);
}
log('\n■ 目立つ値（学習期間で |z| ≥ 2.5）');
for (const x of out.notable.slice(0, 40)) log(`  ${x.factor} ${x.value}：${x.n}頭 実績÷見込み ${x.ae} z${x.z}・年ごとに同じ向き ${x.yearsSame}/${x.years}・検証 ${x.holdN}頭 ${x.holdAe}${x.sameInHold ? '（同じ向き）' : '（逆）'}`);

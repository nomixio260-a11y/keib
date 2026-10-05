#!/usr/bin/env node
// レースごとの期待回収率 R̂（src/engine/bets.js の expectedReturn）の係数を当てはめ、自動の買い方（AUTO_STAKE）を
// 発走前のオッズで確かめて、src/engine/stakeModel.js を書く。
//
//   node scripts/stake-model.mjs          … 確かめて書き出す（data/candidates の候補が必要：node scripts/candidates.mjs）
//   node scripts/stake-model.mjs --dry    … 表示だけ
//
// R̂：1点に賭けた金額に対して実際に戻る金額の見込み。そのレースの条件（AI の期待値・単勝オッズから見た市場の期待値・オッズ・頭数）
// から、学習期間に発走前のオッズで選んだ同じような買い目（単勝・複勝）の実際の払戻との関係を、準ポアソン回帰（券種ごと）で当てはめる。
// 確かめ方（前進検証）：2024年4月からの四半期ごとに、その四半期より前の候補だけで当てはめた R̂ で、その四半期の買い目を決める。
// 検証期間（TEST_START 以降）は、TEST_START より前の候補すべてで当てはめた係数（= 書き出す係数）。発走10分前・5分前の
// オッズの推定（乱数3通りずつ）の6通りをまとめて当てはめ、6通りそれぞれで精算して平均する。1R 1,000円・1日の予算は発走順に先着。

import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../src/collector/store.js';
import { AUTO_STAKE, MIN_ODDS, expectedPayout, stakeFeatures, pickAuto, expectedReturn } from '../src/engine/bets.js';
import { fitPoissonGlm } from './lib/glm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAND_DIR = process.env.CAND_DIR || path.join(DATA_DIR, 'candidates');
const SETS = (process.env.STAKE_SETS || 'm10s1,m10s2,m10s3,m5s1,m5s2,m5s3').split(',');
const TEST_START = process.env.TEST_START || '2026-07-01';
const WALK_FROM = process.env.STAKE_WALK_FROM || '2024-04-01';
const LAMBDA = Number(process.env.STAKE_LAMBDA || 10);
const B = 1000;
const DAY_MULT = AUTO_STAKE.dayBudget.mult;
const FIT_TYPES = ['win', 'place'];
const REGION = { minOdds: 1.1, maxOdds: 12, minP: 0.2, minEv: 0.85 };
const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

// 候補の読み込み（単勝・複勝と、以前の規則と比べるためのワイド。当たる確率 15% 未満は使わないので読まない）
async function loadSet(name) {
  const meta = JSON.parse(await readFile(path.join(CAND_DIR, `${name}.json`), 'utf8'));
  const raw = await readFile(path.join(CAND_DIR, `${name}.bin`));
  const buf = new Float64Array(raw.buffer, raw.byteOffset, raw.byteLength / 8);
  const K = meta.fields.length;
  const col = Object.fromEntries(meta.fields.map((f, j) => [f, j]));
  const byRace = new Map();
  for (let i = 0; i < meta.n; i++) {
    const at = (f) => buf[i * K + col[f]];
    const type = meta.types[at('type')];
    if (at('est') || !['win', 'place', 'wide'].includes(type) || at('pAi') < 0.15) continue;
    const ri = at('race');
    const t = { type, p: at('pAi'), pHit: at('pAi'), pMarket: at('pMkt'), odds: at('odds'), oddsMax: at('oddsMax') || null, estimated: false, n: at('n'), payout: at('payout') };
    (byRace.get(ri) || byRace.set(ri, []).get(ri)).push(t);
  }
  return { name, races: meta.races, byRace, minutes: meta.minutes, drift: meta.drift };
}
const sets = [];
for (const name of SETS) sets.push(await loadSet(name));
log(`候補 ${SETS.join('・')}（${sets[0].races.length}レース、ずれの標本 ${JSON.stringify(sets[0].drift)}）`);

// 当てはめ用の行（単勝・複勝、当てはめる範囲の中だけ）
const fitRows = { win: [], place: [] };
for (const st of sets)
  for (const [ri, cs] of st.byRace) {
    const date = st.races[ri].date;
    if (date >= TEST_START) continue;
    for (const t of cs) {
      if (!FIT_TYPES.includes(t.type)) continue;
      const x = stakeFeatures(t, t.n, REGION);
      if (x) fitRows[t.type].push({ date, x, y: t.payout / 100 });
    }
  }
const fit = (before) => Object.fromEntries(FIT_TYPES.map((ty) => {
  const rs = fitRows[ty].filter((r) => r.date < before);
  return [ty, rs.length >= 500 ? fitPoissonGlm(rs.map((r) => r.x), rs.map((r) => r.y), { lambda: LAMBDA }) : null];
}));
// 区間：四半期ごと（WALK_FROM〜TEST_START）と検証期間
const quarters = [];
for (let d = new Date(`${WALK_FROM}T00:00:00Z`); d.toISOString().slice(0, 10) < TEST_START; d.setUTCMonth(d.getUTCMonth() + 3)) {
  const e = new Date(d);
  e.setUTCMonth(e.getUTCMonth() + 3);
  quarters.push({ start: d.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10) < TEST_START ? e.toISOString().slice(0, 10) : TEST_START });
}
for (const q of quarters) q.coef = fit(q.start);
const finalCoef = fit(TEST_START);
quarters.push({ start: TEST_START, end: '9999-12-31', coef: finalCoef });
log(`当てはめ：単勝 ${fitRows.win.length}・複勝 ${fitRows.place.length}行（6通りの合計）、前進検証 ${quarters.length - 1}区間`);
const coefFor = (date) => quarters.find((q) => date >= q.start && date < q.end)?.coef || null;

// 規則：いま（AUTO_STAKE）・強い買い目だけ・以前の規則（2026-10-05 22:30 の2段目・3段目つき）
const unit = 100;
function scored(cs, date) {
  const coef = coefFor(date);
  return cs.map((t) => {
    const m = expectedPayout(t);
    const ev = t.p * m;
    return { ...t, m, ev, kelly: m > 1 ? (ev - 1) / (m - 1) : 0, r: coef?.[t.type] ? expectedReturn(t, t.n, coef[t.type], REGION) : null };
  });
}
const planNew = (A) => (cs, date) => pickAuto(scored(cs.filter((t) => A.types.includes(t.type) && t.odds >= A.minOdds), date), B, A).picked;
function planOld(cs, date) {
  const main = [];
  const t3 = [];
  for (const t of scored(cs, date)) {
    if (!(t.odds >= 1.05) || t.kelly <= 0) continue;
    if (t.type !== 'wide' && t.p >= (t.odds >= MIN_ODDS ? 0.55 : 0.8) && t.ev >= 1.2) {
      main.push({ ...t, want: Math.min(1, t.kelly / 0.03), tier: 1 });
      continue;
    }
    if (t.type !== 'wide' && t.odds >= MIN_ODDS && t.p >= 0.5 && t.ev >= 1.1) {
      main.push({ ...t, want: 0.3, tier: 2 });
      continue;
    }
    if (t.type === 'wide' && t.odds >= MIN_ODDS && t.p >= 0.3) t3.push({ ...t, want: 0.2, tier: 3 });
  }
  if (!main.length && t3.length) main.push(t3.sort((a, b) => b.ev - a.ev)[0]);
  main.sort((a, b) => a.tier - b.tier || b.want - a.want || b.p - a.p);
  const x = main[0];
  if (!x) return [];
  const stake = Math.floor((B * x.want) / unit) * unit;
  return stake >= unit && stake * (x.odds - 1) >= 100 ? [{ ...x, stake }] : [];
}
const RULES = {
  new: { label: 'いまの自動（レースごとの調整）', plan: planNew(AUTO_STAKE) },
  strong: { label: '強い買い目だけ', plan: planNew({ ...AUTO_STAKE, adjust: [] }) },
  old: { label: '以前の自動（2段目・3段目）', plan: planOld },
};
const PERIODS = [
  { key: 'y24', label: `2024年（${WALK_FROM.slice(5, 7).replace(/^0/, '')}〜12月）`, from: WALK_FROM, to: '2025-01-01' },
  { key: 'y25', label: `2025年〜${TEST_START.slice(0, 4)}年${Number(TEST_START.slice(5, 7)) - 1}月`, from: '2025-01-01', to: TEST_START },
  { key: 'hold', label: '検証期間', from: TEST_START, to: '9999-12-31' },
];
const qOf = (d) => `${d.slice(0, 4)}Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
function simulate(st, plan, collect = null) {
  const byDay = new Map();
  for (const ri of st.byRace.keys()) {
    const r = st.races[ri];
    if (r.date < WALK_FROM) continue;
    (byDay.get(r.date) || byDay.set(r.date, []).get(r.date)).push(ri);
  }
  const per = Object.fromEntries(PERIODS.map((p) => [p.key, { races: 0, hits: 0, stake: 0, pay: 0, days: new Map(), allDays: 0 }]));
  const byQ = {};
  for (const [date, ris] of byDay) {
    const P = PERIODS.find((p) => date >= p.from && date < p.to);
    if (!P) continue;
    const a = per[P.key];
    a.allDays++;
    ris.sort((x, y) => {
      const ra = st.races[x];
      const rb = st.races[y];
      return Number(ra.id.slice(-2)) - Number(rb.id.slice(-2)) || (ra.id < rb.id ? -1 : 1);
    });
    let left = DAY_MULT * B;
    for (const ri of ris) {
      let s = 0;
      let g = 0;
      for (const t of plan(st.byRace.get(ri), date)) {
        const stake = Math.min(t.stake, Math.floor(left / unit) * unit);
        if (stake < unit || stake * (t.odds - 1) < 100) continue;
        left -= stake;
        s += stake;
        g += (stake / 100) * t.payout;
        if (collect && P.key !== 'hold') collect.push({ level: t.auto || `tier${t.tier}`, type: t.type, p: t.p, m: t.m, r: t.r, stake, pay: t.payout / 100 });
      }
      if (!s) continue;
      a.races++;
      if (g > 0) a.hits++;
      a.stake += s;
      a.pay += g;
      a.days.set(date, (a.days.get(date) || 0) + g - s);
      const q = (byQ[qOf(date)] ||= { races: 0, stake: 0, pay: 0 });
      q.races++;
      q.stake += s;
      q.pay += g;
    }
  }
  for (const a of Object.values(per)) {
    const dv = [...a.days.values()];
    Object.assign(a, { profit: a.pay - a.stake, roi: a.stake ? a.pay / a.stake : null, hitRate: a.races ? a.hits / a.races : null, betDays: dv.length, loseDays: dv.filter((v) => v < 0).length, worst: dv.length ? Math.min(...dv) : 0 });
    delete a.days;
  }
  return { per, byQ };
}
const results = {};
const bets = { new: [], old: [] };
for (const [key, R] of Object.entries(RULES)) results[key] = sets.map((st) => simulate(st, R.plan, bets[key] || null));
// 負けの原因：学習期間（前進検証）の買い目を種類ごとに、当たる確率と当たったときの払戻の「見込み → 実際」
const LEVEL_LABEL = { tier1: '1段目（強い買い目）', tier2: '2段目（当たる確率 50% 以上・期待値 1.1 以上を予算の3割）', tier3: '3段目（ワイドを予算の2割）', strong: '強い買い目', adjust: 'レースごとの調整' };
const causes = {};
for (const [key, list] of Object.entries(bets)) {
  const groups = new Map();
  for (const b of list) {
    const k = b.level;
    const a = groups.get(k) || groups.set(k, { n: 0, p: 0, hit: 0, m: 0, pay: 0, r: 0, rn: 0, stake: 0, ret: 0 }).get(k);
    a.n++;
    a.p += b.p;
    a.stake += b.stake;
    a.ret += b.stake * b.pay;
    if (b.r != null) {
      a.r += b.r;
      a.rn++;
    }
    if (b.pay > 0) {
      a.hit++;
      a.m += b.m;
      a.pay += b.pay;
    }
  }
  causes[key] = [...groups.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : 1))
    .map(([k, a]) => ({ level: k, label: LEVEL_LABEL[k] || k, bets: Math.round(a.n / sets.length), pExp: +(a.p / a.n).toFixed(4), pAct: +(a.hit / a.n).toFixed(4), payExp: +(a.m / Math.max(1, a.hit)).toFixed(3), payAct: +(a.pay / Math.max(1, a.hit)).toFixed(3), rExp: a.rn ? +(a.r / a.rn).toFixed(4) : null, roi: +(a.ret / Math.max(1, a.stake)).toFixed(4) }));
}
const avg = (rs, f) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
const summary = {};
for (const [key, rs] of Object.entries(results)) {
  summary[key] = {};
  for (const P of PERIODS) {
    const xs = rs.map((r) => r.per[P.key]);
    const stake = avg(xs, (x) => x.stake);
    const pay = avg(xs, (x) => x.pay);
    summary[key][P.key] = {
      races: Math.round(avg(xs, (x) => x.races)),
      hitRate: +(avg(xs, (x) => x.hits) / Math.max(1, avg(xs, (x) => x.races))).toFixed(4),
      roi: +(pay / Math.max(1, stake)).toFixed(4),
      roiMin: +Math.min(...xs.map((x) => x.roi ?? 0)).toFixed(4),
      profit: Math.round(pay - stake),
      loseDays: +avg(xs, (x) => x.loseDays).toFixed(1),
      betDays: +avg(xs, (x) => x.betDays).toFixed(1),
      days: xs[0].allDays,
    };
  }
}
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const yen = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString('ja-JP')}円`;
console.log(`\n発走前のオッズで選んだ場合（6通りの平均・1R ${B.toLocaleString('ja-JP')}円・1日の予算 ${DAY_MULT}倍）。回収率の（）は6通りでいちばん低いもの`);
for (const P of PERIODS) {
  console.log(`■ ${P.label}（${summary.new[P.key].days}日）`);
  for (const [key, R] of Object.entries(RULES)) {
    const s = summary[key][P.key];
    console.log(`  ${R.label.padEnd(18, '　')} ${String(s.races).padStart(5)}レース 的中率 ${pct(s.hitRate)} 回収率 ${pct(s.roi)}（${pct(s.roiMin)}） 収支 ${yen(s.profit)} 負けた日 ${s.loseDays}/${s.betDays}`);
  }
}
console.log('\n四半期ごとの収支（6通りの平均）');
const qs = [...new Set(results.new.flatMap((r) => Object.keys(r.byQ)))].sort();
for (const [key, R] of Object.entries(RULES)) {
  const line = qs.map((q) => {
    const xs = results[key].map((r) => r.byQ[q] || { races: 0, stake: 0, pay: 0 });
    return `${q.slice(2)} ${Math.round(avg(xs, (x) => x.races))}R ${((avg(xs, (x) => x.pay) - avg(xs, (x) => x.stake)) / 1000).toFixed(1)}k`;
  });
  console.log(`  ${R.label.padEnd(18, '　')} ${line.join(' | ')}`);
}
console.log('\n負けの原因（2024年4月〜検証の前・前進検証の買い目。当たる確率と当たったときの払戻の「見込み → 実際」）');
for (const [key, rows] of Object.entries(causes)) for (const c of rows) console.log(`  ${RULES[key].label}｜${c.label.padEnd(16, '　')} ${String(c.bets).padStart(5)}点 当たる確率 ${pct(c.pExp)} → ${pct(c.pAct)}・払戻 ${c.payExp.toFixed(2)} → ${c.payAct.toFixed(2)}倍（${pct(c.payAct / c.payExp)}）${c.rExp != null ? `・R̂ ${pct(c.rExp)}` : ''}・回収率 ${pct(c.roi)}`);
console.log('\n書き出す係数（検証期間の前まですべて）：[定数, log 期待値, log 市場の期待値, log オッズ, log 頭数]');
for (const ty of FIT_TYPES) console.log(`  ${ty}: ${finalCoef[ty]?.map((v) => v.toFixed(4)).join(', ')}`);

if (!process.argv.includes('--dry')) {
  const model = {
    fitted: new Date().toISOString().slice(0, 10),
    trainTo: TEST_START,
    sets: SETS,
    drift: sets[0].drift,
    rows: { win: fitRows.win.filter((r) => r.date < TEST_START).length, place: fitRows.place.filter((r) => r.date < TEST_START).length },
    features: ['定数', 'log(期待値)', 'log(市場の確率 × 払戻の見込み)', 'log(オッズ)', 'log(頭数)'],
    region: REGION,
    lambda: LAMBDA,
    coef: Object.fromEntries(FIT_TYPES.map((ty) => [ty, finalCoef[ty]?.map((v) => +v.toFixed(5)) || null])),
    check: { budget: B, dayMult: DAY_MULT, periods: PERIODS.map(({ key, label }) => ({ key, label })), labels: Object.fromEntries(Object.entries(RULES).map(([k, R]) => [k, R.label])), summary, causes },
  };
  const header = '// scripts/stake-model.mjs が書き出す（レースごとの期待回収率 R̂ の係数と、発走前のオッズでの確かめ）。手で編集しないでください。\n';
  await writeFile(path.join(root, 'src/engine/stakeModel.js'), `${header}export const STAKE_MODEL = ${JSON.stringify(model)};\n`);
  console.log('\n書き出しました：src/engine/stakeModel.js');
}

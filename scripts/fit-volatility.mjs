#!/usr/bin/env node
// 荒れ度の自動調整：
//   1) 要素の分析表：レースの条件（頭数・1番人気の単勝・クラス・芝ダ・馬場・ハンデ・初出走の馬・距離）ごとに、
//      人気3頭以外が勝った割合を、学習期間（TEST_START より前）の全レースで集計
//   2) 区切り：分割外の予測（本番と同じ設定のモデルを学習期間の5分割で学習）の「人気3頭以外が勝つ確率」の3分位 → 堅い／普通／荒れ
//   3) 買い方：堅い／普通／荒れ のそれぞれで、◎を軸にした買い方（単勝・複勝・単複・馬連・ワイド・三連複）の回収率を
//      分割外の予測と実際の払戻で比べ、区分ごとに最も良いものを選ぶ。検証期間（本番モデル）で一度だけ確認する
//   4) src/engine/volatilityModel.js に書き出す（--dry なら書かない）
//
//   node scripts/fit-volatility.mjs [--dry]   環境変数：TEST_START、FOLDS=5、ROUNDS（既定は本番の本数 ÷ 1.2）、VOL_OOF_CACHE

import path from 'node:path';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { readJson, writeJson, loadHistory, DATA_DIR, ROOT } from '../src/collector/store.js';
import { DEFAULT_PARAMS, groupRaces, flatten, makeThresholds, binize, trainBoost, evalTrees, dateFolds } from './lib/boost.mjs';
import { GBDT_MODEL } from '../src/engine/gbdtModel.js';
import { treeSum, baseOf } from '../src/engine/gbdt.js';
import { exactPL } from '../src/engine/simulate.js';
import { FEATURE_NAMES } from '../src/engine/features.js';
import { placeCountOf } from '../src/engine/model.js';
import { payoutOf } from '../src/engine/backtest.js';
import { ELEMENTS, classifyRace, POLICY_FORMS } from '../src/engine/volatility.js';
import { usable } from './calibrate.mjs';

const TEST_START = process.env.TEST_START || '2026-07-01';
const FOLDS = Number(process.env.FOLDS || 5);
const P = GBDT_MODEL.params;
const ROUNDS = Number(process.env.ROUNDS || Math.round((P.rounds || 1000) / 1.2));
const DRY = process.argv.includes('--dry');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const pc = (v) => `${(v * 100).toFixed(1)}%`;
const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);

// ---- 1) 要素の分析表（学習期間の全レース）----
const records = await loadHistory();
const recById = new Map(records.map((r) => [r.id, r]));
const firstRun = new Map(); // 馬ID → 最初の出走日
for (const r of records) for (const x of r.runners) if (x.horseId && (!firstRun.has(x.horseId) || r.date < firstRun.get(x.horseId))) firstRun.set(x.horseId, r.date);
const isOut = (x) => x.finish === 0 && /取消|除外/.test(x.status || '');
function elementInputOfRecord(rec) {
  const rs = rec.runners.filter((x) => !isOut(x));
  const odds = rs.map((x) => x.odds).filter((v) => v > 1);
  return {
    n: rs.length,
    favOdds: odds.length ? Math.min(...odds) : null,
    grade: rec.grade,
    surface: rec.surface,
    going: rec.going,
    weightRule: rec.weightRule,
    newcomerShare: rs.length ? rs.filter((x) => x.horseId && firstRun.get(x.horseId) === rec.date).length / rs.length : null,
    distance: rec.distance,
  };
}
function upsetOfRecord(rec) {
  const rs = rec.runners.filter((x) => !isOut(x) && x.odds > 1);
  const top3 = [...rs].sort((a, b) => a.odds - b.odds || a.number - b.number).slice(0, 3).map((x) => x.number);
  const w = rec.runners.find((x) => x.finish === 1);
  return w ? (top3.includes(w.number) ? 0 : 1) : null;
}
const statRecs = records.filter((r) => r.date < TEST_START && usable(r) && !r.jump && r.surface !== '障');
const elements = Object.fromEntries(ELEMENTS.map((el) => [el.key, {}]));
let overallN = 0;
let overallU = 0;
for (const rec of statRecs) {
  const u = upsetOfRecord(rec);
  if (u == null) continue;
  overallN++;
  overallU += u;
  const cls = classifyRace(elementInputOfRecord(rec));
  for (const [k, v] of Object.entries(cls)) {
    if (!v) continue;
    const s = elements[k][v] || (elements[k][v] = { n: 0, u: 0 });
    s.n++;
    s.u += u;
  }
}
const overall = overallU / overallN;
for (const k of Object.keys(elements)) for (const v of Object.keys(elements[k])) elements[k][v] = { n: elements[k][v].n, rate: +(elements[k][v].u / elements[k][v].n).toFixed(4) };
log(`要素の分析表：学習期間 ${overallN}レース、人気3頭以外が勝った割合 ${pc(overall)}`);
for (const el of ELEMENTS) console.log(`  ${el.label}：${Object.entries(elements[el.key]).map(([v, s]) => `${v} ${pc(s.rate)}（${s.n}）`).join('・')}`);

// ---- 2) 分割外の予測 ----
const ds = await readJson(process.env.DATASET_FILE || path.join(DATA_DIR, 'dataset.json'));
if (!ds || ds.names.length !== FEATURE_NAMES.length) throw new Error('data/dataset.json の列が FEATURE_NAMES と一致しません');
const Fn = ds.names.length;
const iLogq = ds.names.indexOf('logq');
const temps = GBDT_MODEL.temps || [1, 1, 1];
const racesAll = groupRaces(ds.rows).filter((rs) => rs.length >= 2 && rs.some((r) => r.y) && recById.has(rs[0].raceId));
const trainRaces = racesAll.filter((rs) => rs[0].date < TEST_START);
const testRaces = racesAll.filter((rs) => rs[0].date >= TEST_START);

/** レースと各馬のスコアから、荒れ度と印（勝率の高い順の行番号） */
function raceRec(rs, scores) {
  const ex = exactPL(scores, { temps });
  const n = rs.length;
  const q = rs.map((r) => Math.exp(r.x[iLogq]));
  const qs = q.reduce((a, b) => a + b, 0);
  const byQ = [...q.keys()].sort((a, b) => q[b] - q[a] || rs[a].number - rs[b].number);
  const upsetProb = n >= 4 ? 1 - byQ.slice(0, 3).reduce((s, i) => s + ex.win[i], 0) : 0;
  const marks = [...ex.win.keys()].sort((a, b) => ex.win[b] - ex.win[a]);
  return { id: rs[0].raceId, date: rs[0].date, n, numbers: rs.map((r) => r.number), marks: marks.slice(0, 5), upsetProb, pTop: ex.win[marks[0]], qTop: q[marks[0]] / qs };
}
let oof;
const cache = process.env.VOL_OOF_CACHE;
if (cache && existsSync(cache)) {
  oof = await readJson(cache);
  log(`分割外の記録を読みました：${cache}（${oof.length}レース）`);
} else {
  const feats = (P.only?.length ? P.only : ds.names).map((k) => ds.names.indexOf(k)).filter((i) => i >= 0);
  const params = { ...DEFAULT_PARAMS, depth: P.depth, lr: P.lr, lambda: P.lambda, colsample: P.colsample, subsample: P.subsample, rounds: ROUNDS, patience: 0 };
  const folds = dateFolds(trainRaces, FOLDS);
  oof = [];
  for (let k = 0; k < FOLDS; k++) {
    const t0 = Date.now();
    const fit = flatten(folds.filter((_, j) => j !== k).flat(), Fn, { baseIndex: iLogq });
    const thresholds = makeThresholds(fit);
    binize(fit, thresholds);
    const valid = binize(flatten(folds[k], Fn, { baseIndex: iLogq }), thresholds);
    const r = trainBoost({ fit, valids: [], thresholds, feats, params, seed: 1000 + k });
    const ev = evalTrees(r.trees, valid);
    for (let ri = 0; ri < valid.races.length; ri++) oof.push(raceRec(valid.races[ri], Array.from(ev.m.subarray(valid.start[ri], valid.start[ri + 1]))));
    log(`分割 ${k + 1}/${FOLDS}：${folds[k].length}レース（${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
  }
  oof.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (cache) await writeJson(cache, oof);
}
const test = testRaces.map((rs) => raceRec(rs, rs.map((r) => baseOf(r.x[iLogq]) + treeSum(r.x))));

// ---- 3) 区切り（分割外の3分位）----
const ups = oof.map((r) => r.upsetProb).sort((a, b) => a - b);
const cuts = [ups[Math.floor(ups.length / 3)], ups[Math.floor((2 * ups.length) / 3)]].map((v) => Math.round(v * 100) / 100);
const LABELS = ['堅い', '普通', '荒れ'];
const volOf = (r) => (r.upsetProb < cuts[0] ? 0 : r.upsetProb < cuts[1] ? 1 : 2);
log(`荒れ度の区切り（分割外の3分位）：堅い ${pc(cuts[0])} 未満・普通 ${pc(cuts[1])} 未満・荒れ それ以上`);

// ---- 4) 買い方の回収率（実際の払戻）----
function settle(r, form) {
  const rec = recById.get(r.id);
  const tickets = POLICY_FORMS[form].build(r.marks, placeCountOf(r.n), r.n);
  let stake = 0;
  let ret = 0;
  for (const t of tickets) {
    stake += 100;
    ret += payoutOf({ payouts: rec.payouts }, t.type, t.idx.map((i) => r.numbers[i]));
  }
  return { stake, ret };
}
function table(recs) {
  const out = {};
  for (let c = 0; c < 3; c++) {
    out[LABELS[c]] = {};
    const rs = recs.filter((r) => volOf(r) === c);
    for (const form of Object.keys(POLICY_FORMS)) {
      let stake = 0;
      let ret = 0;
      let races = 0;
      for (const r of rs) {
        const s = settle(r, form);
        if (!s.stake) continue;
        races++;
        stake += s.stake;
        ret += s.ret;
      }
      out[LABELS[c]][form] = { races, stake, ret, roi: stake ? ret / stake : 0 };
    }
  }
  return out;
}
const tOof = table(oof);
const tTest = table(test);
const policy = {};
for (const lab of LABELS) {
  const best = Object.entries(tOof[lab]).filter(([, v]) => v.races >= 300).sort((a, b) => b[1].roi - a[1].roi)[0];
  policy[lab] = best[0];
}
console.log('\n荒れ度 | 買い方 | 分割外（学習期間）：レース・回収率 | 検証期間：レース・回収率');
for (const lab of LABELS)
  for (const form of Object.keys(POLICY_FORMS))
    console.log(`${lab} | ${POLICY_FORMS[form].label}${policy[lab] === form ? '（採用）' : ''} | ${tOof[lab][form].races}R ${pc(tOof[lab][form].roi)} | ${tTest[lab][form].races}R ${pc(tTest[lab][form].roi)}`);
const sumPolicy = (t) => {
  let stake = 0;
  let ret = 0;
  for (const lab of LABELS) {
    stake += t[lab][policy[lab]].stake;
    ret += t[lab][policy[lab]].ret;
  }
  return { stake, ret, roi: ret / stake };
};
const uniform = (t, form) => {
  let stake = 0;
  let ret = 0;
  for (const lab of LABELS) {
    stake += t[lab][form].stake;
    ret += t[lab][form].ret;
  }
  return { stake, ret, roi: stake ? ret / stake : 0 };
};
console.log(`\n自動調整（${LABELS.map((l) => `${l}→${POLICY_FORMS[policy[l]].label}`).join('、')}）：分割外 ${pc(sumPolicy(tOof).roi)}・検証 ${pc(sumPolicy(tTest).roi)}`);
for (const form of Object.keys(POLICY_FORMS)) console.log(`  すべて ${POLICY_FORMS[form].label}：分割外 ${pc(uniform(tOof, form).roi)}・検証 ${pc(uniform(tTest, form).roi)}`);
// 区分ごとの、予測した荒れ度と実際
for (const [label, recs] of [['分割外', oof], ['検証', test]]) {
  const parts = LABELS.map((lab, c) => {
    const rs = recs.filter((r) => volOf(r) === c);
    const act = mean(rs.map((r) => upsetOfRecord(recById.get(r.id)) ?? 0));
    return `${lab} ${rs.length}R 予測 ${pc(mean(rs.map((r) => r.upsetProb)))} → 実際 ${pc(act)}`;
  });
  console.log(`${label}：${parts.join('、')}`);
}

if (!DRY) {
  const model = {
    version: 1,
    cuts,
    overall: +overall.toFixed(4),
    elements,
    policy,
    statsFrom: statRecs[0]?.date,
    statsTo: statRecs.at(-1)?.date,
    statsRaces: overallN,
    oof: { races: oof.length, from: oof[0].date, to: oof.at(-1).date, policyRoi: +sumPolicy(tOof).roi.toFixed(4), table: tOof },
    test: { from: TEST_START, races: test.length, policyRoi: +sumPolicy(tTest).roi.toFixed(4), table: tTest },
  };
  const file = path.join(ROOT, 'src/engine/volatilityModel.js');
  await writeFile(file, `// scripts/fit-volatility.mjs が過去のレースから作る。手で編集しないでください。\nexport const VOLATILITY_MODEL = ${JSON.stringify(model)};\n`);
  log(`書き出しました：${path.relative(ROOT, file)}`);
}

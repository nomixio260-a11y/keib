#!/usr/bin/env node
// 自信度の校正：◎（勝率が最も高い馬）が勝つ確率・複勝圏に来る確率を、学習期間の分割外の予測で校正し、S/A/B/C の区切りをデータで決める。
//   1) 学習期間を日付で5分割し、本番と同じ設定（src/engine/gbdtModel.js の params）で分割外のスコアを作る（OOF_CACHE があれば読む）
//   2) レースごとに PL の厳密計算で ◎ の勝率・複勝圏の確率と、校正の入力（src/engine/confidence.js の confidenceInputs）
//   3) 候補（そのまま／Platt／市場との一致などを足したロジスティック）を交差検証で比べ、良いものを選ぶ（複雑な方は 0.0005 以上良いときだけ）
//   4) 区切り：◎ の勝つ確率で S/A/B/C（既定 42%・30%・20%。CUTS で変更）。従来の決め方・分位の区切りとも比べて表示する
//   5) 検証期間（本番モデルのスコア）で、従来の自信度と新しい自信度の当てはまり・分離を比べる
//   6) src/engine/confidenceModel.js に書き出す（--dry なら書かない）
//
//   node scripts/fit-confidence.mjs [--dry]   環境変数：TEST_START、FOLDS=5、ROUNDS（既定は本番の本数 ÷ 1.2）、CUTS=0.42,0.30,0.20、GRADE_SHARES（比較用の分位）、OOF_CACHE

import path from 'node:path';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { readJson, writeJson, DATA_DIR, ROOT } from '../src/collector/store.js';
import { DEFAULT_PARAMS, groupRaces, flatten, makeThresholds, binize, trainBoost, evalTrees, dateFolds } from './lib/boost.mjs';
import { GBDT_MODEL } from '../src/engine/gbdtModel.js';
import { treeSum, baseOf } from '../src/engine/gbdt.js';
import { exactPL } from '../src/engine/simulate.js';
import { FEATURE_NAMES } from '../src/engine/features.js';
import { placeCountOf } from '../src/engine/model.js';
import { confidenceInputs, applyCalib, legacyGrade, gradeOf } from '../src/engine/confidence.js';

const TEST_START = process.env.TEST_START || '2026-07-01';
const FOLDS = Number(process.env.FOLDS || 5);
const P = GBDT_MODEL.params;
const ROUNDS = Number(process.env.ROUNDS || Math.round((P.rounds || 1000) / 1.2));
const SHARES = (process.env.GRADE_SHARES || '0.2,0.3,0.3,0.2').split(',').map(Number);
const DRY = process.argv.includes('--dry');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const temps = GBDT_MODEL.temps || [1, 1, 1];

const ds = await readJson(process.env.DATASET_FILE || path.join(DATA_DIR, 'dataset.json'));
if (!ds || ds.names.length !== FEATURE_NAMES.length || ds.names.some((k, i) => k !== FEATURE_NAMES[i])) throw new Error('data/dataset.json の列が FEATURE_NAMES と一致しません。先に npm run dataset');
const Fn = ds.names.length;
const iLogq = ds.names.indexOf('logq');
const racesAll = groupRaces(ds.rows).filter((rs) => rs.length >= 2 && rs.some((r) => r.y));
const trainRaces = racesAll.filter((rs) => rs[0].date < TEST_START);
const testRaces = racesAll.filter((rs) => rs[0].date >= TEST_START);

/** レース（データセットの行）とスコアから、自信度の記録 */
function record(rs, scores) {
  const ex = exactPL(scores, { temps });
  const rows = rs.map((r, i) => ({ pWin: ex.win[i], pTop2: ex.top2[i], pTop3: ex.top3[i], marketProb: Math.exp(r.x[iLogq]), entry: { number: r.number }, features: r.x, finish: r.finish }));
  const placeCount = placeCountOf(rows.length);
  const { honmei: h, x, pWin, pPlace } = confidenceInputs(rows, placeCount);
  const second = [...rows].sort((a, b) => b.pWin - a.pWin)[1]?.pWin ?? 0;
  return { id: rs[0].raceId, date: rs[0].date, x, pWin, pPlace, placeCount, yWin: h.finish === 1 ? 1 : 0, yPlace: placeCount && h.finish > 0 && h.finish <= placeCount ? 1 : 0, legacy: legacyGrade(pWin, second) };
}

// ---- 1) 分割外のスコア ----
let oof;
const cache = process.env.OOF_CACHE;
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
    for (let ri = 0; ri < valid.races.length; ri++) oof.push(record(valid.races[ri], Array.from(ev.m.subarray(valid.start[ri], valid.start[ri + 1]))));
    log(`分割 ${k + 1}/${FOLDS}：${folds[k].length}レース（特徴量 ${feats.length}・木 ${ROUNDS}本、${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
  }
  oof.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (cache) await writeJson(cache, oof);
}
const test = testRaces.map((rs) => record(rs, rs.map((r) => baseOf(r.x[iLogq]) + treeSum(r.x))));
log(`分割外 ${oof.length}レース（${oof[0].date}〜${oof[oof.length - 1].date}）・検証 ${test.length}レース。◎の勝率 分割外 ${pc(mean(oof.map((r) => r.yWin)))}・検証 ${pc(mean(test.map((r) => r.yWin)))}`);

// ---- 2) ロジスティック回帰（ニュートン法、L2）----
function mean(a) { return a.reduce((s, v) => s + v, 0) / (a.length || 1); }
function pc(v) { return `${(v * 100).toFixed(1)}%`; }
const clip = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const sigmoid = (u) => 1 / (1 + Math.exp(-u));
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c || !M[c][c]) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1));
}
function fitLogistic(recs, inputs, target, l2 = 1) {
  const K = inputs.length;
  const mu = inputs.map((k) => mean(recs.map((r) => r.x[k])));
  const sd = inputs.map((k, j) => Math.max(1e-6, Math.sqrt(mean(recs.map((r) => (r.x[k] - mu[j]) ** 2)))));
  const X = recs.map((r) => [1, ...inputs.map((k, j) => Math.max(-5, Math.min(5, (r.x[k] - mu[j]) / sd[j])))]);
  const y = recs.map((r) => r[target]);
  let w = new Array(K + 1).fill(0);
  for (let it = 0; it < 30; it++) {
    const g = new Array(K + 1).fill(0);
    const H = Array.from({ length: K + 1 }, () => new Array(K + 1).fill(0));
    X.forEach((xi, i) => {
      const p = sigmoid(xi.reduce((s, v, a) => s + v * w[a], 0));
      for (let a = 0; a <= K; a++) {
        g[a] += (y[i] - p) * xi[a];
        for (let b2 = 0; b2 <= K; b2++) H[a][b2] += p * (1 - p) * xi[a] * xi[b2];
      }
    });
    for (let a = 1; a <= K; a++) { g[a] -= l2 * w[a]; H[a][a] += l2; }
    const d = solve(H, g);
    w = w.map((v, a) => v + d[a]);
    if (Math.max(...d.map(Math.abs)) < 1e-9) break;
  }
  return { inputs, mu, sd, coef: w };
}
const predictor = (spec, rawKey) => (r) => applyCalib(spec, r.x, r[rawKey]);
const bll = (recs, f, target) => -mean(recs.map((r) => (r[target] ? Math.log(clip(f(r))) : Math.log(1 - clip(f(r))))));
const brier = (recs, f, target) => mean(recs.map((r) => (clip(f(r)) - r[target]) ** 2));
function auc(recs, f, target) {
  const s = recs.map((r) => ({ p: f(r), y: r[target] })).sort((a, b) => a.p - b.p);
  let rank = 0, sumPos = 0, nPos = 0;
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j < s.length && s[j].p === s[i].p) j++;
    const avg = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (s[k].y) { sumPos += avg; nPos++; }
    rank = j;
    i = j;
  }
  const nNeg = s.length - nPos;
  return nPos && nNeg ? (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : 0.5;
}

// ---- 3) 候補の交差検証（分割外の記録を日付順に5分割）----
const CANDS = {
  win: { raw: null, platt: ['lp'], plus: ['lp', 'lq', 'fav', 'gap'], full: ['lp', 'lq', 'fav', 'gap', 'logN', 'exo', 'lq2', 'even'] },
  place: { raw: null, platt: ['lp3'], plus: ['lp3', 'lp', 'lq', 'fav'], full: ['lp3', 'lp', 'lq', 'fav', 'gap', 'logN', 'exo', 'lq2', 'even'] },
};
const chosen = {};
for (const [kind, target, rawKey] of [['win', 'yWin', 'pWin'], ['place', 'yPlace', 'pPlace']]) {
  const recs = oof.filter((r) => r[rawKey] != null);
  const chunk = Math.ceil(recs.length / 5);
  const cv = {};
  for (const [name, inputs] of Object.entries(CANDS[kind])) {
    let s = 0;
    for (let k = 0; k < 5; k++) {
      const valid = recs.slice(k * chunk, (k + 1) * chunk);
      const fit = [...recs.slice(0, k * chunk), ...recs.slice((k + 1) * chunk)];
      const spec = inputs ? fitLogistic(fit, inputs, target) : { raw: true };
      s += bll(valid, predictor(spec, rawKey), target) * valid.length;
    }
    cv[name] = s / recs.length;
  }
  // より単純なものを優先：0.0005 以上良いときだけ複雑な方へ
  let pick = 'raw';
  for (const name of ['platt', 'plus', 'full']) if (cv[name] < cv[pick] - 0.0005) pick = name;
  let spec = CANDS[kind][pick] ? fitLogistic(recs, CANDS[kind][pick], target) : { raw: true };
  // 検証期間で校正前より悪くなるなら使わない（採用の基準：交差検証で良く、検証期間でマイナスでない）
  if (!spec.raw) {
    const tr = test.filter((r) => r[rawKey] != null);
    const before = bll(tr, (r) => r[rawKey], target);
    const after = bll(tr, predictor(spec, rawKey), target);
    if (after > before) {
      log(`${kind === 'win' ? '◎が勝つ' : '◎が複勝圏'}：${pick} は検証期間で悪化（${before.toFixed(4)} → ${after.toFixed(4)}）→ 校正しない`);
      pick = 'raw';
      spec = { raw: true };
    }
  }
  chosen[kind] = { pick, spec, cv };
  log(`${kind === 'win' ? '◎が勝つ' : '◎が複勝圏'}：交差検証の二値対数損失 ${Object.entries(cv).map(([k, v]) => `${k} ${v.toFixed(4)}`).join('、')} → ${pick}${spec.raw ? '' : `（係数 ${spec.inputs.map((k, j) => `${k} ${spec.coef[j + 1].toFixed(3)}`).join('、')}）`}`);
}
const fWin = predictor(chosen.win.spec, 'pWin');
const fPlace = predictor(chosen.place.spec, 'pPlace');

// ---- 4) 区切り ----
const pOof = oof.map(fWin).sort((a, b) => a - b);
const q = (u) => pOof[Math.min(pOof.length - 1, Math.max(0, Math.floor(u * pOof.length)))];
const quantCuts = [q(1 - SHARES[0]), q(1 - SHARES[0] - SHARES[1]), q(1 - SHARES[0] - SHARES[1] - SHARES[2])].map((v) => Math.round(v * 100) / 100);
// 区切りは ◎ の勝つ確率 42%・30%・20%（従来の確率の区切りから「2番手との差」の条件を外したもの。学習期間でも検証期間でも従来より当てはまりが良い。
// 分位で決めた区切りは学習期間でだけ良く、検証期間では悪かった）
const cuts = (process.env.CUTS || '0.42,0.30,0.20').split(',').map(Number);
log(`区切り（◎ の勝つ確率）：S ${pc(cuts[0])} 以上・A ${pc(cuts[1])} 以上・B ${pc(cuts[2])} 以上・C それ未満（参考：分割外の分位 ${SHARES.map((v) => `${v * 100}%`).join('/')} なら ${quantCuts.map(pc).join('・')}）`);
const GR = ['S', 'A', 'B', 'C'];
const newGrade = (r) => gradeOf(fWin(r), cuts);
function gradeTable(recs, gOf) {
  return Object.fromEntries(GR.map((g) => {
    const rs = recs.filter((r) => gOf(r) === g);
    const pl = rs.filter((r) => r.placeCount);
    return [g, { n: rs.length, win: mean(rs.map((r) => r.yWin)), place: mean(pl.map((r) => r.yPlace)), predWin: mean(rs.map(fWin)), predPlace: mean(pl.map(fPlace)) }];
  }));
}
const oofLegacy = gradeTable(oof, (r) => r.legacy);
const oofNew = gradeTable(oof, newGrade);

// ---- 5) 検証期間 ----
const report = (label, recs) => {
  const tl = gradeTable(recs, (r) => r.legacy);
  const tn = gradeTable(recs, newGrade);
  // 自信度だけで ◎ の勝ちを予測したときの当てはまり（区分ごとの率は分割外で推定）
  const llG = (tab, gOf, key, target) => bll(recs.filter((r) => target !== 'yPlace' || r.placeCount), (r) => tab[gOf(r)][key] || 0.3, target);
  console.log(`\n${label}（${recs.length}レース）`);
  console.log('自信度 | 従来：レース数・◎の勝率・複勝率 | 新：レース数・予測した勝率 → 実際・予測した複勝率 → 実際');
  for (const g of GR) console.log(`${g} | ${tl[g].n}R ${pc(tl[g].win)} ${pc(tl[g].place)} | ${tn[g].n}R ${pc(tn[g].predWin)} → ${pc(tn[g].win)}・${pc(tn[g].predPlace)} → ${pc(tn[g].place)}`);
  console.log(`S と C の差（◎の勝率）：従来 ${((tl.S.win - tl.C.win) * 100).toFixed(1)}pt・新 ${((tn.S.win - tn.C.win) * 100).toFixed(1)}pt`);
  const pairedG = (key, target) => {
    const rs = recs.filter((r) => target !== 'yPlace' || r.placeCount);
    const lp = (p, y) => (y ? Math.log(clip(p)) : Math.log(1 - clip(p)));
    const d = rs.map((r) => lp(oofNew[newGrade(r)][key] || 0.3, r[target]) - lp(oofLegacy[r.legacy][key] || 0.3, r[target]));
    const m = mean(d);
    const se = Math.sqrt(mean(d.map((v) => (v - m) ** 2)) / d.length);
    return `${m >= 0 ? '+' : ''}${m.toFixed(4)} ± ${se.toFixed(4)}`;
  };
  console.log(`自信度だけで◎の勝ちを当てる二値対数損失（小さいほど良い）：従来 ${llG(oofLegacy, (r) => r.legacy, 'win', 'yWin').toFixed(4)}・新 ${llG(oofNew, newGrade, 'win', 'yWin').toFixed(4)}（新 − 従来の対の差 ${pairedG('win', 'yWin')}。プラスなら新が良い）。複勝圏：従来 ${llG(oofLegacy, (r) => r.legacy, 'place', 'yPlace').toFixed(4)}・新 ${llG(oofNew, newGrade, 'place', 'yPlace').toFixed(4)}（${pairedG('place', 'yPlace')}）`);
  console.log(`◎が勝つ確率（連続値）：校正前 対数損失 ${bll(recs, (r) => r.pWin, 'yWin').toFixed(4)}・Brier ${brier(recs, (r) => r.pWin, 'yWin').toFixed(4)}・AUC ${auc(recs, (r) => r.pWin, 'yWin').toFixed(3)} → 校正後 ${bll(recs, fWin, 'yWin').toFixed(4)}・${brier(recs, fWin, 'yWin').toFixed(4)}・${auc(recs, fWin, 'yWin').toFixed(3)}`);
  const pr = recs.filter((r) => r.placeCount);
  console.log(`◎が複勝圏（連続値）：校正前 対数損失 ${bll(pr, (r) => r.pPlace, 'yPlace').toFixed(4)}・AUC ${auc(pr, (r) => r.pPlace, 'yPlace').toFixed(3)} → 校正後 ${bll(pr, fPlace, 'yPlace').toFixed(4)}・${auc(pr, fPlace, 'yPlace').toFixed(3)}`);
  return { legacy: tl, next: tn };
};
report('分割外（学習期間）', oof);
const tt = report('検証期間（本番モデル）', test);

if (!DRY) {
  const model = {
    version: 1,
    win: chosen.win.spec,
    place: chosen.place.spec,
    picks: { win: chosen.win.pick, place: chosen.place.pick },
    cv: { win: chosen.win.cv, place: chosen.place.cv },
    cuts,
    gradeRates: oofNew,
    trainedOn: { races: oof.length, from: oof[0].date, to: oof[oof.length - 1].date, rounds: ROUNDS },
    test: { from: TEST_START, races: test.length, grades: tt.next },
  };
  const file = path.join(ROOT, 'src/engine/confidenceModel.js');
  await writeFile(file, `// scripts/fit-confidence.mjs が分割外の予測から作る。手で編集しないでください。\nexport const CONFIDENCE_MODEL = ${JSON.stringify(model)};\n`);
  log(`書き出しました：${path.relative(ROOT, file)}`);
}

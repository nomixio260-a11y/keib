#!/usr/bin/env node
// 実際のレース結果（data/history、scripts/collect.mjs history で収集）からモデルを校正する。
//
//   npm run calibrate
//
// 1. 学習開始より前のレースで統計（基準タイム・上がり・枠順・騎手）を作る
// 2. 学習期間の各レースについて「その時点の出馬表（前4走）」を作り、1〜3着の順番を最もよく説明する係数を推定
//    （プラケット・ルース尤度）。重要度からウェイトの既定値を決め、着順ごとの温度（紛れの大きさ）も推定する
// 3. 全期間の統計を src/engine/realStats.js、係数を src/engine/calibration.js に書き出す
//
// 検証（学習に使っていない直近のレース）は npm run evaluate で行う。

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStats, computeDayVariants, jockeyRates, indexHistory, preRaceCard } from '../src/data/history.js';
import { loadHistory, DATA_DIR } from '../src/collector/store.js';
import { FACTORS, scoreRace } from '../src/engine/model.js';
import { mean, stdev } from '../src/engine/util.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export { loadHistory };
export const PERIODS = {
  calStart: process.env.CAL_START || '2026-03-01',
  testStart: process.env.TEST_START || '2026-08-15',
};
const STAGE_W = [1, 0.75, 0.5];
const DRY = process.argv.includes('--dry');

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

/**
 * 統計オブジェクト（エンジンが使う形）。
 * variantRecords：開催日ごとの馬場差を出すレース（各日の値はその日の結果だけで決まるので、全期間を渡してよい）
 */
export function statsForEngine(records, variantRecords = records) {
  const s = computeStats(records);
  const jr = jockeyRates(s.jockeys);
  const tr = jockeyRates(s.trainers);
  // 基準タイムの全体式 a × (d/1200)^b を芝・ダート別に当てはめ
  const formula = {};
  for (const surface of ['芝', 'ダ']) {
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (const [k, [t, n]] of Object.entries(s.baseTimes)) {
      const [, surf, d] = k.split('|');
      if (surf !== surface) continue;
      const x = Math.log(Number(d) / 1200);
      const y = Math.log(t);
      sw += n;
      sx += n * x;
      sy += n * y;
      sxx += n * x * x;
      sxy += n * x * y;
    }
    if (sw > 0) {
      const b = (sw * sxy - sx * sy) / (sw * sxx - sx * sx);
      const a = Math.exp((sy - b * sx) / sw);
      formula[surface] = { a: Math.round(a * 1000) / 1000, b: Math.round(b * 10000) / 10000 };
    }
  }
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const dayVariant = computeDayVariants(variantRecords, s);
  return {
    races: s.races,
    from: s.from,
    to: s.to,
    baseTimes: s.baseTimes,
    goingAdj: s.goingAdj,
    classAdj: s.classAdj,
    last3f: s.last3f,
    draw: s.draw,
    dayVariant,
    formula,
    jockeyRates: Object.fromEntries(
      Object.entries(jr.rates)
        .filter(([, v]) => v.starts >= 5)
        .map(([k, v]) => [k, { starts: v.starts, winRate: round3(v.winRate), top3Rate: round3(v.top3Rate) }]),
    ),
    jockeyAverage: { winRate: round3(jr.average.winRate), top3Rate: round3(jr.average.top3Rate) },
    trainerRates: Object.fromEntries(
      Object.entries(tr.rates)
        .filter(([, v]) => v.starts >= 5)
        .map(([k, v]) => [k, { starts: v.starts, winRate: round3(v.winRate), top3Rate: round3(v.top3Rate) }]),
    ),
    trainerAverage: { winRate: round3(tr.average.winRate), top3Rate: round3(tr.average.top3Rate) },
  };
}

/** 学習・検証に使えるレース（平地・5頭以上・結果あり） */
export const usable = (rec) => !rec.jump && rec.surface !== '障' && rec.runners.filter((r) => r.finish > 0).length >= 5;

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function fitPL(data, keys) {
  const F = keys.length;
  let beta = new Array(F).fill(0.1);
  let ll = 0;
  for (let it = 0; it < 30; it++) {
    const g = new Array(F).fill(0);
    const H = Array.from({ length: F }, () => new Array(F).fill(0));
    ll = 0;
    for (const d of data) {
      const x = d.z.map((z) => keys.map((k) => z[k]));
      const s = x.map((row) => row.reduce((acc, v, f) => acc + v * beta[f], 0));
      const remain = new Set(x.map((_, i) => i));
      d.order.slice(0, 3).forEach((winner, stage) => {
        const w = STAGE_W[stage];
        const ids = [...remain];
        const mx = Math.max(...ids.map((i) => s[i]));
        const ex = ids.map((i) => Math.exp(s[i] - mx));
        const Z = ex.reduce((a, b) => a + b, 0);
        ll += w * (s[winner] - mx - Math.log(Z));
        const m = new Array(F).fill(0);
        ids.forEach((i, k) => {
          const p = ex[k] / Z;
          for (let f = 0; f < F; f++) m[f] += p * x[i][f];
        });
        for (let f = 0; f < F; f++) g[f] += w * (x[winner][f] - m[f]);
        ids.forEach((i, k) => {
          const p = ex[k] / Z;
          for (let a = 0; a < F; a++) for (let b = 0; b < F; b++) H[a][b] -= w * p * (x[i][a] - m[a]) * (x[i][b] - m[b]);
        });
        remain.delete(winner);
      });
    }
    for (let f = 0; f < F; f++) {
      g[f] -= 2 * beta[f];
      H[f][f] -= 2;
    }
    const step = solve(
      H.map((row) => row.map((v) => -v)),
      g,
    );
    beta = beta.map((b, f) => b + step[f]);
    if (Math.max(...step.map(Math.abs)) < 1e-6) break;
  }
  return { beta, ll };
}

/** 係数がすべて0以上になるまで、マイナスの係数のファクターを外して当てはめ直す */
function fitNonNeg(data, keys) {
  let active = [...keys];
  for (;;) {
    const fit = fitPL(data, active);
    const worst = fit.beta.reduce((m, b, i) => (b < (m ? m.b : 0) ? { b, i } : m), null);
    if (!worst) return { ll: fit.ll, beta: Object.fromEntries(keys.map((k) => [k, active.includes(k) ? fit.beta[active.indexOf(k)] : 0])) };
    active = active.filter((_, i) => i !== worst.i);
  }
}

/**
 * 着順ごとの温度（1着・2着・3着以下）。プラケット・ルースモデルで、その着順の対数尤度が
 * 最も高くなる値を解析的に探す（シミュレーション不要）。2着・3着は紛れが大きいので温度が高めに出る。
 */
function fitTemps(data, scoresOf, label) {
  const scores = data.map(scoresOf);
  const stageLL = (k, T) => {
    let ll = 0;
    data.forEach((d, j) => {
      const sc = scores[j];
      if (d.order.length <= k) return;
      const done = new Set(d.order.slice(0, k));
      const ids = sc.map((_, i) => i).filter((i) => !done.has(i));
      const mx = Math.max(...ids.map((i) => sc[i] / T));
      const Z = ids.reduce((a, i) => a + Math.exp(sc[i] / T - mx), 0);
      ll += sc[d.order[k]] / T - mx - Math.log(Z);
    });
    return ll;
  };
  const temps = [0, 1, 2].map((k) => {
    let best = { t: 1, ll: -Infinity };
    for (let t = 0.5; t <= 2.0001; t += 0.02) {
      const ll = stageLL(k, t);
      if (ll > best.ll) best = { t: +t.toFixed(2), ll };
    }
    log(`  ${label} ${k + 1}着の温度 ${best.t}（対数尤度/レース ${(best.ll / data.length).toFixed(4)}、温度1なら ${(stageLL(k, 1) / data.length).toFixed(4)}）`);
    return best.t;
  });
  return temps;
}

async function main() {
  log('実データを読み込み中', DATA_DIR);
  const all = await loadHistory();
  if (all.length < 300) {
    console.error(`レースが足りません（${all.length}件）。先に node scripts/collect.mjs history を実行してください。`);
    process.exit(1);
  }
  log(`${all.length}レース（${all[0].date}〜${all[all.length - 1].date}）`);
  const index = indexHistory(all);
  const statsTrain = statsForEngine(
    all.filter((r) => r.date < PERIODS.calStart),
    all,
  );
  log(`学習用の統計：${statsTrain.races}レース（${statsTrain.from}〜${statsTrain.to}）・基準タイム${Object.keys(statsTrain.baseTimes).length}条件`);

  const fitRecords = all.filter((r) => r.date >= PERIODS.calStart && r.date < PERIODS.testStart && usable(r));
  log(`学習レース：${fitRecords.length}（${PERIODS.calStart}〜${PERIODS.testStart} の前日）`);
  const data = fitRecords.map((rec) => {
    const card = preRaceCard(rec, index);
    const s = scoreRace(card, { stats: statsTrain });
    const idxOf = new Map(s.rows.map((r, i) => [r.entry.number, i]));
    return {
      z: s.rows.map((r) => r.z),
      order: card.result.map((num) => idxOf.get(num)).filter((v) => v != null),
    };
  });

  const baseKeys = FACTORS.map((f) => f.key).filter((k) => k !== 'market');
  const allKeys = [...baseKeys, 'market'];
  log('係数を推定中');
  const base = fitNonNeg(data, baseKeys);
  const withMkt = fitNonNeg(data, allKeys);
  const mktOnly = fitPL(data, ['market']);
  const per = (v) => +(v / data.length).toFixed(4);
  const fitLL = { ai: per(base.ll), total: per(withMkt.ll), market: per(mktOnly.ll) };
  log(`対数尤度/レース  AIのみ ${fitLL.ai}  総合（AI+人気） ${fitLL.total}  人気のみ ${fitLL.market}`);

  const pooledSd = (key) => stdev(data.flatMap((d) => d.z.map((z) => z[key])));
  // どのスライダーも効くように係数に下限を設ける
  const coef = Object.fromEntries(baseKeys.map((k) => [k, Math.max(0.04, base.beta[k])]));
  const importance = Object.fromEntries(baseKeys.map((k) => [k, coef[k] * pooledSd(k)]));
  const totalImp = baseKeys.reduce((a, k) => a + importance[k], 0);
  const ref = Object.fromEntries(baseKeys.map((k) => [k, Math.max(5, Math.round(((importance[k] / totalImp) * 100) / 5) * 5)]));
  coef.market = Math.max(0.04, mktOnly.beta[0]);
  ref.market = 100;
  // 総合：AI+人気を同時に当てはめた係数を、スライダーの値に直す（係数 = coef × 値 ÷ ref）
  const combinedWeights = Object.fromEntries(allKeys.map((k) => [k, Math.min(100, Math.round((ref[k] * withMkt.beta[k]) / coef[k]))]));
  log('係数（AIのみ）', Object.fromEntries(allKeys.map((k) => [k, +coef[k].toFixed(3)])));
  log('係数（総合）', Object.fromEntries(allKeys.map((k) => [k, +withMkt.beta[k].toFixed(3)])));
  log('重要度(%)', ref);
  log('総合の重み', combinedWeights);

  const scoreWith = (beta) => (d) => d.z.map((z) => allKeys.reduce((acc, k) => acc + (beta[k] || 0) * z[k], 0));
  const aiScore = scoreWith({ ...coef, market: 0 });
  const totalCoef = Object.fromEntries(allKeys.map((k) => [k, (coef[k] * combinedWeights[k]) / ref[k]]));
  const totalScore = scoreWith(totalCoef);
  const indexScale = mean(data.map((d) => stdev(aiScore(d))));

  log('着順ごとの温度を推定中');
  const tempsAi = fitTemps(data, aiScore, 'AI単独');
  const tempsTotal = fitTemps(data, totalScore, '総合');
  // 市場（単勝オッズだけ）の構造：馬連・三連複などの「推定オッズ」を、予想と同じ形のモデルで作るため
  const marketBeta = mktOnly.beta[0];
  const tempsMarket = fitTemps(data, (d) => d.z.map((z) => marketBeta * z.market), '人気のみ');
  // 学習期間の対数尤度が高いほうを既定にする
  const defaultPreset = fitLL.total > fitLL.ai ? 'balance' : 'ai';

  const calibration = {
    coef: Object.fromEntries(Object.entries(coef).map(([k, v]) => [k, +v.toFixed(4)])),
    ref,
    combinedWeights,
    temps: { ai: tempsAi, total: tempsTotal, market: tempsMarket },
    marketBeta: +marketBeta.toFixed(4),
    defaultPreset,
    indexScale: +indexScale.toFixed(4),
    trainedOn: data.length,
    fitLL,
    period: { stats: `${statsTrain.from}〜${statsTrain.to}`, fit: `${fitRecords[0]?.date}〜${fitRecords[fitRecords.length - 1]?.date}` },
    source: 'JRA',
  };
  const statsAllFull = statsForEngine(all);
  const header = '// scripts/calibrate.mjs が実際のレース結果（JRA）から生成。手で編集しないでください。\n';
  if (DRY) {
    console.log(JSON.stringify(calibration, null, 2));
    return;
  }
  await writeFile(path.join(root, 'src/engine/calibration.js'), `${header}export const CALIBRATION = ${JSON.stringify(calibration, null, 2)};\n`);
  await writeFile(path.join(root, 'src/engine/realStats.js'), `${header}export const REAL_STATS = ${JSON.stringify(statsAllFull)};\n`);
  log(`書き出しました：calibration.js・realStats.js（統計 ${statsAllFull.races}レース、${statsAllFull.from}〜${statsAllFull.to}）`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

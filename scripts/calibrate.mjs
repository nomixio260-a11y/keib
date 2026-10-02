#!/usr/bin/env node
// モデルの係数を学習用の架空レースから推定し、src/engine/calibration.js に書き出す。
//
//   npm run calibrate            … 学習して書き出す
//   npm run calibrate -- --dry   … 書き出さずに結果だけ表示
//
// 1. 着順（1〜3着）に対するプラケット・ルース尤度を最大化して各ファクターの係数を推定
// 2. 係数 × ばらつきから「重要度」を出し、ウェイトの既定値（スライダー）にする
// 3. モンテカルロの揺らぎの大きさを、勝率の対数尤度が最大になるように選ぶ

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateBacktestRaces } from '../src/data/generator.js';
import { SIRE_MAP } from '../src/data/names.js';
import { FACTORS, NOISE_BASE, scoreRace } from '../src/engine/model.js';
import { simulate } from '../src/engine/simulate.js';
import { mean, stdev } from '../src/engine/util.js';

const DRY = process.argv.includes('--dry');
const TRAIN = Number(process.env.TRAIN || 1500);
const STAGE_W = [1, 0.75, 0.5];

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

log(`学習用レースを生成中（${TRAIN}レース）`);
const train = generateBacktestRaces(TRAIN, 1001, { debugTruth: true });

// 各レースの標準化済みファクター（z）と着順
const data = train.map((race) => {
  const s = scoreRace(race, { sires: SIRE_MAP });
  const idxOf = new Map(s.rows.map((r, i) => [r.entry.number, i]));
  return {
    z: s.rows.map((r) => r.z),
    u: s.rows.map((r) => r.sigma / NOISE_BASE),
    exp: s.rows.map((r) => r.entry._exp),
    order: race.result.map((num) => idxOf.get(num)).filter((v) => v != null),
  };
});

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

/** プラケット・ルース（上位3着）をニュートン法で当てはめる */
function fitPL(keys) {
  const F = keys.length;
  let beta = new Array(F).fill(0.1);
  for (let it = 0; it < 30; it++) {
    const g = new Array(F).fill(0);
    const H = Array.from({ length: F }, () => new Array(F).fill(0));
    let ll = 0;
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
    // 弱いリッジ正則化
    for (let f = 0; f < F; f++) {
      g[f] -= 2 * beta[f];
      H[f][f] -= 2;
    }
    const step = solve(
      H.map((row) => row.map((v) => -v)),
      g,
    );
    beta = beta.map((b, f) => b + step[f]);
    if (Math.max(...step.map(Math.abs)) < 1e-6) {
      return { beta, ll };
    }
    if (it === 29) return { beta, ll };
  }
  return { beta, ll: NaN };
}

const baseKeys = FACTORS.map((f) => f.key).filter((k) => k !== 'market');
log('係数を推定中（人気なし）');
const base = fitPL(baseKeys);
log('係数を推定中（人気あり）');
const withMkt = fitPL([...baseKeys, 'market']);

const pooledSd = (key) => stdev(data.flatMap((d) => d.z.map((z) => z[key])));
// どのスライダーも効くように係数に下限を設ける
const coef = Object.fromEntries(baseKeys.map((k, i) => [k, Math.max(0.06, base.beta[i])]));
const importance = Object.fromEntries(baseKeys.map((k) => [k, coef[k] * pooledSd(k)]));
const totalImp = baseKeys.reduce((a, k) => a + importance[k], 0);
const ref = Object.fromEntries(baseKeys.map((k) => [k, Math.max(5, Math.round(((importance[k] / totalImp) * 100) / 5) * 5)]));
// 人気：スライダー100で「人気だけのモデル」と同じ強さ
log(`対数尤度/レース 人気なし ${(base.ll / data.length).toFixed(4)} 人気あり ${(withMkt.ll / data.length).toFixed(4)}`);
const mktOnly = fitPL(['market']);
log(`対数尤度/レース 人気のみ ${(mktOnly.ll / data.length).toFixed(4)}`);
coef.market = Math.max(0.005, mktOnly.beta[0]);
ref.market = 100;
// 「人気も加味」プリセット：AI と人気を半分ずつ
const popularWeights = Object.fromEntries(baseKeys.map((k) => [k, Math.round(ref[k] / 2)]));
popularWeights.market = 50;

log('係数', Object.fromEntries(Object.entries(coef).map(([k, v]) => [k, +v.toFixed(3)])));
log('重要度(%)', ref);
log('人気も加味', popularWeights);

// AI指数の目盛り：レース内のスコアの標準偏差の平均
const scores = data.map((d) => d.z.map((z) => baseKeys.reduce((acc, k) => acc + coef[k] * z[k], 0)));
const indexScale = mean(scores.map((s) => stdev(s)));

// モンテカルロの揺らぎ：勝率の対数尤度が最大になる倍率を探す
log('揺らぎの大きさを探索中');
const sample = data.slice(0, 300);
let best = { c: 1.28, ll: -Infinity };
for (const c of [0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.0]) {
  let ll = 0;
  sample.forEach((d, k) => {
    const s = scores[k];
    const sim = simulate(s, d.u.map((v) => v * c), { sims: 2000, seed: 1234 + k });
    ll += Math.log(Math.max(sim.win[d.order[0]], 1 / 4000));
  });
  log(`  倍率 ${c.toFixed(2)}  対数尤度 ${(ll / sample.length).toFixed(4)}`);
  if (ll > best.ll) best = { c, ll };
}
log('採用', best.c);

// 生成器の市場モデル用：AIのスコアから本当の強さをどれだけ言い当てられるか（回帰係数と残差分散）
const xs = [];
const ys = [];
data.forEach((d, k) => {
  const s = scores[k];
  const mS = mean(s);
  const mE = mean(d.exp);
  s.forEach((v, i) => {
    xs.push(v - mS);
    ys.push(d.exp[i] - mE);
  });
});
const kSlope = xs.reduce((a, x, i) => a + x * ys[i], 0) / xs.reduce((a, x) => a + x * x, 0);
const residVar = mean(ys.map((y, i) => (y - kSlope * xs[i]) ** 2));
log(`市場モデル k=${kSlope.toFixed(3)} 残差分散=${residVar.toFixed(2)}`);

const calibration = {
  coef: Object.fromEntries(Object.entries(coef).map(([k, v]) => [k, +v.toFixed(4)])),
  ref,
  popularWeights,
  noiseBase: best.c,
  indexScale: +indexScale.toFixed(4),
  marketModel: { k: +kSlope.toFixed(3), residVar: +residVar.toFixed(2) },
  trainedOn: TRAIN,
};

const file = fileURLToPath(new URL('../src/engine/calibration.js', import.meta.url));
const body = `// scripts/calibrate.mjs が生成（架空の学習用 ${TRAIN} レースで推定）。手で編集しないでください。\nexport const CALIBRATION = ${JSON.stringify(calibration, null, 2)};\n`;
if (!DRY) {
  writeFileSync(file, body);
  log('書き出しました:', file);
} else {
  console.log(body);
}

// 検証は scripts/evaluate.mjs（npm run evaluate）で行う

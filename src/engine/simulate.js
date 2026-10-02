// モンテカルロ・レースシミュレーション
//
// 各馬の当日のパフォーマンスを「能力スコア + 正規分布の揺らぎ」として何万回も走らせ、
// 着順の分布から勝率・連対率・複勝率と各券種の的中確率を求める。

import { createRng } from './rng.js';

export function simulate(strengths, sigmas, { sims = 20000, seed = 1 } = {}) {
  const n = strengths.length;
  const rng = createRng(seed);
  const perf = new Float64Array(n);
  const order = new Int32Array(n);
  const posCount = new Float64Array(n * n);
  const top = new Int16Array(sims * 3).fill(-1);

  for (let s = 0; s < sims; s++) {
    for (let i = 0; i < n; i++) perf[i] = strengths[i] + sigmas[i] * rng.normal();
    // 挿入ソートで着順を作る（頭数が少ないので速い）
    for (let i = 0; i < n; i++) {
      const v = perf[i];
      let j = i - 1;
      while (j >= 0 && perf[order[j]] < v) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = i;
    }
    for (let r = 0; r < n; r++) posCount[order[r] * n + r]++;
    const base = s * 3;
    top[base] = order[0];
    if (n > 1) top[base + 1] = order[1];
    if (n > 2) top[base + 2] = order[2];
  }

  const posDist = new Float64Array(n * n);
  const win = new Float64Array(n);
  const top2 = new Float64Array(n);
  const top3 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < n; r++) posDist[i * n + r] = posCount[i * n + r] / sims;
    win[i] = posDist[i * n];
    top2[i] = win[i] + (n > 1 ? posDist[i * n + 1] : 0);
    top3[i] = top2[i] + (n > 2 ? posDist[i * n + 2] : 0);
  }
  return { n, sims, posDist, win, top2, top3, samples: top };
}

/** シミュレーション結果から各券種の的中確率を集計 */
export function comboProbs(sim) {
  const { n, sims, samples } = sim;
  const exacta = new Float64Array(n * n);
  const quinella = new Float64Array(n * n);
  const wide = new Float64Array(n * n);
  const trio = new Float64Array(n * n * n);
  const trifecta = new Float64Array(n * n * n);
  const inc = 1 / sims;
  for (let s = 0; s < sims; s++) {
    const a = samples[s * 3];
    const b = samples[s * 3 + 1];
    const c = samples[s * 3 + 2];
    if (b < 0) continue;
    exacta[a * n + b] += inc;
    quinella[Math.min(a, b) * n + Math.max(a, b)] += inc;
    if (c < 0) continue;
    trifecta[(a * n + b) * n + c] += inc;
    let x = a;
    let y = b;
    let z = c;
    if (x > y) { const t = x; x = y; y = t; }
    if (y > z) { const t = y; y = z; z = t; }
    if (x > y) { const t = x; x = y; y = t; }
    trio[(x * n + y) * n + z] += inc;
    wide[x * n + y] += inc;
    wide[x * n + z] += inc;
    wide[y * n + z] += inc;
  }
  return { n, exacta, quinella, wide, trio, trifecta };
}

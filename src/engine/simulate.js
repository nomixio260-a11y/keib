// モンテカルロ・レースシミュレーション
//
// simulatePL：重みを推定したのと同じプラケット・ルース（多項ロジット）モデルで、1着から順に着順を引いていく。
//   1着は exp(スコア/T1)、2着は残りの馬で exp(スコア/T2)、3着以下は exp(スコア/T3) に比例する確率。
//   着順ごとの温度 T は実際のレースで推定（2着・3着は1着より紛れが大きい）。予想に使う。
// simulate：能力スコア + 正規分布の揺らぎ。単勝オッズから市場の券種別の確率を作るのに使う。
// exactPL：同じプラケット・ルースの 1〜3着の確率と券種別の確率を厳密に計算する（勝率・買い目の確率はこちらを使う。
//   シミュレーションは着順の分布の表示と、買い目の組み合わせ全体の統計にだけ使う）。

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

/**
 * プラケット・ルースモデルで着順を引く。temps = [1着, 2着, 3着以下] の温度（大きいほど紛れる）。
 * 返り値は simulate と同じ形（着順分布・勝率・連対率・複勝率・上位3頭のサンプル）。
 */
export function simulatePL(scores, { sims = 20000, seed = 1, temps = [1, 1, 1] } = {}) {
  const n = scores.length;
  const rng = createRng(seed);
  const mx = Math.max(...scores);
  const w = [0, 1, 2].map((k) => Float64Array.from(scores, (v) => Math.exp((v - mx) / Math.max(0.05, temps[k] ?? 1))));
  const sum0 = w.map((arr) => arr.reduce((a, b) => a + b, 0));
  const used = new Uint8Array(n);
  const posCount = new Float64Array(n * n);
  const top = new Int16Array(sims * 3).fill(-1);
  const rest = new Float64Array(3);

  for (let s = 0; s < sims; s++) {
    used.fill(0);
    rest[0] = sum0[0];
    rest[1] = sum0[1];
    rest[2] = sum0[2];
    for (let r = 0; r < n; r++) {
      const k = r < 2 ? r : 2;
      const wk = w[k];
      // 残りの馬の重みの合計は引き算で更新（誤差がたまったら数え直す）
      if (!(rest[k] > 1e-12)) {
        rest[k] = 0;
        for (let i = 0; i < n; i++) if (!used[i]) rest[k] += wk[i];
      }
      let u = rng.next() * rest[k];
      let pick = -1;
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        pick = i;
        u -= wk[i];
        if (u <= 0) break;
      }
      used[pick] = 1;
      rest[0] -= w[0][pick];
      rest[1] -= w[1][pick];
      rest[2] -= w[2][pick];
      posCount[pick * n + r]++;
      if (r < 3) top[s * 3 + r] = pick;
    }
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

/**
 * プラケット・ルースの厳密計算（シミュレーションの揺らぎなし）。
 * 1着は exp(スコア/T1)、2着は残りの馬で exp(スコア/T2)、3着は exp(スコア/T3) に比例するとして、
 * 1〜3着のすべての並び（最大 18×17×16 = 4,896通り）の確率を足し合わせる。
 * 返り値：win / top2 / top3（各馬）と combos（馬単・馬連・ワイド・三連複・三連単の確率。simulatePL+comboProbs と同じ形）
 */
export function exactPL(scores, { temps = [1, 1, 1] } = {}) {
  const n = scores.length;
  const mx = n ? Math.max(...scores) : 0;
  const w = [0, 1, 2].map((k) => Float64Array.from(scores, (v) => Math.exp((v - mx) / Math.max(0.05, temps[k] ?? 1))));
  const S = w.map((arr) => arr.reduce((a, b) => a + b, 0));
  const win = new Float64Array(n);
  const second = new Float64Array(n);
  const third = new Float64Array(n);
  const exacta = new Float64Array(n * n);
  const quinella = new Float64Array(n * n);
  const wide = new Float64Array(n * n);
  const trio = new Float64Array(n * n * n);
  const trifecta = new Float64Array(n * n * n);
  // 1〜3着の並び（a,b,c）とその確率。買い目の組み合わせ全体の的中率・収支の確率を厳密に出すのに使う
  const tripleCount = n >= 3 ? n * (n - 1) * (n - 2) : n === 2 ? 2 : n;
  const triples = new Int16Array(tripleCount * 3).fill(-1);
  const probs = new Float64Array(tripleCount);
  let ti = 0;
  for (let a = 0; a < n; a++) {
    const p1 = w[0][a] / S[0];
    win[a] = p1;
    if (n < 2) {
      triples[ti * 3] = a;
      probs[ti++] = p1;
      continue;
    }
    const S2 = S[1] - w[1][a];
    for (let b = 0; b < n; b++) {
      if (b === a) continue;
      const p12 = p1 * (w[1][b] / Math.max(S2, 1e-300));
      exacta[a * n + b] = p12;
      quinella[Math.min(a, b) * n + Math.max(a, b)] += p12;
      second[b] += p12;
      if (n < 3) {
        triples[ti * 3] = a;
        triples[ti * 3 + 1] = b;
        probs[ti++] = p12;
        continue;
      }
      const S3 = S2 - w[2][b] + (w[1][b] - w[2][b]) * 0 - (w[1][a] - w[2][a]) * 0; // 下で正しく計算
      const S3real = S[2] - w[2][a] - w[2][b];
      for (let c = 0; c < n; c++) {
        if (c === a || c === b) continue;
        const p = p12 * (w[2][c] / Math.max(S3real, 1e-300));
        trifecta[(a * n + b) * n + c] = p;
        third[c] += p;
        triples[ti * 3] = a;
        triples[ti * 3 + 1] = b;
        triples[ti * 3 + 2] = c;
        probs[ti++] = p;
        let x = a;
        let y = b;
        let z = c;
        if (x > y) [x, y] = [y, x];
        if (y > z) [y, z] = [z, y];
        if (x > y) [x, y] = [y, x];
        trio[(x * n + y) * n + z] += p;
        wide[x * n + y] += p;
        wide[x * n + z] += p;
        wide[y * n + z] += p;
      }
      void S3;
    }
  }
  const top2 = new Float64Array(n);
  const top3 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    top2[i] = win[i] + second[i];
    top3[i] = top2[i] + third[i];
  }
  return { n, win, top2, top3, triples, probs, combos: { n, exacta, quinella, wide, trio, trifecta } };
}

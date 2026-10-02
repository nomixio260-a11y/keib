// 市場（オッズ）側の確率。単勝オッズから各券種の「推定オッズ」を出す。

import { PAYOUT_RATE } from './constants.js';

/** 単勝オッズ → 市場の勝率（控除分を取り除いて正規化）。オッズ欠損は最低人気並みとみなす */
export function impliedWinProbs(oddsList) {
  const inv = oddsList.map((o) => (o > 1 ? 1 / o : null));
  const known = inv.filter((v) => v != null);
  if (!known.length) return oddsList.map(() => 1 / Math.max(1, oddsList.length));
  const fill = Math.min(...known) * 0.7;
  const raw = inv.map((v) => v ?? fill);
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((v) => v / total);
}

/**
 * 割引ハーヴィル式で着順の組み合わせ確率を計算。
 * 2着・3着は人気馬ほど過大評価されやすいので、指数 l2・l3 で確率を平らにする。
 */
export function harville(q, l2 = 0.81, l3 = 0.65) {
  const n = q.length;
  const q2 = q.map((v) => Math.pow(v, l2));
  const q3 = q.map((v) => Math.pow(v, l3));
  const sum2 = q2.reduce((a, b) => a + b, 0);
  const sum3 = q3.reduce((a, b) => a + b, 0);
  const win = q.slice();
  const top2 = new Float64Array(n);
  const top3 = new Float64Array(n);
  const exacta = new Float64Array(n * n);
  const quinella = new Float64Array(n * n);
  const wide = new Float64Array(n * n);
  const trio = new Float64Array(n * n * n);
  const trifecta = new Float64Array(n * n * n);
  for (let i = 0; i < n; i++) {
    const d2 = sum2 - q2[i];
    if (d2 <= 0) continue;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const pij = q[i] * (q2[j] / d2);
      exacta[i * n + j] = pij;
      quinella[Math.min(i, j) * n + Math.max(i, j)] += pij;
      top2[i] += pij;
      top2[j] += pij;
      const d3 = sum3 - q3[i] - q3[j];
      if (d3 <= 0) continue;
      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;
        const p = pij * (q3[k] / d3);
        trifecta[(i * n + j) * n + k] = p;
        top3[i] += p;
        top3[j] += p;
        top3[k] += p;
        // 3頭を昇順に並べる（配列を作らずに）
        let a = i;
        let b = j;
        let c = k;
        if (a > b) { const t = a; a = b; b = t; }
        if (b > c) { const t = b; b = c; c = t; }
        if (a > b) { const t = a; a = b; b = t; }
        trio[(a * n + b) * n + c] += p;
        wide[a * n + b] += p;
        wide[a * n + c] += p;
        wide[b * n + c] += p;
      }
    }
  }
  // 3頭未満のレースでは top3 = top2
  if (n < 3) for (let i = 0; i < n; i++) top3[i] = top2[i];
  return { n, win, top2, top3, exacta, quinella, wide, trio, trifecta };
}

/** 標準正規分布の累積分布関数（Abramowitz-Stegun 7.1.26） */
export function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** 各馬のパフォーマンスが正規分布 N(mu_i, sigma_i) のときの勝率（数値積分）。sigma は数値か配列 */
export function normalWinProbs(mu, sigma = 1, steps = 200) {
  const n = mu.length;
  const sd = Array.isArray(sigma) ? sigma : new Array(n).fill(sigma);
  const maxSd = Math.max(...sd);
  const lo = Math.min(...mu) - 4 * maxSd;
  const hi = Math.max(...mu) + 4 * maxSd;
  const dx = (hi - lo) / steps;
  const p = new Array(n).fill(0);
  const cdf = new Array(n);
  const prefix = new Array(n + 1);
  const suffix = new Array(n + 1);
  for (let s = 0; s <= steps; s++) {
    const x = lo + s * dx;
    for (let i = 0; i < n; i++) cdf[i] = normCdf((x - mu[i]) / sd[i]);
    prefix[0] = 1;
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] * cdf[i];
    suffix[n] = 1;
    for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] * cdf[i];
    for (let i = 0; i < n; i++) {
      const z = (x - mu[i]) / sd[i];
      p[i] += (Math.exp(-0.5 * z * z) / sd[i]) * prefix[i] * suffix[i + 1];
    }
  }
  const total = p.reduce((a, b) => a + b, 0);
  return p.map((v) => v / total);
}

/** 市場の勝率を再現する正規モデルの強さを求める（反復法） */
export function fitNormalStrengths(q, iters = 40) {
  const n = q.length;
  const lq = q.map((v) => Math.log(Math.max(v, 1e-6)));
  const mean = lq.reduce((a, b) => a + b, 0) / n;
  let mu = lq.map((v) => (v - mean) * 0.45);
  for (let it = 0; it < iters; it++) {
    const p = normalWinProbs(mu, 1, 120);
    let maxErr = 0;
    mu = mu.map((m, i) => {
      const d = lq[i] - Math.log(Math.max(p[i], 1e-9));
      maxErr = Math.max(maxErr, Math.abs(d));
      return m + 0.35 * d;
    });
    if (maxErr < 0.01) break;
  }
  return mu;
}

/** 市場確率から推定オッズ（払戻率 ÷ 確率）。JRAの最低払戻 1.0 倍 */
export function estimateOdds(type, marketProb) {
  if (!(marketProb > 0)) return null;
  return Math.max(1.0, Math.floor((PAYOUT_RATE[type] / marketProb) * 10) / 10);
}

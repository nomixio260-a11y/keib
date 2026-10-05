// 準ポアソン回帰（対数リンク）：E[y] = exp(β·x)。y は 0 以上の実数（1点あたりの払戻 ÷ 賭けた金額など）。
// IRLS（ニュートン法）で、定数項（x[0] = 1）以外にリッジ λ をかけて当てはめる
export function fitPoissonGlm(X, y, { lambda = 10, iters = 30, tol = 1e-8 } = {}) {
  const d = X[0].length;
  const beta = new Array(d).fill(0);
  beta[0] = Math.log(Math.max(1e-6, y.reduce((s, v) => s + v, 0) / y.length));
  for (let it = 0; it < iters; it++) {
    const H = Array.from({ length: d }, () => new Array(d).fill(0));
    const g = new Array(d).fill(0);
    for (let i = 0; i < X.length; i++) {
      const x = X[i];
      let eta = 0;
      for (let j = 0; j < d; j++) eta += beta[j] * x[j];
      const mu = Math.exp(Math.min(5, eta));
      for (let j = 0; j < d; j++) {
        g[j] += (y[i] - mu) * x[j];
        for (let k = 0; k <= j; k++) H[j][k] += mu * x[j] * x[k];
      }
    }
    for (let j = 0; j < d; j++) {
      for (let k = 0; k < j; k++) H[k][j] = H[j][k];
      if (j > 0) {
        H[j][j] += lambda;
        g[j] -= lambda * beta[j];
      }
    }
    // H · step = g をガウスの消去法で
    const M = H.map((r, i) => [...r, g[i]]);
    for (let i = 0; i < d; i++) {
      let p = i;
      for (let r = i + 1; r < d; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
      [M[i], M[p]] = [M[p], M[i]];
      for (let r = 0; r < d; r++) {
        if (r === i) continue;
        const f = M[r][i] / M[i][i];
        for (let k = i; k <= d; k++) M[r][k] -= f * M[i][k];
      }
    }
    let mx = 0;
    for (let j = 0; j < d; j++) {
      const step = M[j][d] / M[j][j];
      beta[j] += step;
      mx = Math.max(mx, Math.abs(step));
    }
    if (mx < tol) break;
  }
  return beta;
}

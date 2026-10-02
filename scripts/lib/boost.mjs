// 勾配ブースティングの共通部分：レースごとのソフトマックス尤度をニュートン法で最適化する決定木の集まり。
// scripts/train-gbdt.mjs（学習して書き出す）と scripts/cv-gbdt.mjs（交差検証で設定を選ぶ）が使う。
//
// 各馬のスコア = 出発点（単勝オッズの対数確率。NO_MARKET なら 0）＋ 木の合計。
// 1着の確率はレース内のソフトマックス。木は「オッズにまだ織り込まれていない分」だけを学ぶ。

export const BINS = 64;

export const DEFAULT_PARAMS = { rounds: 600, depth: 3, lr: 0.04, lambda: 5, minH: 3, colsample: 0.7, subsample: 0.8, patience: 80, topk: 1, stageWeight: 0.5 };

/** 行をレースごとにまとめ、日付順に並べる */
export function groupRaces(rows) {
  const raceOf = new Map();
  for (const r of rows) (raceOf.get(r.raceId) || raceOf.set(r.raceId, []).get(r.raceId)).push(r);
  return [...raceOf.values()].sort((a, b) => (a[0].date < b[0].date ? -1 : a[0].date > b[0].date ? 1 : 0));
}

/** レースの配列 → 学習用の平らな配列 */
export function flatten(races, Fn, { baseIndex = -1 } = {}) {
  const n = races.reduce((a, rs) => a + rs.length, 0);
  const X = new Float64Array(n * Fn);
  const y = new Uint8Array(n);
  const finish = new Int16Array(n);
  const bwHidden = new Uint8Array(n);
  const base = new Float64Array(n);
  const start = new Int32Array(races.length + 1);
  let k = 0;
  races.forEach((rs, ri) => {
    start[ri] = k;
    for (const r of rs) {
      for (let f = 0; f < Fn; f++) X[k * Fn + f] = r.x[f];
      y[k] = r.y;
      finish[k] = r.finish || 0;
      bwHidden[k] = r.bwHidden || 0;
      base[k] = baseIndex >= 0 ? r.x[baseIndex] : 0;
      k++;
    }
  });
  start[races.length] = k;
  return { n, X, y, finish, bwHidden, base, start, races, Fn };
}

/** ビンの境界（学習データの分位点） */
export function makeThresholds(d, bins = BINS) {
  const Fn = d.Fn;
  const thresholds = [];
  for (let f = 0; f < Fn; f++) {
    const vals = new Float64Array(d.n);
    for (let i = 0; i < d.n; i++) vals[i] = d.X[i * Fn + f];
    vals.sort();
    const th = [];
    for (let b = 1; b < bins; b++) {
      const v = vals[Math.floor((b / bins) * d.n)];
      if (!th.length || v > th[th.length - 1]) th.push(v);
    }
    thresholds.push(th);
  }
  return thresholds;
}

export function binize(d, thresholds) {
  const Fn = d.Fn;
  const B = new Uint8Array(d.n * Fn);
  for (let i = 0; i < d.n; i++)
    for (let f = 0; f < Fn; f++) {
      const v = d.X[i * Fn + f];
      const th = thresholds[f];
      let lo = 0;
      let hi = th.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (v <= th[mid]) hi = mid;
        else lo = mid + 1;
      }
      B[i * Fn + f] = lo;
    }
  d.B = B;
  return d;
}

/** レースごとのソフトマックス確率（p に書く）と、1レースあたりの対数尤度・1番手の正答率 */
export function softmax(d, margin, p) {
  let ll = 0;
  let top1 = 0;
  for (let ri = 0; ri < d.races.length; ri++) {
    const a = d.start[ri];
    const b = d.start[ri + 1];
    let mx = -Infinity;
    for (let i = a; i < b; i++) if (margin[i] > mx) mx = margin[i];
    let Z = 0;
    for (let i = a; i < b; i++) {
      p[i] = Math.exp(margin[i] - mx);
      Z += p[i];
    }
    let best = a;
    for (let i = a; i < b; i++) {
      p[i] /= Z;
      if (p[i] > p[best]) best = i;
      if (d.y[i]) ll += Math.log(Math.max(p[i], 1e-12));
    }
    if (d.y[best]) top1++;
  }
  return { ll: ll / d.races.length, top1: top1 / d.races.length };
}

/**
 * 勾配とヘッセ行列の対角：着順の上位 topk 着までの Plackett–Luce 尤度。
 * 1着はレース全体のソフトマックス、2着は1着を除いた残りの中のソフトマックス、…と続ける（線形モデルの PL 当てはめと同じ形）。
 * 1着だけ（topk=1）より1レースから学べる情報が増える。後ろの段階の重みは stageWeight^段階
 */
export function plGradients(d, margin, g, h, topk = 1, stageWeight = 0.5) {
  g.fill(0);
  h.fill(0);
  const tmp = new Float64Array(32);
  for (let ri = 0; ri < d.races.length; ri++) {
    const a = d.start[ri];
    const bnd = d.start[ri + 1];
    for (let s = 0; s < topk; s++) {
      let target = -1;
      let mx = -Infinity;
      for (let i = a; i < bnd; i++) {
        const f = d.finish[i];
        if (f === s + 1) target = i;
        if (f > s || f === 0) mx = Math.max(mx, margin[i]);
      }
      if (target < 0 || mx === -Infinity) break;
      let Z = 0;
      for (let i = a; i < bnd; i++) {
        const f = d.finish[i];
        tmp[i - a] = f > s || f === 0 ? Math.exp(margin[i] - mx) : 0;
        Z += tmp[i - a];
      }
      const w = Math.pow(stageWeight, s);
      for (let i = a; i < bnd; i++) {
        if (!tmp[i - a]) continue;
        const p = tmp[i - a] / Z;
        g[i] += w * (p - (i === target ? 1 : 0));
        h[i] += w * Math.max(p * (1 - p), 1e-6);
      }
    }
  }
}

export function makeRng(seed = 12345) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** 1本の木を学習（深さ優先、ヒストグラム）。木は { leaf } か { f, t, l, r } のノードの配列 */
export function buildTree(d, g, h, rowsIdx, feats, thresholds, params) {
  const { depth: maxDepth, lambda, minH, lr } = params;
  const Fn = d.Fn;
  const bins = thresholds[0] ? Math.max(...thresholds.map((t) => t.length)) + 1 : BINS;
  const tree = [];
  const grow = (idx, depth) => {
    let G = 0;
    let H = 0;
    for (const i of idx) {
      G += g[i];
      H += h[i];
    }
    const leafValue = (-G / (H + lambda)) * lr;
    if (depth >= maxDepth || idx.length < 2 * minH) return tree.push({ leaf: leafValue }) - 1;
    let best = { gain: 0, f: -1, b: -1 };
    const baseScore = (G * G) / (H + lambda);
    const hg = new Float64Array(bins);
    const hh = new Float64Array(bins);
    for (const f of feats) {
      hg.fill(0);
      hh.fill(0);
      for (const i of idx) {
        const b = d.B[i * Fn + f];
        hg[b] += g[i];
        hh[b] += h[i];
      }
      let GL = 0;
      let HL = 0;
      const nb = thresholds[f].length;
      for (let b = 0; b < nb; b++) {
        GL += hg[b];
        HL += hh[b];
        const GR = G - GL;
        const HR = H - HL;
        if (HL < minH || HR < minH) continue;
        const gain = (GL * GL) / (HL + lambda) + (GR * GR) / (HR + lambda) - baseScore;
        if (gain > best.gain) best = { gain, f, b };
      }
    }
    if (best.f < 0 || best.gain <= 1e-9) return tree.push({ leaf: leafValue }) - 1;
    const left = [];
    const right = [];
    for (const i of idx) (d.B[i * Fn + best.f] <= best.b ? left : right).push(i);
    const node = { f: best.f, t: thresholds[best.f][best.b], l: -1, r: -1, gain: best.gain };
    const me = tree.push(node) - 1;
    node.l = grow(left, depth + 1);
    node.r = grow(right, depth + 1);
    return me;
  };
  grow(rowsIdx, 0);
  return tree;
}

export function predictTree(tree, X, i, Fn) {
  let k = 0;
  for (;;) {
    const nd = tree[k];
    if (nd.leaf != null) return nd.leaf;
    k = X[i * Fn + nd.f] <= nd.t ? nd.l : nd.r;
  }
}

export function applyTree(tree, d, margin) {
  for (let i = 0; i < d.n; i++) margin[i] += predictTree(tree, d.X, i, d.Fn);
}

/**
 * ブースティングの学習。
 *   fit … 学習データ（binize 済み）、valids … 進み具合を測るデータの配列（最初のものを早期終了の判定に使う）
 *   params … DEFAULT_PARAMS の形。patience=0 なら早期終了しない
 * 返り値 { trees, best: { round, ll }, curve: [{ round, fit, valid: [ll, ...] }] }（curve は毎ラウンド）
 */
export function trainBoost({ fit, valids = [], thresholds, feats, params = DEFAULT_PARAMS, seed = 12345, log = null, logEvery = 50 }) {
  const P = { ...DEFAULT_PARAMS, ...params };
  const rnd = makeRng(seed);
  const mFit = Float64Array.from(fit.base);
  const pFit = new Float64Array(fit.n);
  const mV = valids.map((v) => Float64Array.from(v.base));
  const pV = valids.map((v) => new Float64Array(v.n));
  const g = new Float64Array(fit.n);
  const h = new Float64Array(fit.n);
  const trees = [];
  const curve = [];
  let best = { round: 0, ll: valids.length ? softmax(valids[0], mV[0], pV[0]).ll : -Infinity };
  for (let round = 1; round <= P.rounds; round++) {
    plGradients(fit, mFit, g, h, P.topk, P.stageWeight);
    // レース単位で行をサンプリング、特徴量もサンプリング
    const idx = [];
    for (let ri = 0; ri < fit.races.length; ri++) if (rnd() < P.subsample) for (let i = fit.start[ri]; i < fit.start[ri + 1]; i++) idx.push(i);
    let fs = feats.filter(() => rnd() < P.colsample);
    if (!fs.length) fs = feats;
    const tree = buildTree(fit, g, h, idx, fs, thresholds, P);
    trees.push(tree);
    applyTree(tree, fit, mFit);
    const vs = valids.map((v, k) => {
      applyTree(tree, v, mV[k]);
      return softmax(v, mV[k], pV[k]);
    });
    curve.push({ round, valid: vs.map((v) => v.ll), top1: vs.map((v) => v.top1) });
    if (vs.length && vs[0].ll > best.ll + 1e-6) best = { round, ll: vs[0].ll };
    if (log && round % logEvery === 0) log(`round ${round}: 学習 ${softmax(fit, mFit, pFit).ll.toFixed(4)} ${vs.map((v, k) => `${k ? '検証' : '判定'} ${v.ll.toFixed(4)}`).join(' ')}`);
    if (P.patience && vs.length && round - best.round >= P.patience) {
      if (log) log(`早期終了（判定データが ${best.round} 以降よくならない）`);
      break;
    }
  }
  return { trees, best, curve };
}

/** 木の配列で評価：対数尤度・top1・確率・キャリブレーション */
export function evalTrees(trees, d, { scale = 1 } = {}) {
  const m = Float64Array.from(d.base);
  for (const t of trees) applyTree(t, d, m);
  if (scale !== 1) for (let i = 0; i < d.n; i++) m[i] = d.base[i] + (m[i] - d.base[i]) * scale;
  const p = new Float64Array(d.n);
  const r = softmax(d, m, p);
  const edges = [0, 0.03, 0.06, 0.1, 0.15, 0.2, 0.3, 0.45, 1.01];
  const cal = edges.slice(0, -1).map((lo, k) => ({ lo, hi: edges[k + 1], n: 0, sum: 0, win: 0 }));
  for (let i = 0; i < d.n; i++) {
    const b = cal.find((c) => p[i] >= c.lo && p[i] < c.hi);
    if (!b) continue;
    b.n++;
    b.sum += p[i];
    b.win += d.y[i];
  }
  return { ...r, cal, p, m };
}

/** 着順ごとの温度：1着はスコアそのまま、2着・3着以下は残りの馬の中で exp(スコア/T) に比例するとして T を推定 */
export function fitTemps(d, margin) {
  const temps = [];
  for (let stage = 0; stage < 3; stage++) {
    let best = { t: 1, ll: -Infinity };
    for (let t = 0.6; t <= 2.0001; t += 0.02) {
      let ll = 0;
      let cnt = 0;
      for (let ri = 0; ri < d.races.length; ri++) {
        const a = d.start[ri];
        const b = d.start[ri + 1];
        let target = -1;
        let mx = -Infinity;
        for (let i = a; i < b; i++) {
          if (d.finish[i] === stage + 1) target = i;
          if (d.finish[i] > stage || d.finish[i] === 0) mx = Math.max(mx, margin[i] / t);
        }
        if (target < 0) continue;
        let Z = 0;
        for (let i = a; i < b; i++) if (d.finish[i] > stage || d.finish[i] === 0) Z += Math.exp(margin[i] / t - mx);
        ll += margin[target] / t - mx - Math.log(Z);
        cnt++;
      }
      if (ll / cnt > best.ll) best = { t: +t.toFixed(2), ll: ll / cnt };
    }
    temps.push(best.t);
  }
  return temps;
}

/** 特徴量の重要度（分岐の回数と利得の合計） */
export function importance(trees, names) {
  const cnt = new Array(names.length).fill(0);
  const gain = new Array(names.length).fill(0);
  for (const t of trees)
    for (const nd of t)
      if (nd.leaf == null) {
        cnt[nd.f]++;
        gain[nd.f] += nd.gain || 0;
      }
  return names.map((k, f) => ({ name: k, count: cnt[f], gain: gain[f] })).sort((a, b) => b.gain - a.gain);
}

/** 書き出し用の木（[leaf] か [f, t, l, r]）。scale は葉の値に掛ける（複数モデルの平均用） */
export function compactTrees(trees, scale = 1) {
  return trees.map((t) => t.map((nd) => (nd.leaf != null ? [Math.round(nd.leaf * scale * 1e6) / 1e6 || 0] : [nd.f, Math.round(nd.t * 1e4) / 1e4, nd.l, nd.r])));
}

/** 日付の連続したブロックで k 分割（時間の近いレースが学習と判定の両方に入らないように） */
export function dateFolds(races, k) {
  const dates = [...new Set(races.map((rs) => rs[0].date))].sort();
  const folds = Array.from({ length: k }, () => []);
  const per = dates.length / k;
  const foldOfDate = new Map(dates.map((d, i) => [d, Math.min(k - 1, Math.floor(i / per))]));
  for (const rs of races) folds[foldOfDate.get(rs[0].date)].push(rs);
  return folds;
}

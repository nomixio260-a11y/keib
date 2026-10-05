// 発走前のオッズの推定（検証用）：過去のレースの検証は確定オッズ（発走後に決まる）で買い目を選んでしまう。
// 実際に買う時点（発走の10分前など）のオッズは、確定オッズからかなりずれる（締切直前に多くの票が入る）。
// 記録したオッズの推移（data ブランチの odds/）から「その時点 → 確定」のずれの標本を取り、確定オッズに足して
// 「その時点のオッズ」を作る。精算は実際の払戻のまま（払戻は確定オッズで決まる）。

/** 確定の単勝オッズの帯（ずれの大きさと向きは人気によって違う） */
export const driftBucket = (o) => (o < 3 ? 0 : o < 6 ? 1 : o < 12 ? 2 : o < 30 ? 3 : 4);

/**
 * ずれの標本：snapshots … オッズの推移の記録 [{ id, date, startTime, snapshots: [{ at, win: { 馬番: オッズ }, place: { 馬番: [下限, 上限] } }] }]
 * cardOf(id) … 確定オッズのついたレース（entries に odds・placeMin）。minutes … 発走の何分前の時点か
 * 返り値 [[確定の単勝オッズ, log(その時点 ÷ 確定)（単勝）, log(その時点 ÷ 確定)（複勝の下限。なければ null）]]
 */
export function driftSamples(snapshots, cardOf, minutes = 10) {
  const out = [];
  for (const doc of snapshots) {
    const card = cardOf(doc.id);
    if (!card || !doc.startTime || !doc.date) continue;
    const fin = new Map(card.entries.filter((e) => e.odds > 1).map((e) => [String(e.number), e]));
    const lim = Date.parse(`${doc.date}T${doc.startTime}:00+09:00`) - minutes * 60000;
    let snap = null;
    for (const s of doc.snapshots || []) if (Date.parse(s.at) <= lim) snap = s;
    if (!snap?.win) continue;
    for (const [num, o] of Object.entries(snap.win)) {
      const e = fin.get(num);
      if (!(o > 1) || !e) continue;
      const pl = snap.place?.[num];
      const pMin = Array.isArray(pl) ? pl[0] : null;
      out.push([e.odds, Math.log(o / e.odds), pMin > 1 && e.placeMin > 1 ? Math.log(pMin / e.placeMin) : null]);
    }
  }
  return out;
}

/** 標本から、レースごとに決まった乱数（seedStr）でオッズを揺らす関数を作る。馬連などは組み合わせの馬のずれの平均＋小さな独立のずれ */
export function makePerturber(samples, { exoticSd = 0.08 } = {}) {
  const pools = [0, 1, 2, 3, 4].map((b) => samples.filter((d) => driftBucket(d[0]) === b));
  const placePool = samples.filter((d) => d[2] != null);
  return function perturb(card, seedStr) {
    let h = 2166136261;
    for (let i = 0; i < seedStr.length; i++) h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619);
    let seed = (h >>> 0) % 2147483647 || 1;
    const rnd = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const c = structuredClone(card);
    const eps = new Map();
    for (const e of c.entries) {
      if (!(e.odds > 1)) continue;
      const pool = pools[driftBucket(e.odds)].length >= 5 ? pools[driftBucket(e.odds)] : samples;
      const d = pool[Math.floor(rnd() * pool.length)];
      eps.set(e.number, d[1]);
      e.odds = Math.max(1.0, e.odds * Math.exp(d[1]));
      const lp = d[2] != null ? d[2] : placePool.length ? placePool[Math.floor(rnd() * placePool.length)][2] : d[1] * 0.6;
      if (e.placeMin > 1) e.placeMin = Math.max(1.0, Math.round(e.placeMin * Math.exp(lp) * 10) / 10);
      if (e.placeMax > 1) e.placeMax = Math.max(e.placeMin || 1, Math.round(e.placeMax * Math.exp(lp) * 10) / 10);
    }
    // 単勝の控除（オッズの逆数の合計）は確定と同じに
    const s0 = card.entries.reduce((s, e) => s + (e.odds > 1 ? 1 / e.odds : 0), 0);
    const s1 = c.entries.reduce((s, e) => s + (e.odds > 1 ? 1 / e.odds : 0), 0);
    for (const e of c.entries) if (e.odds > 1) e.odds = Math.max(1.0, Math.round(e.odds * (s1 / s0) * 10) / 10);
    c.entries
      .filter((e) => e.odds > 1)
      .sort((a, b) => a.odds - b.odds)
      .forEach((e, i) => (e.popularity = i + 1));
    for (const kind of ['quinella', 'wide', 'trio', 'exacta', 'trifecta']) {
      const tab = c.exoticOdds?.[kind];
      if (!tab || typeof tab !== 'object') continue;
      for (const key of Object.keys(tab)) {
        const nums = key.split(/[->]/).map(Number);
        const m = nums.reduce((s, n) => s + (eps.get(n) || 0), 0) / nums.length;
        const v = tab[key];
        const f = Math.exp(m + exoticSd * gauss());
        tab[key] = Array.isArray(v) ? v.map((x) => Math.round(x * f * 10) / 10) : typeof v === 'number' ? Math.max(1, Math.round(v * f * 10) / 10) : v;
      }
    }
    return c;
  };
}

/** 標本の要約（画面・README 用）：頭数と、人気の帯ごとの |ずれ| の中央値 */
export function driftSummary(samples) {
  const med = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : null;
  };
  const fav = samples.filter((d) => d[0] < 5);
  return {
    horses: samples.length,
    medianAbs: med(samples.map((d) => Math.abs(d[1]))),
    favMedianAbs: med(fav.map((d) => Math.abs(d[1]))),
    placeMedianAbs: med(samples.filter((d) => d[2] != null).map((d) => Math.abs(d[2]))),
  };
}

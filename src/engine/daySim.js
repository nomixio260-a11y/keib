// その日の収支の見込み（シミュレーション）。
// 確定したレースは実際の収支、まだのレースは AI の1〜3着の並びの確率（厳密計算の triples・probs）から結果を引き、
// その日の買い目の払戻を出す。1日の損失の上限（その日の収支が −予算×倍数 以下なら、残りのレースは金額を半分）も
// 発走順に当てはめるので、上限で負けがどこまで抑えられるかがわかる。回数は「シミュレーション回数」（多いほど見込みが安定）。
// 払戻は買い目表と同じ見込み（複勝は下限〜上限の幅から、ほかはオッズ）。

import { createRng, hashString } from './rng.js';

/** 1〜3着の並び (a, b, c) で、買い目1点が当たるか */
function hits(t, a, b, c, placeCount) {
  const [x, y, z] = t.idx;
  switch (t.type) {
    case 'win':
      return a === x;
    case 'place':
      return placeCount >= 3 ? x === a || x === b || x === c : x === a || x === b;
    case 'quinella':
      return (a === x && b === y) || (a === y && b === x);
    case 'wide': {
      const top = [a, b, c];
      return top.includes(x) && top.includes(y);
    }
    case 'exacta':
      return a === x && b === y;
    case 'trio': {
      const top = [a, b, c];
      return top.includes(x) && top.includes(y) && top.includes(z);
    }
    case 'trifecta':
      return a === x && b === y && c === z;
    default:
      return false;
  }
}

/** 1点100円あたりの払戻の見込み（複勝は下限〜上限の幅から：oddsExp があればそれ） */
const payoutOdds = (t) => t.oddsExp || t.odds || 0;

/**
 * まだのレースの、並びごとの払戻（金額そのまま、元本込み）を前計算する。
 * tickets … 通常の金額の買い目、cutTickets … 損失の上限に達したときの買い目（金額が半分・点数が減ることもある）
 */
export function raceOutcomes(pred, tickets, cutTickets = tickets) {
  const ex = pred.exact;
  if (!ex?.probs?.length) return null;
  const k = ex.probs.length;
  const cum = new Float64Array(k);
  let s = 0;
  for (let i = 0; i < k; i++) {
    s += ex.probs[i];
    cum[i] = s;
  }
  const retOf = (list) => {
    const ret = new Float64Array(k);
    for (let i = 0; i < k; i++) {
      const a = ex.triples[i * 3];
      const b = ex.triples[i * 3 + 1];
      const c = ex.triples[i * 3 + 2];
      let r = 0;
      for (const t of list) if (hits(t, a, b, c, pred.placeCount)) r += t.stake * payoutOdds(t);
      ret[i] = r;
    }
    return ret;
  };
  const stakeOf = (list) => list.reduce((a, t) => a + t.stake, 0);
  return { cum, total: s, full: { stake: stakeOf(tickets), ret: retOf(tickets) }, cut: { stake: stakeOf(cutTickets), ret: retOf(cutTickets) } };
}

/**
 * items … 発走順の配列。{ settled: true, pnl, pnlNoLimit }（確定：実際の収支と、上限なしならの収支）か { settled: false, out: raceOutcomes(...) }（まだ）
 * limit … 1日の損失の上限（円、0 ならなし）。確定したレースの収支も上限の判定に使う
 * 返り値：平均・プラスになる確率・悪いほうから10%・5%・最悪・上限に達する確率（上限なしのときの値も）
 */
export function simulateDay(items, { sims = 20000, seed = 'day', limit = 0 } = {}) {
  const live = items.filter((x) => !x.settled && x.out);
  const n = Math.max(1, Math.floor(sims));
  const rng = createRng(hashString(String(seed))).next;
  const run = (useLimit) => {
    const res = new Float64Array(n);
    let reached = 0;
    for (let s = 0; s < n; s++) {
      let pnl = 0;
      let cut = false;
      for (const it of items) {
        if (useLimit && limit > 0 && !cut && pnl <= -limit) cut = true;
        if (it.settled) {
          pnl += useLimit ? it.pnl : it.pnlNoLimit ?? it.pnl;
          continue;
        }
        if (!it.out) continue;
        const o = it.out;
        const side = cut ? o.cut : o.full;
        if (!side.stake) continue;
        const u = rng() * o.total;
        let lo = 0;
        let hi = o.cum.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (o.cum[mid] < u) lo = mid + 1;
          else hi = mid;
        }
        pnl += side.ret[lo] - side.stake;
      }
      if (cut) reached++;
      res[s] = pnl;
    }
    const sorted = Float64Array.from(res).sort();
    const q = (p) => sorted[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
    let sum = 0;
    let plus = 0;
    for (const v of res) {
      sum += v;
      if (v > 0) plus++;
    }
    return { mean: sum / n, plusRate: plus / n, q10: q(0.1), q05: q(0.05), worst: sorted[0], best: sorted[n - 1], reachRate: reached / n };
  };
  return { sims: n, races: live.length, withLimit: run(true), noLimit: run(false) };
}

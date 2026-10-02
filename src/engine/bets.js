// 買い目：期待値の計算、推奨買い目の選定と資金配分、印からのフォーメーション。

import { BET_LABEL, BET_TYPES } from './constants.js';
import { estimateOdds } from './market.js';

export const STRATEGIES = {
  hit: { label: '的中重視', desc: '当たりやすさを優先。どれが当たっても払戻がそろうように配分します。', minEv: 0.8, maxTickets: 6, alloc: 'equal' },
  balance: { label: 'バランス', desc: '期待値1.0以上の買い目から、確率とのバランスで選びます。', minEv: 1.0, maxTickets: 8, alloc: 'kelly' },
  value: { label: '高配当', desc: '期待値の高い穴目を中心に。当たる回数は少なめです。', minEv: 1.15, maxTickets: 10, alloc: 'kelly' },
};

// 戦略ごとの最低的中確率（これ未満の買い目は候補にしない）
const MIN_P = {
  hit: { win: 0.22, place: 0.45, quinella: 0.07, wide: 0.18, exacta: 0.04, trio: 0.035, trifecta: 0.01 },
  balance: { win: 0.08, place: 0.22, quinella: 0.025, wide: 0.07, exacta: 0.013, trio: 0.01, trifecta: 0.0025 },
  value: { win: 0.03, place: 0.1, quinella: 0.008, wide: 0.025, exacta: 0.004, trio: 0.003, trifecta: 0.0008 },
};

const SCORE = {
  hit: (c) => c.p * Math.min(c.ev, 1.3),
  balance: (c) => c.p * (c.ev - 0.85),
  value: (c) => (c.ev - 1) * Math.sqrt(c.p),
};

/** ワイドは8頭以上のレースのみ扱う（複勝と同じく3着までが対象になる頭数） */
const typeAvailable = (type, pred) => {
  if (type === 'place') return pred.placeCount > 0;
  if (type === 'wide') return pred.n >= 8;
  if (type === 'quinella' || type === 'exacta') return pred.n >= 2;
  if (type === 'trio' || type === 'trifecta') return pred.n >= 3;
  return true;
};

/**
 * 買い目1点の確率・推定オッズ・期待値。idx は pred.rows のインデックス。
 * blend は期待値の計算で市場（オッズ）の確率を混ぜる割合（0〜1）。
 * AIとオッズの見立てがずれた馬券ほど期待値が過大に出る（勝者の呪い）のを抑える。
 */
export function priceTicket(t, pred, blend = 0) {
  const { rows, combos, market, placeCount, n } = pred;
  const [x, y, z] = t.idx;
  let p = 0;
  let pm = 0;
  let odds = null;
  let oddsMax = null;
  switch (t.type) {
    case 'win':
      p = rows[x].pWin;
      pm = rows[x].marketProb;
      odds = rows[x].odds;
      break;
    case 'place':
      p = placeCount >= 3 ? rows[x].pTop3 : rows[x].pTop2;
      pm = placeCount >= 3 ? market.top3[x] : market.top2[x];
      // 実際の複勝オッズ（JRA の下限〜上限）があれば、控えめに下限を使う
      if (rows[x].entry.placeMin > 1) {
        odds = rows[x].entry.placeMin;
        oddsMax = rows[x].entry.placeMax > 1 ? rows[x].entry.placeMax : null;
      }
      break;
    case 'quinella':
    case 'wide': {
      const k = Math.min(x, y) * n + Math.max(x, y);
      p = combos[t.type][k];
      pm = market[t.type][k];
      break;
    }
    case 'exacta':
      p = combos.exacta[x * n + y];
      pm = market.exacta[x * n + y];
      break;
    case 'trio': {
      const [a, b, c] = [x, y, z].sort((u, v) => u - v);
      p = combos.trio[(a * n + b) * n + c];
      pm = market.trio[(a * n + b) * n + c];
      break;
    }
    case 'trifecta':
      p = combos.trifecta[(x * n + y) * n + z];
      pm = market.trifecta[(x * n + y) * n + z];
      break;
    default:
      break;
  }
  const estimated = odds == null;
  if (odds == null) odds = estimateOdds(t.type, pm);
  const pEv = (1 - blend) * p + blend * pm;
  return {
    ...t,
    nums: t.idx.map((i) => rows[i].entry.number),
    p,
    pMarket: pm,
    pEv,
    odds,
    oddsMax,
    estimated,
    ev: odds ? pEv * odds : 0,
  };
}

/** 買い目の表記 3-7 / 7→3 / 3-7-11 */
export function ticketLabel(t) {
  if (t.type === 'exacta' || t.type === 'trifecta') return t.nums.join('→');
  if (t.type === 'quinella' || t.type === 'wide' || t.type === 'trio') return [...t.nums].sort((a, b) => a - b).join('-');
  return String(t.nums[0]);
}

/** 候補となる買い目をすべて列挙（組み合わせ系は上位人気ではなく AI 上位の馬から） */
export function buildCandidates(pred, types = BET_TYPES, blend = 0) {
  const { rows, n } = pred;
  const byP = rows.map((r, i) => i).sort((a, b) => rows[b].pWin - rows[a].pWin);
  const pairPool = byP.slice(0, Math.min(n, 7));
  const trioPool = byP.slice(0, Math.min(n, 6));
  const star = rows.findIndex((r) => r.mark === '☆');
  if (star >= 0) {
    if (!pairPool.includes(star)) pairPool.push(star);
    if (!trioPool.includes(star)) trioPool.push(star);
  }
  const out = [];
  const want = (type) => types.includes(type) && typeAvailable(type, pred);
  const add = (type, idx) => {
    const t = priceTicket({ type, idx }, pred, blend);
    if (t.p > 0 && t.odds) out.push(t);
  };
  for (let i = 0; i < n; i++) {
    if (want('win') && rows[i].odds) add('win', [i]);
    if (want('place')) add('place', [i]);
  }
  for (let a = 0; a < pairPool.length; a++) {
    for (let b = a + 1; b < pairPool.length; b++) {
      const [x, y] = [pairPool[a], pairPool[b]].sort((u, v) => u - v);
      if (want('quinella')) add('quinella', [x, y]);
      if (want('wide')) add('wide', [x, y]);
      if (want('exacta')) {
        add('exacta', [x, y]);
        add('exacta', [y, x]);
      }
    }
  }
  if (want('trio') || want('trifecta')) {
    for (let a = 0; a < trioPool.length; a++) {
      for (let b = a + 1; b < trioPool.length; b++) {
        for (let c = b + 1; c < trioPool.length; c++) {
          const tri = [trioPool[a], trioPool[b], trioPool[c]];
          if (want('trio')) add('trio', [...tri].sort((u, v) => u - v));
          if (want('trifecta')) {
            const [x, y, z] = tri;
            for (const perm of [
              [x, y, z],
              [x, z, y],
              [y, x, z],
              [y, z, x],
              [z, x, y],
              [z, y, x],
            ])
              add('trifecta', perm);
          }
        }
      }
    }
  }
  return out;
}

/** 予算を100円単位で配分。equal = 払戻均等、kelly = ケリー基準に比例 */
export function allocate(tickets, budget, mode) {
  const units = Math.floor(budget / 100);
  if (!tickets.length || units <= 0) {
    tickets.forEach((t) => {
      t.stake = 0;
    });
    return tickets;
  }
  // 予算より点数が多いときは上位だけ残す
  const list = tickets.slice(0, units);
  const weights = list.map((t) =>
    mode === 'equal' ? 1 / t.odds : Math.max(0.002, (t.p * t.odds - 1) / Math.max(0.01, t.odds - 1)),
  );
  const W = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (w / W) * units);
  const alloc = raw.map((r) => Math.max(1, Math.floor(r)));
  let used = alloc.reduce((a, b) => a + b, 0);
  while (used > units) {
    let k = -1;
    for (let i = 0; i < alloc.length; i++) if (alloc[i] > 1 && (k < 0 || alloc[i] - raw[i] > alloc[k] - raw[k])) k = i;
    if (k < 0) break;
    alloc[k]--;
    used--;
  }
  const rem = raw.map((r, i) => r - alloc[i]);
  while (used < units) {
    let k = 0;
    for (let i = 1; i < rem.length; i++) if (rem[i] > rem[k]) k = i;
    alloc[k]++;
    rem[k] -= 1;
    used++;
  }
  tickets.forEach((t, i) => {
    t.stake = i < list.length ? alloc[i] * 100 : 0;
  });
  return tickets;
}

/** 推奨買い目 */
/** 期待値の計算でオッズ（市場）の確率を混ぜる既定の割合 */
export const DEFAULT_BLEND = 0.5;

/**
 * 既定の買い方：的中重視 × 単勝・複勝。
 * 実データの検証（学習に使っていない864レース）で、オッズが実際にわかる単勝・複勝は
 * 期待回収率と実際の回収率がほぼ一致した（的中重視：期待87% → 実際92%）。
 * 馬連〜三連単はオッズを単勝から推定するしかなく、期待値で選ぶと実際の払戻が見込みを大きく下回った
 * （バランス：期待112% → 実際43%）ので、初期状態では使わない。
 */
export const DEFAULT_STRATEGY = 'hit';
export const DEFAULT_TYPES = ['win', 'place'];
/** オッズを推定するしかない券種（複勝は実際のオッズがないときだけ推定） */
export const ESTIMATED_TYPES = ['quinella', 'wide', 'exacta', 'trio', 'trifecta'];

export const BLEND_OPTIONS = [
  { value: 0, label: '混ぜない（AIのみ）' },
  { value: 0.3, label: '30%' },
  { value: 0.5, label: '50%（標準）' },
  { value: 0.7, label: '70%' },
];

export function recommendBets(pred, { budget = 3000, strategy = DEFAULT_STRATEGY, types = DEFAULT_TYPES, blend = DEFAULT_BLEND } = {}) {
  const st = STRATEGIES[strategy] || STRATEGIES.balance;
  // オッズが出るまでは期待値を計算できない
  if (pred.noOdds) return { strategy, budget, tickets: [], candidates: 0, noOdds: true, stats: evaluateTickets([], pred) };
  const minP = MIN_P[strategy] || MIN_P.balance;
  const score = SCORE[strategy] || SCORE.balance;
  const cands = buildCandidates(pred, types, blend).filter((c) => c.ev >= st.minEv && c.pEv >= minP[c.type]);
  cands.sort((a, b) => score(b) - score(a));
  const picked = [];
  const perType = {};
  for (const c of cands) {
    if (picked.length >= st.maxTickets) break;
    if ((perType[c.type] || 0) >= 3) continue;
    picked.push(c);
    perType[c.type] = (perType[c.type] || 0) + 1;
  }
  allocate(picked, budget, st.alloc);
  const tickets = picked.filter((t) => t.stake > 0);
  tickets.sort((a, b) => BET_TYPES.indexOf(a.type) - BET_TYPES.indexOf(b.type) || b.stake - a.stake);
  return { strategy, budget, tickets, candidates: cands.length, stats: evaluateTickets(tickets, pred) };
}

/** 着順（rows のインデックス a,b,c）に対して買い目が当たっているか */
export function ticketHits(t, a, b, c, placeCount = 3) {
  const [x, y, z] = t.idx;
  const inTop3 = (v) => v === a || v === b || v === c;
  switch (t.type) {
    case 'win':
      return x === a;
    case 'place':
      return x === a || x === b || (placeCount >= 3 && x === c);
    case 'quinella':
      return (x === a && y === b) || (x === b && y === a);
    case 'wide':
      return inTop3(x) && inTop3(y);
    case 'exacta':
      return x === a && y === b;
    case 'trio':
      return inTop3(x) && inTop3(y) && inTop3(z);
    case 'trifecta':
      return x === a && y === b && z === c;
    default:
      return false;
  }
}

/**
 * 的中率・プラス収支の確率はAIのシミュレーションの各回に買い目を当てはめて数える。
 * 期待回収率は各買い目の「期待値の計算に使う確率」（pEv、オッズを混ぜたもの）から出す。
 */
export function evaluateTickets(tickets, pred) {
  const stake = tickets.reduce((s, t) => s + (t.stake || 0), 0);
  if (!tickets.length || !stake) return { stake: 0, hitRate: 0, expectedReturn: 0, roi: 0, profitRate: 0 };
  const { samples, sims } = pred.sim;
  let hit = 0;
  let profit = 0;
  for (let s = 0; s < sims; s++) {
    const a = samples[s * 3];
    const b = samples[s * 3 + 1];
    const c = samples[s * 3 + 2];
    let ret = 0;
    for (const t of tickets) if (t.stake && ticketHits(t, a, b, c, pred.placeCount)) ret += t.stake * t.odds;
    if (ret > 0) hit++;
    if (ret > stake) profit++;
  }
  const expectedReturn = tickets.reduce((s, t) => s + (t.stake || 0) * (t.odds || 0) * (t.pEv ?? t.p), 0);
  return { stake, hitRate: hit / sims, expectedReturn, roi: expectedReturn / stake, profitRate: profit / sims };
}

/** 印 → 馬のインデックス */
export function marksToIndex(pred) {
  const m = { '◎': -1, '○': -1, '▲': -1, '☆': -1, '△': [] };
  pred.rows.forEach((r, i) => {
    if (r.mark === '△') m['△'].push(i);
    else if (r.mark) m[r.mark] = i;
  });
  return m;
}

const pair = (a, b) => [a, b].sort((u, v) => u - v);

/** 印を使った定番フォーメーション */
export const FORMATIONS = [
  { key: 'win', label: '単勝 ◎', build: (m) => [{ type: 'win', idx: [m.h] }] },
  { key: 'place', label: '複勝 ◎', build: (m) => [{ type: 'place', idx: [m.h] }] },
  { key: 'quinella', label: '馬連 ◎ 流し（相手 ○▲△☆）', build: (m) => m.p5.map((o) => ({ type: 'quinella', idx: pair(m.h, o) })) },
  { key: 'wide', label: 'ワイド ◎ 流し（相手 ○▲△）', build: (m) => m.p4.map((o) => ({ type: 'wide', idx: pair(m.h, o) })) },
  { key: 'exacta', label: '馬単 ◎ 1着流し（相手 ○▲△）', build: (m) => m.p4.map((o) => ({ type: 'exacta', idx: [m.h, o] })) },
  {
    key: 'trio-axis',
    label: '三連複 ◎ 1頭軸流し（相手 ○▲△☆）',
    build: (m) => {
      const out = [];
      for (let i = 0; i < m.p5.length; i++)
        for (let j = i + 1; j < m.p5.length; j++) out.push({ type: 'trio', idx: [m.h, m.p5[i], m.p5[j]].sort((u, v) => u - v) });
      return out;
    },
  },
  {
    key: 'trio-box',
    label: '三連複 BOX（◎○▲△）',
    build: (m) => {
      const box = [m.h, ...m.p4.slice(0, 3)];
      const out = [];
      for (let i = 0; i < box.length; i++)
        for (let j = i + 1; j < box.length; j++)
          for (let k = j + 1; k < box.length; k++) out.push({ type: 'trio', idx: [box[i], box[j], box[k]].sort((u, v) => u - v) });
      return out;
    },
  },
  {
    key: 'trifecta',
    label: '三連単 ◎→○▲→○▲△',
    build: (m) => {
      const second = m.p4.slice(0, 2);
      const third = m.p4;
      const out = [];
      for (const s of second) for (const t of third) if (t !== s) out.push({ type: 'trifecta', idx: [m.h, s, t] });
      return out;
    },
  },
];

/** フォーメーションごとの点数・的中率・期待回収率（1点100円） */
export function evaluateFormations(pred, blend = DEFAULT_BLEND) {
  const mk = marksToIndex(pred);
  if (mk['◎'] < 0 || pred.noOdds) return [];
  const p4 = [mk['○'], mk['▲'], ...mk['△']].filter((v) => v >= 0);
  const p5 = mk['☆'] >= 0 ? [...p4, mk['☆']] : p4;
  const m = { h: mk['◎'], p4, p5 };
  return FORMATIONS.map((f) => {
    const type = f.build(m)[0]?.type;
    if (!type || !typeAvailable(type, pred)) return null;
    const tickets = f.build(m).map((t) => ({ ...priceTicket(t, pred, blend), stake: 100 }));
    if (!tickets.length || tickets.some((t) => !t.odds)) return null;
    return { key: f.key, label: f.label, tickets, points: tickets.length, ...evaluateTickets(tickets, pred) };
  }).filter(Boolean);
}

/** 買い目をテキストに（コピー用） */
export function ticketsToText(title, tickets) {
  const lines = [title];
  for (const t of tickets) lines.push(`${BET_LABEL[t.type]} ${ticketLabel(t)}  ${t.stake.toLocaleString('ja-JP')}円`);
  const total = tickets.reduce((s, t) => s + t.stake, 0);
  lines.push(`合計 ${total.toLocaleString('ja-JP')}円`);
  return lines.join('\n');
}

// 買い目：期待値の計算、推奨買い目の選定と資金配分、印からのフォーメーション。

import { BET_LABEL, BET_TYPES } from './constants.js';
import { estimateOdds } from './market.js';
import { AUTO_POLICY, POLICY_FORMS } from './volatility.js';
import { exactPL } from './simulate.js';

/**
 * 買い目の選定（期待値・最低的中確率・並べ替え）に使う勝率の「平らさ」。予想の勝率（着順の温度）をこの倍率で平らにしてから選ぶ。
 * 予想そのもの（一覧の勝率・自信度・荒れ度）は平らにしない。利用者の指摘（荒れ度 1.2 のほうが成績が良い）を、
 * 学習期間の分割外 11,991レースと検証期間 887レースの実際の払戻で確かめて採用（scratchpad/oof-bets.mjs・setting-check.mjs）。
 * 買い方ごと（学習期間の分割外・単勝/複勝）：的中重視 90.9% → 94.6%、控えめ 92.5% → 93.6% で採用。バランス・高配当は 1（STRATEGIES の betTemp）。
 */
export const BET_TEMP = 1.2;

/** 買い目を選ぶための予想（勝率・連対率・複勝率・券種の確率を温度 temp で平らにしたもの）。temp=1 ならそのまま */
export function betView(pred, temp = BET_TEMP) {
  if (!temp || temp === 1 || !pred?.temps || !pred.rows?.length) return pred;
  const cache = pred._betViews || (pred._betViews = new Map());
  if (cache.has(temp)) return cache.get(temp);
  const ex = exactPL(
    pred.rows.map((r) => r.score),
    { temps: pred.temps.map((t) => t * temp) },
  );
  const view = { ...pred, rows: pred.rows.map((r, i) => ({ ...r, pWin: ex.win[i], pTop2: ex.top2[i], pTop3: ex.top3[i] })), combos: ex.combos, betTemp: temp };
  cache.set(temp, view);
  return view;
}

export const STRATEGIES = {
  // 的中重視・控えめ：期待値は AI の確率だけで計算し（blend 0）、0.9 以上の買い目だけ買う。学習期間の分割外（約1.2万レース・186週）と
  // 検証期間（14週）の両方で、0.5 混合・0.8 以上より回収率も週の収支も良かった（scratchpad/oof-grid*.mjs。README の開発日記）。
  // minOdds（的中重視だけ）：オッズ 1.0 倍の買い目（当たっても元返し）は買わない（週の収支は変わらず、回収率は学習期間 107.2→107.5%・検証期間 127.8→129.2%。
  // 控えめでは両方の期間でわずかに下がったので付けない）
  // keepMinP：買い目を決めたあと、当たる確率（平らにしない元の予想）がこれ以上のものだけ残す2段目。学習期間の分割外 186週で
  // 的中率 52% → 76%、最大の落ち込み −23,150円 → −7,600円、回収率 107.5% → 105.4%（検証14週：93%・147.5%）。README の開発日記
  hit: { label: '的中重視', desc: '当たりやすさを優先。AI の見立てで期待値が 0.9 以上の買い目を選び、そこから当たる確率が 50% 以上のものだけを買います。どれが当たっても払戻がそろうように配分します。', minEv: 0.9, blend: 0, minOdds: 1.05, keepMinP: 0.5, maxTickets: 6, alloc: 'equal' },
  // betTemp：買い目の選定で勝率を平らにする倍率（既定 BET_TEMP）。バランス・高配当は学習期間の分割外で良くならなかった（バランス −8.3 ± 11.2pt、高配当は買うレースが少なく判断できない）ので 1
  balance: { label: 'バランス', desc: '期待値1.0以上の買い目から、確率とのバランスで選びます。', minEv: 1.0, maxTickets: 8, alloc: 'kelly', betTemp: 1 },
  value: { label: '高配当', desc: '期待値の高い穴目を中心に。当たる回数は少なめです。', minEv: 1.15, maxTickets: 10, alloc: 'kelly', betTemp: 1 },
  careful: {
    label: '控えめ',
    desc: '自信度 S のレースだけ、単勝・複勝を1〜2点。それ以外のレースは見送ります。買う回数を大きく減らして損失を抑える買い方で、利益が出るわけではありません（検証では回収率 98〜99% 前後）。',
    minEv: 0.9,
    blend: 0,
    keepMinP: 0.5,
    maxTickets: 2,
    alloc: 'equal',
    grades: ['S'],
    onlyTypes: ['win', 'place'],
  },
  auto: {
    label: '自動調整',
    desc: '荒れ度（堅い・普通・荒れ）に合わせて、◎の買い方を自動で切り替えます。区分ごとの買い方は、学習期間の実際の払戻で回収率が最も良かったもの（scripts/fit-volatility.mjs）。予算はその買い方の点数で等分します。',
    minEv: 0,
    maxTickets: 6,
    alloc: 'equal',
    auto: true,
  },
};

// 戦略ごとの最低的中確率（これ未満の買い目は候補にしない）
const MIN_P = {
  hit: { win: 0.22, place: 0.45, quinella: 0.07, wide: 0.18, exacta: 0.04, trio: 0.035, trifecta: 0.01 },
  balance: { win: 0.08, place: 0.22, quinella: 0.025, wide: 0.07, exacta: 0.013, trio: 0.01, trifecta: 0.0025 },
  value: { win: 0.03, place: 0.1, quinella: 0.008, wide: 0.025, exacta: 0.004, trio: 0.003, trifecta: 0.0008 },
  careful: { win: 0.22, place: 0.45, quinella: 1, wide: 1, exacta: 1, trio: 1, trifecta: 1 },
};

const SCORE = {
  hit: (c) => c.p * Math.min(c.ev, 1.3),
  balance: (c) => c.p * (c.ev - 0.85),
  value: (c) => (c.ev - 1) * Math.sqrt(c.p),
  careful: (c) => c.p * Math.min(c.ev, 1.3),
};

/** ワイドは8頭以上のレースのみ扱う（複勝と同じく3着までが対象になる頭数） */
const typeAvailable = (type, pred) => {
  if (type === 'place') return pred.placeCount > 0;
  if (type === 'wide') return pred.n >= 8;
  if (type === 'quinella' || type === 'exacta') return pred.n >= 2;
  if (type === 'trio' || type === 'trifecta') return pred.n >= 3;
  return true;
};

/** 実際の馬連・ワイド・3連複オッズ（race.exoticOdds、JRA のオッズページ）があれば返す。なければ null */
function realExotic(pred, type, idx) {
  const table = pred.race?.exoticOdds?.[type];
  if (!table) return null;
  const key = idx
    .map((i) => pred.rows[i].entry.number)
    .sort((a, b) => a - b)
    .join('-');
  const v = table[key];
  return v > 1 ? v : null;
}

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
      odds = realExotic(pred, t.type, [x, y]);
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
      odds = realExotic(pred, 'trio', [x, y, z]);
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
/** 期待値の計算でオッズ（市場）の確率を混ぜる割合の標準（買い方に標準がないとき・印のフォーメーション） */
export const DEFAULT_BLEND = 0.5;

/** 期待値に混ぜる割合：'auto'（既定）は買い方ごとの標準（的中重視・控えめは 0、ほかは DEFAULT_BLEND）。数値ならそのまま */
export function resolveBlend(blend, strategy = null) {
  if (blend == null || blend === '' || blend === 'auto') return STRATEGIES[strategy]?.blend ?? DEFAULT_BLEND;
  const v = Number(blend);
  return Number.isFinite(v) ? v : DEFAULT_BLEND;
}

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

/** 2段目の絞り込み（当たる確率の下限）：'auto'（既定）は買い方ごとの標準（的中重視・控えめは 50%、ほかは絞らない） */
export function resolveKeep(keep, strategy = null) {
  if (keep == null || keep === '' || keep === 'auto') return STRATEGIES[strategy]?.keepMinP ?? 0;
  const v = Number(keep);
  return Number.isFinite(v) ? v : 0;
}

export const KEEP_OPTIONS = [
  { value: 'auto', label: '買い方の標準（的中重視・控えめは50%以上）' },
  { value: 0, label: '絞らない' },
  { value: 0.3, label: '30%以上（収支を重く見る）' },
  { value: 0.5, label: '50%以上' },
  { value: 0.7, label: '70%以上（当たり重視）' },
];

export const BLEND_OPTIONS = [
  { value: 'auto', label: '買い方の標準（的中重視・控えめは混ぜない、ほかは50%）' },
  { value: 0, label: '混ぜない（AIのみ）' },
  { value: 0.3, label: '30%' },
  { value: 0.5, label: '50%' },
  { value: 0.7, label: '70%' },
];

export function recommendBets(pred, { budget = 3000, strategy = DEFAULT_STRATEGY, types = DEFAULT_TYPES, blend: blendIn = 'auto', betTemp = null, keep = 'auto' } = {}) {
  const st = STRATEGIES[strategy] || STRATEGIES.balance;
  const blend = resolveBlend(blendIn, strategy);
  // オッズが出るまでは期待値を計算できない
  if (pred.noOdds) return { strategy, budget, tickets: [], candidates: 0, noOdds: true, stats: evaluateTickets([], pred) };
  // 自信度の条件（控えめ）：条件に合わないレースは見送り
  if (st.grades && !st.grades.includes(pred.confidence?.grade)) return { strategy, budget, tickets: [], candidates: 0, skipped: true, stats: evaluateTickets([], pred) };
  // 自動調整：荒れ度の区分ごとに決めた買い方（モデルがなければ的中重視と同じ）
  if (st.auto) {
    const form = AUTO_POLICY?.[pred.confidence?.volatility];
    if (form === 'skip') return { strategy, budget, tickets: [], candidates: 0, skipped: true, skipReason: `荒れ度「${pred.confidence.volatility}」のレースは見送り`, form, formLabel: '見送り', stats: evaluateTickets([], pred) };
    if (form && POLICY_FORMS[form]) {
      const marks = pred.rows.map((r, i) => i).sort((a, b) => pred.rows[b].pWin - pred.rows[a].pWin);
      const unordered = new Set(['quinella', 'wide', 'trio']);
      const raw = POLICY_FORMS[form].build(marks, pred.placeCount, pred.n).map((t) => ({ ...t, idx: unordered.has(t.type) ? [...t.idx].sort((a, b) => a - b) : t.idx }));
      const each = Math.max(100, Math.floor(budget / Math.max(1, raw.length) / 100) * 100);
      const tickets = raw.map((t) => ({ ...priceTicket(t, pred, blend), stake: each }));
      return { strategy, budget, tickets, candidates: tickets.length, form, formLabel: POLICY_FORMS[form].label, stats: evaluateTickets(tickets, pred) };
    }
    return recommendBets(pred, { budget, strategy: 'hit', types, blend: blendIn, betTemp, keep });
  }
  if (st.onlyTypes) types = types.filter((t) => st.onlyTypes.includes(t));
  const minP = MIN_P[strategy] || MIN_P.balance;
  const score = SCORE[strategy] || SCORE.balance;
  // 候補は少し平らにした勝率で評価する（betTemp。的中率・期待値の表示もこの値。どれかが当たる確率は元の予想で計算）
  const view = betView(pred, betTemp ?? st.betTemp ?? BET_TEMP);
  const cands = buildCandidates(view, types, blend).filter((c) => c.ev >= st.minEv && c.pEv >= minP[c.type] && c.odds >= (st.minOdds ?? 0));
  cands.sort((a, b) => score(b) - score(a));
  const picked = [];
  const perType = {};
  for (const c of cands) {
    if (picked.length >= st.maxTickets) break;
    if ((perType[c.type] || 0) >= 3) continue;
    picked.push(c);
    perType[c.type] = (perType[c.type] || 0) + 1;
  }
  // 2段目：決めた買い目から、当たる確率（平らにしない元の予想）が下限以上のものだけを残す（外した分の予算は残りに配り直す）
  const keepMinP = resolveKeep(keep, strategy);
  for (const t of picked) t.pHit = priceTicket({ type: t.type, idx: t.idx }, pred, 0).p;
  const kept = keepMinP > 0 ? picked.filter((t) => t.pHit >= keepMinP) : picked;
  const dropped = keepMinP > 0 ? picked.filter((t) => t.pHit < keepMinP) : [];
  allocate(kept, budget, st.alloc);
  const tickets = kept.filter((t) => t.stake > 0);
  tickets.sort((a, b) => BET_TYPES.indexOf(a.type) - BET_TYPES.indexOf(b.type) || b.stake - a.stake);
  dropped.forEach((t) => {
    t.stake = 0;
  });
  return { strategy, budget, tickets, dropped, keepMinP, candidates: cands.length, stats: evaluateTickets(tickets, pred) };
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
 * 的中率・プラス収支の確率は、1〜3着のすべての並びの確率（exactPL）に買い目を当てはめて厳密に出す。
 * （厳密計算がないときはシミュレーションの各回に当てはめて数える）
 * 期待回収率は各買い目の「期待値の計算に使う確率」（pEv、オッズを混ぜたもの）から出す。
 */
export function evaluateTickets(tickets, pred) {
  const stake = tickets.reduce((s, t) => s + (t.stake || 0), 0);
  if (!tickets.length || !stake) return { stake: 0, hitRate: 0, expectedReturn: 0, roi: 0, profitRate: 0 };
  let hit = 0;
  let profit = 0;
  let sims = 1;
  if (pred.exact?.triples) {
    const { triples, probs } = pred.exact;
    for (let k = 0; k < probs.length; k++) {
      const a = triples[k * 3];
      const b = triples[k * 3 + 1];
      const c = triples[k * 3 + 2];
      let ret = 0;
      for (const t of tickets) if (t.stake && ticketHits(t, a, b, c, pred.placeCount)) ret += t.stake * t.odds;
      if (ret > 0) hit += probs[k];
      if (ret > stake) profit += probs[k];
    }
  } else {
    const { samples } = pred.sim;
    sims = pred.sim.sims;
    for (let s = 0; s < sims; s++) {
      const a = samples[s * 3];
      const b = samples[s * 3 + 1];
      const c = samples[s * 3 + 2];
      let ret = 0;
      for (const t of tickets) if (t.stake && ticketHits(t, a, b, c, pred.placeCount)) ret += t.stake * t.odds;
      if (ret > 0) hit++;
      if (ret > stake) profit++;
    }
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
export function evaluateFormations(pred, blendIn = DEFAULT_BLEND) {
  const blend = resolveBlend(blendIn, null);
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

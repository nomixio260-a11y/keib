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

/**
 * どの買い方でも、オッズがこれ未満の買い目は買わない（JRA のオッズは 0.1 倍刻みなので「1.1 倍以下は買わない」）。
 * 1.1 倍の複勝は9割当たるが、当たっても1割しか増えず、外れるとその日がそのまま負けになる。学習期間の分割外（385日）で
 * 的中重視の 1.1 倍の複勝は 327点・的中 90%・回収率 99%（利益なし）で、負けた日の主な原因だった。買わないと（1R 3,000円）
 * 的中重視 回収率 105.4% → 111.3%・負けた日 105 → 95日、自動調整 104.8% → 115.3%・63 → 42日、控えめ 101.9% → 118.3%・49 → 16日、
 * 検証期間（30日）でも 147.5% → 203.3%・116.5% → 162.2%・98.6% → 135.0%、負けた日はどれも 0日に。
 * 的中率は学習期間では下がる（的中重視 76% → 63%）が、検証期間では上がる（93% → 100%）。README の開発日記 2026-10-05
 * オッズを使わない予想（AI単独）だけは以前のまま（minOddsAi：的中重視・自動調整 1.05、ほかはなし）。AI単独で外すと検証期間の
 * 的中率が下がり（的中重視 48.2% → 41.8%）、回収率は変わらなかった（77.1% → 77.2%）
 */
export const MIN_ODDS = 1.15;
/** 画面の表記（MIN_ODDS 未満 = 0.1 倍刻みで 1.1 倍以下） */
export const LOW_ODDS_LABEL = '1.1 倍以下';

/**
 * 的中重視の「自動」（当たる確率で絞る＝自動、既定）：毎レース、買い目ごとに当たる確率（AI）と払戻の見込みから期待値と有利さ
 * （ケリー基準）を出し、自信に応じて買う買い目と金額を決める。予算は上限で、使い切るとは限らない（利用者の依頼 2026-10-05）。
 *  - 払戻の見込み：単勝はオッズ、複勝は 下限 ×（1 + placeAlpha ×（上限÷下限 − 1））。学習期間の約1.2万レースの実際の払戻から推定
 *    （年ごとに 0.20〜0.24 で安定）。下限で計算していたときは払戻を1〜5割低く見ていた。馬連・ワイド・三連複は実際のオッズ。
 *    推定オッズしかない馬単・三連単は使わない
 *  - 自信のある買い目：(1) これまでの的中重視の条件（平らにした確率×下限オッズで期待値 0.9 以上・当たる確率 classicKeep 以上・
 *    1.15 倍以上）を満たすもの、または (2) 当たる確率 minP 以上で期待値 minEv 以上のもの（下限 1.1 倍以下は当たる確率 lowP 以上。
 *    払戻が一緒に来る馬しだいで見込みがぶれるため）。金額は 予算 × min(1, 有利さ ÷ fullAt)
 *    （有利さ 8% 以上で上限まで、それより小さければ比例して減らす。100円単位）
 *  - 自信のある買い目がないレースは、当たる確率 floorP 以上・期待値 floorEv 以上の買い目を最低額（予算の floorShare、100円以上）で
 *    買う（9割近く当たるが利益はほぼない。当たる回数を増やし、外れても損は小さい）。どれもなければ見送り。1レース maxTickets 点
 * 学習期間の分割外 385日・検証期間・直近60日のすべてで、的中数・収支がこれまでの規則を上回るものを選んだ（README の開発日記 2026-10-05、
 * scratchpad/bets3/grid4・stab4・floor・grid7）。(2) を 65%・期待値 1.05・金額を有利さ×3 にすると学習期間はさらに良いが、
 * 検証期間・直近60日の収支が3分の1になる（これまでの規則の当たる確率 50% 台の買い目が直近は良く当たっている）ので、(1) を残した。
 */
export const AUTO_STAKE = { minP: 0.75, minEv: 1.1, lowP: 0.8, fullAt: 0.08, classicKeep: 0.5, floorP: 0.85, floorEv: 0.95, floorShare: 0.03, maxTickets: 1, minOdds: 1.05, placeAlpha: 0.208 };
/** 推定オッズしかない券種（自動では使わない） */
const ESTIMATED_ONLY = new Set(['exacta', 'trifecta']);
/** 払戻の見込み（1点100円あたりの倍率）：複勝は実際の下限〜上限の幅から、ほかはオッズ */
export function expectedPayout(t) {
  if (t.type === 'place' && !t.estimated && t.oddsMax > t.odds) return t.odds * (1 + AUTO_STAKE.placeAlpha * (t.oddsMax / t.odds - 1));
  return t.odds || 0;
}
const isAutoKeep = (keep) => keep == null || keep === '' || keep === 'auto';

export const STRATEGIES = {
  // 的中重視・控えめ：期待値は AI の確率だけで計算し（blend 0）、0.9 以上の買い目だけ買う。学習期間の分割外（約1.2万レース・186週）と
  // 検証期間（14週）の両方で、0.5 混合・0.8 以上より回収率も週の収支も良かった（scratchpad/oof-grid*.mjs。README の開発日記）。
  // minOdds：上の MIN_ODDS（以前は的中重視だけ 1.05：当たっても元返しの 1.0 倍だけを買わなかった）
  // keepMinP：買い目を決めたあと、当たる確率（平らにしない元の予想）がこれ以上のものだけ残す2段目。学習期間の分割外 186週で
  // 的中率 52% → 76%、最大の落ち込み −23,150円 → −7,600円、回収率 107.5% → 105.4%（検証14週：93%・147.5%）。README の開発日記
  hit: { label: '的中重視', desc: '当たりやすさを優先。毎レース、買い目ごとに当たる確率と払戻の見込みから自信を計算し、買う買い目と金額を自動で決めます（予算は上限で、使い切るとは限りません）。これまでの的中重視の買い目と、当たる確率 75% 以上で期待値のある買い目は上限まで、当たりやすい（85% 以上）が利益の薄い買い目は最低額で買い、どれもなければ見送ります。学習に使っていない約1.2万レースで的中率 63% → 79%、的中したレースは約3.6倍に増えました。', minEv: 0.9, blend: 0, minOdds: MIN_ODDS, minOddsAi: 1.05, keepMinP: 0.5, maxTickets: 6, alloc: 'equal', autoStake: true },
  // betTemp：買い目の選定で勝率を平らにする倍率（既定 BET_TEMP）。バランス・高配当は学習期間の分割外で良くならなかった（バランス −8.3 ± 11.2pt、高配当は買うレースが少なく判断できない）ので 1
  // keepMinP（バランス 30%・高配当 20%）：絞らないと馬連・三連複・三連単を足したとき1日に約29レース・160点近く買い、学習期間の分割外 385日のうち
  // 169日（高配当 172日）で1万円以上負けた（1R 千円。7/25 は 1R 3,000円で −46,270円）。絞ると回収率 85.3% → 100.8%（高配当 92.1% → 106.2%）、
  // 最悪の日 −31,660円 → −4,000円、検証期間でも 99.7% → 164.2%（112.6% → 277.7%）。README の開発日記 2026-10-05
  // バランスは 40% に：30〜40% の複勝（4〜6番人気）・馬連・三連複は予測ほど当たらず（複勝 予測 34% → 実際 22%、三連複 33% → 22%）、
  // 負けた日の主な原因だった。40% と 1.1 倍以下を買わないことで（5券種・1R 3,000円）学習期間の分割外 回収率 100.8% → 117.1%・
  // 負けた日 122 → 59日・最悪の日 −12,000円 → −6,000円、検証期間 165.7% → 282.5%・9 → 5日。45% は学習期間で 103.0% と下がった
  balance: { label: 'バランス', desc: '期待値1.0以上の買い目から確率とのバランスで選び、当たる確率が 40% 以上のものだけを買います（オッズ 1.1 倍以下は買いません）。学習期間の約1.2万レースで回収率 117%（単勝・複勝・馬連・三連複・三連単、1日 0〜1レース）。', minEv: 1.0, minOdds: MIN_ODDS, keepMinP: 0.4, maxTickets: 8, alloc: 'kelly', betTemp: 1 },
  value: { label: '高配当', desc: '期待値の高い買い目を中心に、当たる確率が 20% 以上のものだけを買います。当たる回数は少なく、買った日の半分以上は負けで、ときどき大きく当たります（学習期間の約1.2万レースで回収率 106%・的中率 20%、買うのは週に数レース）。', minEv: 1.15, minOdds: MIN_ODDS, keepMinP: 0.2, maxTickets: 10, alloc: 'kelly', betTemp: 1 },
  careful: {
    label: '控えめ',
    desc: '自信度 S のレースだけ、単勝・複勝を1〜2点。それ以外のレースとオッズ 1.1 倍以下は見送るので、買うのは月に1〜2レースです（学習期間の約1.2万レースで回収率 118%・的中率 78%）。',
    minEv: 0.9,
    blend: 0,
    minOdds: MIN_ODDS,
    keepMinP: 0.5,
    maxTickets: 2,
    alloc: 'equal',
    grades: ['S'],
    onlyTypes: ['win', 'place'],
  },
  // autoMinEv・minOdds：区分ごとの買い方を決めたあと、期待値 0.9 以上・オッズ 1.2 倍以上（MIN_ODDS）の買い目だけを買う。区分の買い方をそのまま毎レース買うと
  // 1日に約20レース買い、回収率は学習期間の分割外 90.1%・検証期間 87.5%（週 −4,176円）。期待値で絞ると 104.8%・116.5%、
  // 1.1 倍以下も外すと 115.3%・162.2%（的中率 83% → 72%・91% → 100%）
  auto: {
    label: '自動調整',
    desc: '荒れ度（堅い・普通・荒れ）に合わせて◎の買い方を切り替え、期待値が 0.9 以上のときだけ買います（オッズ 1.1 倍以下は買いません）。区分ごとの買い方は、学習期間の実際の払戻で回収率が最も良かったもの（scripts/fit-volatility.mjs）。学習期間の約1.2万レースで回収率 115.3%・的中率 72%。',
    minEv: 0,
    autoMinEv: 0.9,
    minOdds: MIN_ODDS,
    minOddsAi: 1.05,
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
 * 既定の買い方：的中重視（券種は下の DEFAULT_TYPES）。以前の判断（単勝・複勝だけを既定にした理由）：
 * 実データの検証（学習に使っていない864レース）で、オッズが実際にわかる単勝・複勝は
 * 期待回収率と実際の回収率がほぼ一致した（的中重視：期待87% → 実際92%）。
 * 馬連〜三連単はオッズを単勝から推定するしかなく、期待値で選ぶと実際の払戻が見込みを大きく下回った
 * （バランス：期待112% → 実際43%）ので、初期状態では使わない。
 */
export const DEFAULT_STRATEGY = 'hit';
/**
 * 既定の券種：ワイド以外（単勝・複勝・馬連・馬単・三連複・三連単）。利用者の設定（2026-10-05「的中重視・機械学習・荒れ度1.0で
 * ワイド以外を選ぶと利益が高い」）。いまは当たる確率の下限（的中重視 50%・バランス 40%・高配当 20%）があるので、組み合わせの券種は
 * 当たりやすいものしか残らず、推定オッズの馬単・三連単はほとんど選ばれない。的中重視は単勝・複勝だけとほぼ同じ（学習期間の分割外
 * 385日で馬連が1点増えるだけ。検証期間は同じ）、バランス・高配当は5券種の成績（学習期間 117.1%・106.4%、単勝・複勝だけでは
 * 117.2%・高配当はほとんど買わず 0%）。ワイドを入れると的中重視の的中率と回収率が下がる（学習期間 111.3% → 110.2%、検証期間の的中率 100% → 96.2%）
 */
export const DEFAULT_TYPES = ['win', 'place', 'quinella', 'exacta', 'trio', 'trifecta'];
/** オッズを推定するしかない券種（複勝は実際のオッズがないときだけ推定） */
export const ESTIMATED_TYPES = ['quinella', 'wide', 'exacta', 'trio', 'trifecta'];

/** 2段目の絞り込み（当たる確率の下限）：'auto'（既定）は買い方ごとの標準（的中重視・控えめ 50%、バランス 40%、高配当 20%） */
export function resolveKeep(keep, strategy = null) {
  if (keep == null || keep === '' || keep === 'auto') return STRATEGIES[strategy]?.keepMinP ?? 0;
  const v = Number(keep);
  return Number.isFinite(v) ? v : 0;
}

export const KEEP_OPTIONS = [
  { value: 'auto', label: '自動（的中重視は毎レース買い目と金額まで自動・控えめ 50%・バランス 40%・高配当 20%以上）' },
  { value: 0, label: '絞らない' },
  { value: 0.3, label: '30%以上' },
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

/** 的中重視の自動：AUTO_STAKE の説明を参照。tickets の stake は自信に応じた金額（合計は予算以下）、share は予算に対する割合 */
const ticketKey = (t) => `${t.type}:${t.idx.join('-')}`;
function autoStakeBets(pred, { budget, strategy, types, blend }) {
  const A = AUTO_STAKE;
  const unit = 100;
  const floorStake = Math.max(unit, Math.floor((budget * A.floorShare) / unit) * unit);
  // (1) これまでの的中重視の買い目（当たる確率で絞る 50%）
  const classic = new Set(recommendBets(pred, { budget, strategy, types, blend, keep: A.classicKeep }).tickets.map(ticketKey));
  const cands = buildCandidates(pred, types.filter((t) => !ESTIMATED_ONLY.has(t)), 0);
  const main = [];
  const floor = [];
  const near = [];
  for (const c of cands) {
    // 推定オッズ（複勝の実際のオッズが出る前など）では金額を決めない
    if (c.estimated || !(c.odds >= A.minOdds)) continue;
    const m = expectedPayout(c);
    const ev = c.p * m;
    const f = m > 1 ? (ev - 1) / (m - 1) : 0;
    const isClassic = classic.has(ticketKey(c));
    const t = { ...c, pHit: c.p, pEv: c.p, ev, oddsExp: m, kelly: f };
    // 下限 1.1 倍以下は、当たる確率 lowP 以上のときだけ (2) にする
    const strong = c.p >= (c.odds >= MIN_ODDS ? A.minP : A.lowP) && ev >= A.minEv;
    if ((isClassic || strong) && f > 0) {
      const stake = Math.floor((budget * Math.min(1, f / A.fullAt)) / unit) * unit;
      if (stake >= unit) {
        main.push({ ...t, stake, auto: isClassic ? 'classic' : 'kelly' });
        continue;
      }
    }
    if (c.p >= A.floorP && ev >= A.floorEv) floor.push({ ...t, stake: floorStake, auto: 'floor' });
    else if (c.p >= 0.5 && ev >= 0.9) near.push({ ...t, why: c.odds < MIN_ODDS && c.p >= A.minP && ev >= A.minEv ? 'low' : 'weak' });
  }
  main.sort((a, b) => b.stake - a.stake || b.p - a.p);
  floor.sort((a, b) => b.p - a.p);
  const tickets = (main.length ? main : floor).slice(0, A.maxTickets).map((t) => ({ ...t, stake: Math.min(t.stake, budget), share: Math.min(t.stake, budget) / budget }));
  const rest = (main.length ? [...main.slice(A.maxTickets), ...floor] : floor.slice(A.maxTickets)).map((t) => ({ ...t, why: 'one' }));
  // 買わなかった候補：1レース1点のため買わなかったもの・自信の足りないもの（画面で「なぜ買わないか」を出す）
  const dropped = [...rest, ...near].sort((a, b) => b.p - a.p).slice(0, 5).map((t) => ({ ...t, stake: 0 }));
  const used = tickets.reduce((s, t) => s + t.stake, 0);
  const placeWaiting = types.includes('place') && pred.placeCount > 0 && !pred.rows.some((r) => r.entry.placeMin > 1);
  const skipReason = tickets.length
    ? null
    : placeWaiting
    ? '複勝の実際のオッズ（発走の2時間ほど前から）が出たら、自信に応じて金額を決めます'
    : `自信を持って買える買い目がないので見送り（これまでの的中重視の条件、当たる確率 ${Math.round(A.minP * 100)}% 以上で期待値 ${A.minEv} 以上、当たる確率 ${Math.round(A.floorP * 100)}% 以上のどれにも当てはまる買い目がない）${
        near.some((t) => t.why === 'low') ? `。下限 ${LOW_ODDS_LABEL}の複勝は、一緒に来る馬しだいで払戻がぶれるので、当たる確率 ${Math.round(A.lowP * 100)}% 以上のときだけ買います` : ''
      }`;
  // 的中率・期待回収率・プラス収支の確率は、払戻の見込み（複勝は下限〜上限の幅から）で出す（表の期待値と同じ）
  const stats = evaluateTickets(tickets.map((t) => ({ ...t, odds: t.oddsExp })), pred);
  return { strategy, budget, tickets, dropped, auto: true, used, keepMinP: null, candidates: cands.length, skipped: !tickets.length, skipReason, stats };
}

export function recommendBets(pred, { budget = 3000, strategy = DEFAULT_STRATEGY, types = DEFAULT_TYPES, blend: blendIn = 'auto', betTemp = null, keep = 'auto' } = {}) {
  const st = STRATEGIES[strategy] || STRATEGIES.balance;
  const blend = resolveBlend(blendIn, strategy);
  // オッズの下限（MIN_ODDS）。オッズを使わない予想（AI単独）では、1.1 倍以下を外すと検証期間の的中率が下がり回収率は変わらなかったので以前のまま
  const minOdds = pred.mlAi ? (st.minOddsAi ?? 0) : (st.minOdds ?? 0);
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
      let raw = POLICY_FORMS[form].build(marks, pred.placeCount, pred.n).map((t) => ({ ...t, idx: unordered.has(t.type) ? [...t.idx].sort((a, b) => a - b) : t.idx }));
      // autoMinEv：買い方を決めたあと、期待値（的中重視と同じく少し平らにした AI の確率・オッズを混ぜない）が下限に届かない買い目は買わない
      if (st.autoMinEv > 0) {
        const view = betView(pred, st.betTemp ?? BET_TEMP);
        let lowOdds = 0;
        raw = raw.filter((t) => {
          const c = priceTicket(t, view, 0);
          if (c.ev >= st.autoMinEv && c.odds < minOdds) lowOdds++;
          return c.ev >= st.autoMinEv && c.odds >= minOdds;
        });
        if (!raw.length) {
          const skipReason = lowOdds ? `期待値の条件を満たすのはオッズ ${LOW_ODDS_LABEL}の買い目だけなので見送り` : `期待値が ${st.autoMinEv} に届かないので見送り`;
          return { strategy, budget, tickets: [], candidates: 0, skipped: true, skipReason, lowOdds, form, formLabel: POLICY_FORMS[form].label, stats: evaluateTickets([], pred) };
        }
      }
      const each = Math.max(100, Math.floor(budget / Math.max(1, raw.length) / 100) * 100);
      const tickets = raw.map((t) => ({ ...priceTicket(t, pred, blend), stake: each }));
      return { strategy, budget, tickets, candidates: tickets.length, form, formLabel: POLICY_FORMS[form].label, stats: evaluateTickets(tickets, pred) };
    }
    return recommendBets(pred, { budget, strategy: 'hit', types, blend: blendIn, betTemp, keep });
  }
  if (st.onlyTypes) types = types.filter((t) => st.onlyTypes.includes(t));
  // 的中重視の自動（既定）：毎レース、当たる確率と払戻の見込みから自信に応じて金額まで決める。AI単独（オッズを使わない予想）は以前のまま
  if (st.autoStake && isAutoKeep(keep) && betTemp == null && !pred.mlAi) return autoStakeBets(pred, { budget, strategy, types, blend: blendIn });
  const minP = MIN_P[strategy] || MIN_P.balance;
  const score = SCORE[strategy] || SCORE.balance;
  // 候補は少し平らにした勝率で評価する（betTemp。的中率・期待値の表示もこの値。どれかが当たる確率は元の予想で計算）
  const view = betView(pred, betTemp ?? st.betTemp ?? BET_TEMP);
  const passed = buildCandidates(view, types, blend).filter((c) => c.ev >= st.minEv && c.pEv >= minP[c.type]);
  const cands = passed.filter((c) => c.odds >= minOdds);
  // 期待値の条件は満たすがオッズが低すぎて外した数（画面の「見送り」の理由に使う）
  const lowOdds = passed.length - cands.length;
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
  return { strategy, budget, tickets, dropped, keepMinP, lowOdds, candidates: cands.length, stats: evaluateTickets(tickets, pred) };
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

// 買い目：期待値の計算、推奨買い目の選定と資金配分、印からのフォーメーション。

import { BET_LABEL, BET_TYPES } from './constants.js';
import { estimateOdds } from './market.js';
import { AUTO_POLICY, POLICY_FORMS } from './volatility.js';
import { exactPL } from './simulate.js';
import { STAKE_MODEL } from './stakeModel.js';
import { startMs } from './raceTime.js';

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
 * 的中重視の「自動」（当たる確率で絞る＝自動。選択肢は1つ）：毎レース、単勝・複勝の買い目ごとに、当たる確率（AI）・払戻の見込み・
 * 期待値・有利さ（ケリー基準）と、そのレースの条件に合わせた期待回収率 R̂（expectedReturn）を出し、1つの式（autoShare）で
 * 1レースの予算に対する金額の割合を決めて、割合のいちばん大きい1点を買う（予算は上限で、使い切るとは限らない）。
 *  - 払戻の見込み：単勝はオッズ、複勝は 下限 ×（1 + α ×（上限÷下限 − 1））。α は当たった複勝の払戻が下限〜上限のどこに来るか
 *    で、幅が広いほど・当たる確率が高い（人気の）馬ほど下限寄り：α = a + b × ln(上限÷下限) + c × 当たる確率（placeAlpha）。
 *    学習期間の約1.2万レースの実際の払戻から推定。推定オッズしかない券種は使わない
 *  - 強い買い目：当たる確率 minP 以上（下限 1.1 倍以下は lowP 以上）で期待値 minEv 以上 → 予算 × min(1, 有利さ ÷ fullAt)
 *    （期待値の余裕 0.2 は、発走前のオッズが確定までに動く分。2026-10-05 の点検で、確定オッズで選ぶ検証をやめた）
 *  - レースごとの調整（adjust）：それ以外の買い目は、R̂ が下限 minR 以上なら 予算 × min(1, share + slope ×（R̂ − minR））。
 *    R̂ は「AI の期待値・単勝オッズ（市場）から見た期待値・オッズ・頭数」から、学習期間に発走前のオッズで選んだ同じような
 *    買い目が実際にいくら戻ったかの関係（src/engine/stakeModel.js、scripts/stake-model.mjs）で出す
 *  - 当たっても利益が minProfit 円に届かない買い目は買わない。1日の予算（dayBudget）を超えたら、発走の早いレースから順に
 * 負けたレースの分析（利用者の依頼 2026-10-05「負けたレースの原因を分析し、レースごとに数値を自動調整」。scripts/stake-model.mjs）：
 *  発走10分前・5分前のオッズの推定（乱数3通りずつ・計6通り）で、以前の規則（2段目・3段目）の買い目は
 *  (1) 選んだ買い目の払戻が見込みの 85〜93%（いま高く見えるオッズを選ぶので、確定までに下がる）、
 *  (2) AI と市場の見立ての差が大きいほど当たる確率を高く見すぎる（市場の 1.25〜1.5 倍の複勝は 57% → 実際 46〜52%）、
 *  (3) 2段目（期待値 1.1〜1.2）は回収率 96%、3段目のワイドは 91% と長い期間で損だった。
 *  R̂ はこの2つのずれをレースごとに見込むので、2段目・3段目をやめて R̂ で金額を決めるようにした。2024年4月〜2026年6月の
 *  前進検証（R̂ の関係もその時点より前の買い目だけで推定）・1R 1,000円・6通りの平均で、収支 +7.2k → +21.2k（約2.9倍）、
 *  検証期間の30日 +4.1k → +11.7k、参加するレースは 14〜22% 増え、的中率は 53〜56% → 58〜62%（README の開発日記 2026-10-05 23:45）。
 *  adjust の下限・金額（minP 0.45・minR 0.92・share 0.2・slope 15、複勝 minP 0.4・minR 0.97）は、2024年・2025年〜・検証期間の
 *  どれも以前の規則より収支が多く、確定オッズで選び直す過去の日の画面でも買うレースが減らない組から選んだ
 */
export const AUTO_STAKE = {
  minP: 0.55,
  minEv: 1.2,
  lowP: 0.8,
  fullAt: 0.03,
  minProfit: 100,
  maxTickets: 1,
  minOdds: 1.05,
  placeAlpha: [0.4594, -0.1652, -0.1447],
  // 自動で使う券種（組み合わせの券種は、発走前のオッズで選ぶと学習期間のどの年も損だった）
  types: ['win', 'place'],
  // レースごとの調整：R̂ の下限 minR・その時の割合 share・R̂ が 0.01 上がるごとに slope × 0.01 だけ増やす（上限は予算の全額）
  // 調整は複勝だけ（直前のオッズでは、単勝の調整の買い目は R̂ 0.96 以上でも回収率 約95% で損だった。外すと 2024年4月〜2026年6月の
  // 収支 +2.5k・的中率 +0.5 ポイント、買うレースはほぼ同じ。2026-10-06 8時）。minRBy で券種ごとの下限も指定できる
  adjust: [
    { types: ['place'], minP: 0.45, minEv: 1.0, minR: 0.92, share: 0.2, slope: 15 },
    { types: ['place'], minP: 0.4, minEv: 0, minR: 0.97, share: 0.2, slope: 10 },
  ],
  // 金額が小さくて当たっても利益が minProfit 円に届かない買い目は、届く最低額まで上げる（予算のこの割合まで。それより多く要るなら見送り）
  minStakeUp: 0.4,
  // 参加の買い目（見送りを減らす。2026-10-06）：ほかに買い目がないレースで、当たる確率 minP 以上・R̂ minR 以上の複勝のうち
  // 当たる確率のいちばん高い1点を、当たって minProfit 円になる最低額で（予算の maxShare まで）。直前のオッズで回収率 約97%・的中率 約64%
  // high：先に試す上の段（当たる確率 60% 以上・R̂ 0.92 以上なら予算の 60% まで。オッズの低い当たりやすい複勝も入る。直前のオッズで
  // 回収率 約99%・的中率 約68%。2026-10-06 8時）。なければ下の段（minP・minR・maxShare）
  join: { types: ['place'], minP: 0.55, minR: 0.9, maxShare: 0.4, high: { minP: 0.6, minR: 0.92, maxShare: 0.6 } },
  // 参加の買い目と最低額へ上げる買い目は、オッズが発走の freshMin 分前より後に取ったものだけ（直前のオッズなら回収率 約97%、
  // 発走10分前のオッズでは 92% と損だった。2026-10-06）。結果の出たレース・オッズの時刻がわからない過去のレースは対象
  freshMin: 8,
  // 1日の予算：1レースの予算の mult 倍まで（発走の早いレースから順に）。参加の買い目と最低額へ上げる買い目には、
  // 最後の reserve 倍を使わない（後のレースの強い買い目のために残す。その時点までに使った額だけで決まる）
  dayBudget: { mult: 7, reserve: 2 },
};
/** 当たったときの利益が minProfit 円以上か（オッズは 0.1 倍刻み。小数の誤差で 500円 × 1.2 倍 = +100円 を落とさない） */
export function profitOk(stake, odds, minProfit = AUTO_STAKE.minProfit) {
  return stake * (odds - 1) >= minProfit - 1e-6;
}
/** 当たって minProfit 円以上の利益になる最低の金額（unit 円単位） */
export function minStakeFor(odds, minProfit = AUTO_STAKE.minProfit, unit = 100) {
  return odds > 1 ? Math.ceil(minProfit / (odds - 1) / unit - 1e-9) * unit : Infinity;
}
/**
 * オッズが新しいか（発走の freshMin 分前より後に取った）。参加の買い目と最低額へ上げる買い目の条件。
 * 結果の出たレースは確定オッズ（attachResult が置き換える）・時刻がわからないレースは新しいとみなす。
 * 検証で発走前のオッズを作ったレースは oddsBefore（発走の何分前のオッズか。scripts/evaluate.mjs）で決める
 */
export function oddsFresh(race, A = AUTO_STAKE) {
  if (!race || !A.freshMin) return true;
  if (race.oddsBefore != null) return race.oddsBefore <= A.freshMin;
  if (race.result?.length) return true;
  const st = startMs(race);
  const at = race.oddsAt ? Date.parse(race.oddsAt) : NaN;
  if (!st || !Number.isFinite(at)) return true;
  return st - at <= A.freshMin * 60 * 1000;
}
/** 優先の低い買い目（参加の買い目・最低額へ上げた買い目）か。1日の予算の最後の reserve 倍を使わない */
export const lowPriority = (t) => t.auto === 'join' || !!t.raised;
/** 1日の予算の残り left のうち、この買い目に使える額 */
export function dayRoom(t, left, budget, A = AUTO_STAKE) {
  return lowPriority(t) ? left - (A.dayBudget?.reserve || 0) * budget : left;
}
/**
 * レースごとの期待回収率 R̂（1点に賭けた金額に対して、実際に戻る金額の見込み）。そのレースの条件（AI の期待値・単勝オッズから見た
 * 市場の期待値・オッズ・頭数）から、学習期間に発走前のオッズで選んだ同じような買い目の実際の払戻との関係（準ポアソン回帰、券種ごと）で出す。
 * 当てはめた範囲の外（オッズ・当たる確率・期待値）と、係数のない券種は null
 */
export function stakeFeatures(t, n, R = STAKE_MODEL?.region) {
  const p = t.pHit ?? t.p;
  const m = expectedPayout(t);
  const ev = p * m;
  if (!R || t.estimated || !(t.odds >= R.minOdds && t.odds < R.maxOdds && p >= R.minP && ev >= R.minEv && n >= 2)) return null;
  return [1, Math.log(ev), Math.log(Math.max(1e-3, t.pMarket || 0) * m), Math.log(t.odds), Math.log(n)];
}
export function expectedReturn(t, n, coef = STAKE_MODEL?.coef?.[t.type], region = STAKE_MODEL?.region) {
  if (!coef) return null;
  const x = stakeFeatures(t, n, region);
  if (!x) return null;
  let eta = 0;
  for (let j = 0; j < x.length; j++) eta += coef[j] * x[j];
  return Math.exp(eta);
}
/**
 * 自動の金額の割合（1レースの予算に対して、0〜1。0 は買わない）。t：{ type, p（当たる確率）, odds, ev（期待値）, kelly（有利さ）, r（R̂） }
 * 返り値 { share, level }（level：'strong' 強い買い目・'adjust' レースごとの調整）
 */
export function autoShare(t, A = AUTO_STAKE) {
  let share = 0;
  let level = null;
  if (A.types.includes(t.type) && t.kelly > 0 && t.p >= (t.odds >= MIN_ODDS ? A.minP : A.lowP) && t.ev >= A.minEv) {
    share = Math.min(1, t.kelly / A.fullAt);
    level = 'strong';
  }
  for (const L of A.adjust || []) {
    const minR = L.minRBy?.[t.type] ?? L.minR;
    if (!L.types.includes(t.type) || !(t.odds >= MIN_ODDS) || t.p < L.minP || t.ev < (L.minEv ?? 0) || !(t.r >= minR)) continue;
    const s = Math.min(1, L.share + L.slope * (t.r - minR));
    if (s > share) {
      share = s;
      level = 'adjust';
    }
  }
  return { share, level };
}
/**
 * 1レースの買い目を決める：金額の割合（autoShare）のいちばん大きい1点（同じなら当たる確率の高い方）を、予算 × 割合（100円単位）で。
 * 当たっても利益が minProfit 円に届かない金額なら、届く最低額まで上げる（予算の minStakeUp まで。それより多く要るなら見送り。2番目には替えない）。
 * ほかに買い目がなければ、参加の買い目（join：当たる確率の高い複勝を、当たって minProfit 円になる最低額で）。cands：{ type, p, odds, ev, kelly, r, ... }
 * 返り値 { picked: [{ ...t, stake, share, auto }], ranked }（ranked は割合のある候補を並べたもの。auto：'strong'・'adjust'・'join'）
 */
export function pickAuto(cands, budget, A = AUTO_STAKE, { fresh = true } = {}) {
  const unit = 100;
  const ranked = [];
  for (const t of cands) {
    const { share, level } = autoShare(t, A);
    if (share > 0) ranked.push({ ...t, share, auto: level });
  }
  ranked.sort((a, b) => b.share - a.share || b.p - a.p);
  const picked = [];
  let left = budget;
  for (const t of ranked.slice(0, A.maxTickets)) {
    let stake = Math.min(Math.floor((budget * t.share) / unit) * unit, Math.floor(left / unit) * unit);
    if (A.minStakeUp && fresh && stake >= unit && !profitOk(stake, t.odds, A.minProfit)) {
      const need = minStakeFor(t.odds, A.minProfit, unit);
      if (need <= budget * A.minStakeUp && need <= left) {
        stake = need;
        t.raised = true;
      }
    }
    if (stake < unit || !profitOk(stake, t.odds, A.minProfit)) {
      t.why = stake < unit ? 'small' : 'thin';
      continue;
    }
    picked.push({ ...t, stake });
    left -= stake;
  }
  const j = !picked.length && fresh ? joinPick(cands, budget, A, left) : null;
  if (j) picked.push(j);
  return { picked, ranked };
}
/**
 * 参加の買い目（A.join）：当たる確率 minP 以上・R̂ minR 以上の複勝のうち、当たる確率のいちばん高い1点を、当たって minProfit 円になる
 * 最低額で（予算の maxShare まで）。上の段（J.high）を先に試し、なければ下の段
 */
export function joinPick(cands, budget, A = AUTO_STAKE, left = budget) {
  const J = A.join;
  if (!J) return null;
  for (const T of [J.high, J].filter(Boolean)) {
    let best = null;
    for (const t of cands) {
      if (!J.types.includes(t.type) || !(t.odds >= MIN_ODDS) || !(t.p >= T.minP) || !(t.r >= T.minR)) continue;
      const need = minStakeFor(t.odds, A.minProfit);
      if (need > budget * T.maxShare || need > left) continue;
      if (!best || t.p > best.p) best = { ...t, stake: need, share: need / budget, auto: 'join' };
    }
    if (best) return best;
  }
  return null;
}
/** 1日の予算の選択肢（1レースの予算の何倍まで）。'auto' は AUTO_STAKE.dayBudget.mult、0 は上限なし */
export const DAY_BUDGET_OPTIONS = [
  { value: 'auto', label: '標準（1レースの予算の7倍まで）' },
  { value: 0, label: 'なし（1日の上限なし）' },
  { value: 5, label: '1レースの予算の5倍まで' },
  { value: 10, label: '1レースの予算の10倍まで' },
];
/** 1日の予算（1レースの予算の倍数。0 は上限なし） */
export function resolveDayBudget(v) {
  if (v == null || v === '' || v === 'auto') return AUTO_STAKE.dayBudget.mult;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : AUTO_STAKE.dayBudget.mult;
}
/** 買い目1点のリスクに対する期待値（シャープ比）：（当たる確率 × 払戻の見込み − 1）÷ 1点あたりの払戻のばらつき */
export function ticketSharpe(t) {
  const p = t.pHit ?? t.p ?? 0;
  const m = t.oddsExp || t.odds || 0;
  if (!(p > 0 && p < 1 && m > 0)) return -Infinity;
  return (p * m - 1) / (m * Math.sqrt(p * (1 - p)));
}
/**
 * 1日の予算：その日の全レースの推奨買い目（的中重視の自動）の合計が 1レースの予算 × 倍数 を超えたら、
 * 発走の早いレースから順に1日の予算まで割り振り、入らない買い目は見送る（金額は買い目ごとの希望額まで。利益 100円に届かない額にはしない）。
 * items … [{ pred, rec }]（その日のレース。rec は recommendBets の結果）。返り値は同じ順の rec（day に1日の予算の情報）
 */
export function planDay(items, { budget, dayBudget = 'auto' } = {}) {
  const mult = resolveDayBudget(dayBudget);
  const limit = mult > 0 ? mult * budget : Infinity;
  const list = [];
  items.forEach(({ rec }, i) => {
    if (rec?.auto) rec.tickets.forEach((t, j) => list.push({ i, j, t, s: ticketSharpe(t) }));
  });
  const total = list.reduce((a, it) => a + it.t.stake, 0);
  const races = new Set(list.map((it) => it.i)).size;
  const info = { limit: Number.isFinite(limit) ? limit : null, mult, total, races };
  const reserve = (AUTO_STAKE.dayBudget?.reserve || 0) * budget;
  const lowTotal = list.filter((it) => lowPriority(it.t)).reduce((a, it) => a + it.t.stake, 0);
  // 合計が予算の範囲内で、参加の買い目などが残しておく分にかからなければ、そのまま（発走順に先着しても削られない）
  if (!(total > limit) && (lowTotal === 0 || total <= limit - reserve)) return items.map(({ rec }) => (rec?.auto ? { ...rec, day: { ...info, used: total, over: false } } : rec));
  // 発走順に先着：前のレースを買う時点では、後のレースのオッズ（買い目）はわからない。後のレースの買い目を見て前のレースを削ると、
  // 検証だけが「その日の良い買い目を先に知っている」形になる（以前はその日の全レースをリスクに対する期待値の順に並べていた）。
  // 同じレースの中は、リスクに対する期待値の高い順
  const startKey = (i) => {
    const r = items[i].pred?.race || {};
    return `${r.date || ''}|${r.startTime || '99:99'}|${String(r.raceNo ?? 99).padStart(2, '0')}|${r.id || ''}`;
  };
  const order = [...list].sort((a, b) => {
    const ka = startKey(a.i);
    const kb = startKey(b.i);
    return ka < kb ? -1 : ka > kb ? 1 : b.s - a.s;
  });
  let left = limit;
  const stakeOf = new Map();
  for (const it of order) {
    const st = Math.min(it.t.stake, Math.floor(dayRoom(it.t, left, budget) / 100) * 100);
    if (st >= 100 && profitOk(st, it.t.odds)) {
      stakeOf.set(it, st);
      left -= st;
    }
  }
  const used = limit - left;
  if (list.every((it) => stakeOf.get(it) === it.t.stake)) return items.map(({ rec }) => (rec?.auto ? { ...rec, day: { ...info, used, over: false } } : rec));
  return items.map(({ pred, rec }, i) => {
    if (!rec?.auto) return rec;
    const mine = list.filter((it) => it.i === i);
    if (!mine.length) return { ...rec, day: { ...info, used, over: true } };
    const tickets = [];
    const out = [];
    for (const it of mine) {
      const st = stakeOf.get(it) || 0;
      if (st) tickets.push({ ...it.t, stake: st, share: st / budget, dayCut: st < it.t.stake });
      else out.push({ ...it.t, stake: 0, why: 'day' });
    }
    const dropped = [...out, ...(rec.dropped || [])].slice(0, 5);
    const lowOut = out.length && out.every((t) => lowPriority(t));
    const skipReason = tickets.length
      ? null
      : lowOut
      ? `この日は買い目が多く、1日の予算（${limit.toLocaleString('ja-JP')}円）の残りが少ないので見送り（参加の買い目には、後のレースの強い買い目のために最後の ${reserve.toLocaleString('ja-JP')}円を使いません）`
      : `この日は買い目の合計（${races}レース・${total.toLocaleString('ja-JP')}円）が1日の予算（${limit.toLocaleString('ja-JP')}円）を超えるので、発走の早いレースから順に予算まで買います。このレースの前で予算を使い切ったので見送り`;
    const stats = evaluateTickets(tickets.map((t) => ({ ...t, odds: t.oddsExp || t.odds })), pred);
    return { ...rec, tickets, dropped, used: tickets.reduce((a, t) => a + t.stake, 0), skipped: !tickets.length, skipReason, stats, day: { ...info, used, over: true, out: out.length } };
  });
}
/** 複勝の払戻が下限〜上限のどこに来るか（0〜1）：幅（上限÷下限）と当たる確率から */
export function placeAlpha(width, p) {
  const [a, b, c] = AUTO_STAKE.placeAlpha;
  return Math.min(1, Math.max(0, a + b * Math.log(width) + c * p));
}
/** 払戻の見込み（1点100円あたりの倍率）：複勝は実際の下限〜上限の幅と当たる確率から、ほかはオッズ */
export function expectedPayout(t) {
  if (t.type === 'place' && !t.estimated && t.oddsMax > t.odds) {
    const w = t.oddsMax / t.odds;
    return t.odds * (1 + placeAlpha(w, t.pHit ?? t.p ?? 0) * (w - 1));
  }
  return t.odds || 0;
}
const isAutoKeep = (keep) => keep == null || keep === '' || keep === 'auto';

export const STRATEGIES = {
  // 的中重視・控えめ：期待値は AI の確率だけで計算し（blend 0）、0.9 以上の買い目だけ買う。学習期間の分割外（約1.2万レース・186週）と
  // 検証期間（14週）の両方で、0.5 混合・0.8 以上より回収率も週の収支も良かった（scratchpad/oof-grid*.mjs。README の開発日記）。
  // minOdds：上の MIN_ODDS（以前は的中重視だけ 1.05：当たっても元返しの 1.0 倍だけを買わなかった）
  // keepMinP：買い目を決めたあと、当たる確率（平らにしない元の予想）がこれ以上のものだけ残す2段目。学習期間の分割外 186週で
  // 的中率 52% → 76%、最大の落ち込み −23,150円 → −7,600円、回収率 107.5% → 105.4%（検証14週：93%・147.5%）。README の開発日記
  hit: { label: '的中重視', desc: '当たりやすさを優先。毎レース、単勝・複勝の買い目ごとに当たる確率と払戻の見込み（複勝はオッズの幅と当たる確率から）で期待値を出し、さらにそのレースの条件（AI と市場の見立て・オッズ・頭数）で見込む回収率（R̂）を出して、1つの式で金額を決め、1レース1点を買います。当たる確率 55% 以上で期待値が 1.2 以上の強い買い目は自信に応じて上限まで、それ以外は複勝で R̂ が高いほど多く（R̂ が 92% 未満なら買わない。単勝は強い買い目だけ。予算は上限で、使い切るとは限りません）。どれもないレースでも、発走直前のオッズで当たる確率 55% 以上・R̂ 90% 以上の複勝があれば、参加の買い目として当たって 100円の利益になる最低額で買います（当たる確率 60% 以上・R̂ 92% 以上なら予算の6割まで、ほかは4割まで）。当たっても 100円の利益に届かない金額なら、届く最低額まで上げます（予算の4割まで）。その日の買い目の合計が1日の予算（標準は1レースの予算の7倍）を超えたら、発走の早いレースから順に予算まで買います。発走10分前のオッズで選んだ場合の推定（学習に使っていない期間、その時点より前のデータだけで学習したモデル）は、バックテスト画面にあります。', minEv: 0.9, blend: 0, minOdds: MIN_ODDS, minOddsAi: 1.05, keepMinP: 0.5, maxTickets: 6, alloc: 'equal', autoStake: true },
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
 * 既定の券種：すべて（2026-10-05 の夜からワイドも。それまでのワイド以外は利用者の設定（2026-10-05「的中重視・機械学習・荒れ度1.0で
 * ワイド以外を選ぶと利益が高い」）で、確定オッズで選ぶ検証の結果だった）。的中重視の自動が買うのは単勝・複勝だけ（AUTO_STAKE.types）。
 * 以下は以前の説明：いまは当たる確率の下限（的中重視 50%・バランス 40%・高配当 20%）があるので、組み合わせの券種は
 * 当たりやすいものしか残らず、推定オッズの馬単・三連単はほとんど選ばれない。的中重視は単勝・複勝だけとほぼ同じ（学習期間の分割外
 * 385日で馬連が1点増えるだけ。検証期間は同じ）、バランス・高配当は5券種の成績（学習期間 117.1%・106.4%、単勝・複勝だけでは
 * 117.2%・高配当はほとんど買わず 0%）。ワイドを入れると的中重視の的中率と回収率が下がる（学習期間 111.3% → 110.2%、検証期間の的中率 100% → 96.2%）
 */
export const DEFAULT_TYPES = ['win', 'place', 'quinella', 'wide', 'exacta', 'trio', 'trifecta'];
/** 以前の既定の券種（ワイド以外）。保存してある設定がこのままなら、新しい既定に置き換える（main.js） */
export const OLD_DEFAULT_TYPES = ['win', 'place', 'quinella', 'exacta', 'trio', 'trifecta'];
/** オッズを推定するしかない券種（複勝は実際のオッズがないときだけ推定） */
export const ESTIMATED_TYPES = ['quinella', 'wide', 'exacta', 'trio', 'trifecta'];

/** 2段目の絞り込み（当たる確率の下限）：'auto'（既定）は買い方ごとの標準（的中重視・控えめ 50%、バランス 40%、高配当 20%）。数値は手動（画面からは選べない） */
export function resolveKeep(keep, strategy = null) {
  if (keep == null || keep === '' || keep === 'auto') return STRATEGIES[strategy]?.keepMinP ?? 0;
  const v = Number(keep);
  return Number.isFinite(v) ? v : 0;
}

/**
 * 当たる確率で絞る：選択肢は「自動」1つ（利用者の依頼 2026-10-05「3つに分けるのではなく一つに、選択肢を多くするな、もっと柔軟に」）。
 * 的中重視は、当たる確率・期待値とレースごとの期待回収率 R̂ で、買うかどうかと金額をレースごとに決める（AUTO_STAKE）
 */
export const KEEP_OPTIONS = [{ value: 'auto', label: '自動（レースごとに調整）' }];

export const BLEND_OPTIONS = [
  { value: 'auto', label: '買い方の標準（的中重視・控えめは混ぜない、ほかは50%）' },
  { value: 0, label: '混ぜない（AIのみ）' },
  { value: 0.3, label: '30%' },
  { value: 0.5, label: '50%' },
  { value: 0.7, label: '70%' },
];

const ticketKey = (t) => `${t.type}:${t.idx.join('-')}`;
/** 的中重視の自動：AUTO_STAKE の説明を参照。tickets の stake は自信に応じた金額（合計は予算以下）、share は予算に対する割合、r は R̂ */
function autoStakeBets(pred, { budget, strategy, types, blend, rule = AUTO_STAKE }) {
  const A = rule;
  // オッズの確率を期待値に混ぜる割合（'auto' は混ぜない。選んだときだけ、強い買い目の期待値に混ぜる。当たる確率と R̂ は AI のまま）
  const mix = blend == null || blend === '' || blend === 'auto' ? 0 : Math.min(1, Math.max(0, Number(blend) || 0));
  const n = pred.rows.length;
  const cands = buildCandidates(pred, types.filter((t) => A.types.includes(t)), 0);
  const scored = [];
  let lowOnly = false;
  for (const c of cands) {
    // 推定オッズ（複勝の実際のオッズが出る前など）では金額を決めない
    if (c.estimated || !(c.odds >= A.minOdds)) continue;
    const m = expectedPayout(c);
    const pEv = mix > 0 ? (1 - mix) * c.p + mix * (c.pMarket || 0) : c.p;
    const ev = pEv * m;
    const kelly = m > 1 ? (ev - 1) / (m - 1) : 0;
    const t = { ...c, pHit: c.p, pEv, ev, oddsExp: m, kelly };
    t.r = expectedReturn(t, n);
    scored.push(t);
    if (c.odds < MIN_ODDS && c.p >= A.minP && ev >= A.minEv && c.p < A.lowP) lowOnly = true;
  }
  const fresh = oddsFresh(pred.race, A);
  const { picked, ranked } = pickAuto(scored, budget, A, { fresh });
  const tickets = picked.map((t) => ({ ...t, share: t.stake / budget }));
  const used = tickets.reduce((s, t) => s + t.stake, 0);
  // 買わなかった候補（画面で「なぜ買わないか」）：1レース1点のため・当たっても利益が薄い・見込みが足りない（当たる確率の高い順に5点）
  const pickedKeys = new Set(picked.map(ticketKey));
  const rankedKeys = new Set(ranked.map(ticketKey));
  const dropped = [
    ...ranked.filter((t) => !pickedKeys.has(ticketKey(t))).map((t) => ({ ...t, why: t.why || 'one' })),
    ...scored.filter((t) => !rankedKeys.has(ticketKey(t)) && !pickedKeys.has(ticketKey(t)) && t.p >= 0.4 && (t.ev >= 0.95 || t.r >= 0.9)).map((t) => ({ ...t, why: t.odds < MIN_ODDS && t.p >= A.minP && t.ev >= A.minEv ? 'low' : 'weak' })),
  ]
    .sort((a, b) => b.p - a.p)
    .slice(0, 5)
    .map((t) => ({ ...t, stake: 0 }));
  const placeWaiting = types.includes('place') && pred.placeCount > 0 && !pred.rows.some((r) => r.entry.placeMin > 1);
  const thinT = ranked.find((t) => t.why === 'thin');
  const thin = !!thinT;
  // オッズが古くて最低額へ上げなかった（新しいオッズなら上げて買える）
  const thinLater = thinT && !fresh && A.minStakeUp && minStakeFor(thinT.odds, A.minProfit) <= budget * A.minStakeUp;
  const skipReason = tickets.length
    ? null
    : placeWaiting
    ? '複勝の実際のオッズ（発走の2時間ほど前から）が出たら、自信に応じて金額を決めます'
    : `利益の見込める買い目がないので見送り（当たる確率 ${Math.round(A.minP * 100)}% 以上で期待値が ${A.minEv.toFixed(1)} 以上の買い目も、このレースの条件で見込む回収率（R̂）が ${Math.round(Math.min(...A.adjust.map((L) => L.minR)) * 100)}% 以上の買い目${A.join ? `も、当たる確率 ${Math.round(A.join.minP * 100)}% 以上で R̂ ${Math.round(A.join.minR * 100)}% 以上の複勝` : ''}もない）${
        thinLater
          ? `。当たりやすい買い目はありますが、いまの金額では当たっても利益が ${A.minProfit}円に届きません（発走の${A.freshMin}分前より後のオッズなら、届く最低額まで上げて買います）`
          : thin
          ? `。当たりやすい買い目はありますが、オッズが低く、当たって利益 ${A.minProfit}円にするには予算の ${Math.round((A.minStakeUp || 0) * 100)}% より多く要るので買いません`
          : lowOnly ? `。下限 ${LOW_ODDS_LABEL}の複勝は、一緒に来る馬しだいで払戻がぶれるので、当たる確率 ${Math.round(A.lowP * 100)}% 以上のときだけ買います` : ''
      }`;
  // オッズが古い（発走 freshMin 分前より前）ので参加の買い目を出していないレース：直前のオッズで出す見込みを伝える
  const later = !tickets.length && !fresh ? joinPick(scored, budget, A) : null;
  const skipNote = later ? `。発走の${A.freshMin}分前より後のオッズで、参加の買い目（複勝 ${later.nums?.[0] ?? ''}・当たる確率 ${Math.round(later.p * 100)}%）を出す見込みです` : '';
  // 的中率・期待回収率・プラス収支の確率は、払戻の見込み（複勝は下限〜上限の幅から）で出す（表の期待値と同じ）
  const stats = evaluateTickets(tickets.map((t) => ({ ...t, odds: t.oddsExp })), pred);
  return { strategy, budget, tickets, dropped, auto: true, used, keepMinP: null, candidates: cands.length, skipped: !tickets.length, skipReason: skipReason && skipNote ? skipReason + skipNote : skipReason, stats, fresh };
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

// 確定したレースの答え合わせの分析（外れ方の型）と、期間の集計（外れ方の傾向・AI の見込みどおりか）。
// 学習期間の分割外 11,991レースと検証期間 910レースの分析（scripts/miss-analysis.mjs）では、外れの約半分は AI の2・3番手が
// 勝った「惜しい外れ」、残りのほとんどは人気も AI も低く見ていた馬が勝った「波乱」で、AI が人気馬を見落とした外れは 2〜4%。
// 条件ごと・馬の型ごとにも AI の見込みからの系統的なずれは見つからなかった。画面ではレースごとの型と、読み込んだ開催日の集計を出し、
// 条件ごとのずれが大きくなったら知らせる（モデルを見直す合図）。

import { classLevel } from './constants.js';

export const MISS_KINDS = {
  hit: { label: '◎的中', short: '的中' },
  near: { label: '惜しい外れ', short: '惜しい', desc: 'AI の2・3番手（○▲）が勝った' },
  upset: { label: '波乱', short: '波乱', desc: '人気（4番人気以下）も AI（4番手以下）も低く見ていた馬が勝った' },
  overlook: { label: 'AI の見落とし', short: '見落とし', desc: '1〜3番人気の馬を AI が4番手以下に下げていた' },
};

/** 集計に使う条件（レースの区分） */
export const REVIEW_SEGMENTS = {
  surface: { label: '芝ダ', order: ['芝', 'ダート'], of: (race) => (race.surface === '芝' ? '芝' : 'ダート') },
  field: { label: '頭数', order: ['9頭以下', '10〜13頭', '14頭以上'], of: (race, pred) => (pred.rows.length <= 9 ? '9頭以下' : pred.rows.length <= 13 ? '10〜13頭' : '14頭以上') },
  cls: { label: 'クラス', order: ['新馬', '未勝利', '1〜3勝クラス', 'オープン・重賞'], of: (race) => (['新馬', '未勝利'].includes(race.grade) ? race.grade : classLevel(race.grade) >= 4 ? 'オープン・重賞' : '1〜3勝クラス') },
  vol: { label: '荒れ度', order: ['堅い', '普通', '荒れ'], of: (race, pred) => pred.confidence?.volatility || null },
  grade: { label: '自信度', order: ['自信度 S', '自信度 A', '自信度 B', '自信度 C'], of: (race, pred) => (pred.confidence?.grade ? `自信度 ${pred.confidence.grade}` : null) },
};

/** 1レースの答え合わせ（結果が出ていなければ null） */
export function reviewRace(pred, race) {
  if (pred.empty || !race.result?.length) return null;
  const order = pred.order || [...pred.rows].sort((a, b) => b.pWin - a.pWin);
  const rank = order.findIndex((r) => r.entry.number === race.result[0]) + 1;
  if (rank < 1) return null;
  const h = order[0];
  const w = order[rank - 1];
  const pop = w.entry.popularity > 0 ? w.entry.popularity : null;
  const kind = rank === 1 ? 'hit' : rank <= 3 ? 'near' : pop && pop <= 3 ? 'overlook' : 'upset';
  const fin = race.finishes?.[h.entry.number] ?? race.finishes?.[String(h.entry.number)] ?? null;
  const seg = {};
  for (const [k, s] of Object.entries(REVIEW_SEGMENTS)) seg[k] = s.of(race, pred);
  return {
    kind,
    honmei: { number: h.entry.number, name: h.entry.name, p: h.pWin, fin, pop: h.entry.popularity || null },
    winner: { number: w.entry.number, name: w.entry.name, p: w.pWin, q: w.marketProb ?? null, pop, odds: w.entry.odds || null, rank, mark: w.mark || '' },
    seg,
  };
}

const zOf = (obs, exp, v) => (v > 0 ? (obs - exp) / Math.sqrt(v) : 0);

/** ずれの判定：|z| が 2 未満なら見込みどおり */
export function verdictOf(z, n) {
  if (!n) return { key: 'none', label: '—' };
  if (z >= 2) return { key: 'good', label: '見込みより当たっている' };
  if (z <= -2) return { key: 'bad', label: '見込みより外れが多い' };
  return { key: 'ok', label: '見込みどおり' };
}

/**
 * 期間の集計。items は { review, bet } の配列（bet は AI推奨の精算：{ stake, hits, expHit }）。
 *   honmei … ◎の的中数と AI の見込み（勝率の合計）、z（見込みからのずれ ÷ ばらつき）
 *   kinds … 外れ方の内訳
 *   segments … 条件ごとの◎の的中と見込み（flag：20R 以上で |z| ≥ 2）
 *   bets … AI推奨を買ったレースの的中数と見込み（どれかが当たる確率の合計）
 */
export function reviewSummary(items) {
  const rs = items.filter((x) => x?.review);
  const out = { races: rs.length, hits: 0, exp: 0, v: 0, kinds: { hit: 0, near: 0, upset: 0, overlook: 0 }, segments: [], bets: { races: 0, hits: 0, exp: 0, v: 0 } };
  const seg = new Map();
  for (const { review: r, bet } of rs) {
    const hit = r.kind === 'hit' ? 1 : 0;
    out.hits += hit;
    out.exp += r.honmei.p;
    out.v += r.honmei.p * (1 - r.honmei.p);
    out.kinds[r.kind]++;
    for (const [k, key] of Object.entries(r.seg)) {
      if (key == null) continue;
      const id = `${k}|${key}`;
      const s = seg.get(id) || seg.set(id, { dim: k, label: REVIEW_SEGMENTS[k].label, key, n: 0, hits: 0, exp: 0, v: 0 }).get(id);
      s.n++;
      s.hits += hit;
      s.exp += r.honmei.p;
      s.v += r.honmei.p * (1 - r.honmei.p);
    }
    if (bet?.stake > 0) {
      out.bets.races++;
      if (bet.hits > 0) out.bets.hits++;
      const e = Math.min(1, Math.max(0, bet.expHit ?? 0));
      out.bets.exp += e;
      out.bets.v += e * (1 - e);
    }
  }
  out.z = zOf(out.hits, out.exp, out.v);
  out.verdict = verdictOf(out.z, out.races);
  out.bets.z = zOf(out.bets.hits, out.bets.exp, out.bets.v);
  out.bets.verdict = verdictOf(out.bets.z, out.bets.races);
  const dims = Object.keys(REVIEW_SEGMENTS);
  out.segments = [...seg.values()]
    .map((s) => ({ ...s, z: zOf(s.hits, s.exp, s.v), flag: s.n >= 20 && Math.abs(zOf(s.hits, s.exp, s.v)) >= 2 }))
    .sort((a, b) => dims.indexOf(a.dim) - dims.indexOf(b.dim) || REVIEW_SEGMENTS[a.dim].order.indexOf(a.key) - REVIEW_SEGMENTS[b.dim].order.indexOf(b.key));
  return out;
}

const pc = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
const oneIn = (p) => (p > 0 ? Math.max(1, Math.round(1 / p)) : null);

/** 1レースの答え合わせの文章 */
export function reviewText(r) {
  const h = r.honmei;
  const w = r.winner;
  const finText = typeof h.fin === 'number' && h.fin > 0 ? `${h.fin}着` : h.fin || '着外';
  const popText = w.pop ? `${w.pop}番人気` : '人気不明';
  switch (r.kind) {
    case 'hit':
      return `◎${h.name}が勝ちました（AI の勝率 ${pc(h.p)}）。`;
    case 'near':
      return `AI の${w.rank}番手（${w.mark || (w.rank === 2 ? '○' : '▲')}）${w.name}（${popText}）が勝ち、◎${h.name}は${finText}でした。AI は勝ち馬に ${pc(w.p)}、◎が負ける確率を ${pc(1 - h.p)} と見ていました。外れのおよそ半分はこの形です。`;
    case 'upset':
      return `${popText}の${w.name}が勝つ波乱でした。AI の勝率は ${pc(w.p, 1)}（${w.rank}番手）${w.q != null ? `、オッズの見立ても ${pc(w.q, 1)}` : ''}で、AI もオッズも予想しにくい結果です（AI の見立てでは約${oneIn(w.p)}回に1回）。◎${h.name}は${finText}。`;
    case 'overlook':
      return `${popText}の${w.name}が勝ちました。AI はこの馬を${w.rank}番手（勝率 ${pc(w.p, 1)}${w.q != null ? `、オッズの見立て ${pc(w.q, 1)}` : ''}）に下げていて、AI の見落としです（外れの 2〜4% がこの形）。◎${h.name}は${finText}。`;
    default:
      return '';
  }
}

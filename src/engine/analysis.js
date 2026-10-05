// レースごとの分析：結論（買う・見送りとその理由）、有力馬の比較、AI と人気のずれ、このコースの過去の傾向、脚質の顔ぶれ。
// 画面の「レース分析」（src/ui/predictView.js）が使う。数字はすべて予想（pred）と買い目（rec）と過去のレース結果から。

import { COURSE_STATS } from './courseStats.js';
import { LOW_ODDS_LABEL, AUTO_STAKE, MIN_ODDS } from './bets.js';
import { horseComment } from './comments.js';

const STYLES = ['逃げ', '先行', '差し', '追込'];
const pc = (v, d = 0) => `${(v * 100).toFixed(d)}%`;

/** AI の勝率とオッズの確率の比から、評価のずれ */
export function valueLabel(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  if (ratio >= 1.25) return { key: 'over', label: '妙味あり' };
  if (ratio >= 1.08) return { key: 'over-s', label: 'やや妙味' };
  if (ratio <= 0.8) return { key: 'under', label: '人気先行' };
  if (ratio <= 0.92) return { key: 'under-s', label: 'やや人気先行' };
  return { key: 'fair', label: '人気どおり' };
}

/** 結論：買う・見送り・待ち と、その理由 */
function verdictOf(pred, rec) {
  const race = pred.race;
  if (race.provisional) return { kind: 'wait', title: '出馬表待ち', text: '特別登録の段階です。枠順・騎手・単勝オッズが出てから、期待値と当たる確率で買い目を決めます。' };
  if (pred.noOdds || rec?.noOdds) return { kind: 'wait', title: 'オッズ待ち', text: '単勝オッズが出たら、期待値と当たる確率で買い目を決めます。' };
  // 的中重視の自動：自信に応じて金額まで決めた買い目
  if (rec?.auto && rec.tickets?.length) {
    const t = rec.tickets[0];
    const why = t.auto === 'classic' ? 'これまでの的中重視の条件' : `当たる確率 ${pc(t.odds >= MIN_ODDS ? AUTO_STAKE.minP : AUTO_STAKE.lowP)} 以上・期待値 ${AUTO_STAKE.minEv} 以上`;
    return { kind: 'buy', title: '買い', text: `${why}を満たす、利益の見込める買い目があります（当たる確率 ${pc(t.pHit)}・期待値 ${t.ev.toFixed(2)}）。自信に応じて予算の ${Math.round((t.share ?? 1) * 100)}%（${t.stake.toLocaleString('ja-JP')}円）を買い、当たれば少なくとも +${Math.round(t.stake * (t.odds - 1)).toLocaleString('ja-JP')}円です。`, tickets: rec.tickets };
  }
  if (rec?.auto && rec.skipped) return { kind: 'skip', title: '見送り', text: rec.skipReason, dropped: rec.dropped };
  if (rec?.tickets?.length) {
    return {
      kind: 'buy',
      title: '買い',
      text: `期待値の条件と当たる確率${rec.keepMinP ? ` ${pc(rec.keepMinP)} 以上` : ''}の条件を満たす買い目が ${rec.tickets.length}点あります。どれかが当たる確率は ${pc(rec.stats?.hitRate || 0)}。`,
      tickets: rec.tickets,
    };
  }
  if (rec?.dropped?.length) {
    const best = [...rec.dropped].sort((a, b) => b.pHit - a.pHit)[0];
    return { kind: 'skip', title: '見送り', text: `期待値の条件を満たす買い目はありますが、当たる確率が ${pc(rec.keepMinP)} に届きません（いちばん高いもので ${pc(best.pHit)}）。当たりにくい買い目は買わない設定です。`, dropped: rec.dropped };
  }
  if (rec?.skipped) return { kind: 'skip', title: '見送り', text: rec.skipReason || '自信度 S のレースだけ買う設定（控えめ）なので見送りです。' };
  if (rec?.lowOdds) return { kind: 'skip', title: '見送り', text: `期待値の条件を満たすのはオッズ ${LOW_ODDS_LABEL}の買い目だけです。9割当たっても1割しか増えず、外れるとその日の負けになるので買いません。` };
  return { kind: 'skip', title: '見送り', text: 'AI とオッズの見立てが近く、期待値の条件を満たす買い目がありません。オッズに対して割安な馬が見当たらないレースです。' };
}

/** レースの一言の展望（中心の馬・確率・展開・荒れ度） */
function outlookOf(pred, top) {
  const h = top[0];
  if (!h) return '';
  const c = pred.confidence;
  const parts = [];
  const name = h.row.entry.name;
  if (h.row.pWin >= 0.42) parts.push(`${name}が勝率 ${pc(h.row.pWin)}で断然の中心`);
  else if (h.row.pWin >= 0.3) parts.push(`${name}が勝率 ${pc(h.row.pWin)}で中心`);
  else parts.push(`${name}が勝率 ${pc(h.row.pWin)}でわずかに上位の混戦`);
  const second = top[1];
  if (second && h.row.pWin - second.row.pWin < 0.05) parts.push(`${second.row.entry.name}（${pc(second.row.pWin)}）とほぼ互角`);
  if (pred.pace?.label === 'H') parts.push('速い流れで差し・追込に向く');
  else if (pred.pace?.label === 'S') parts.push('遅い流れで前に行ける馬が有利');
  if (c?.volatility === '荒れ') parts.push('人気薄が勝つ可能性も高め');
  else if (c?.volatility === '堅い') parts.push('人気どおりに決まりやすい');
  return `${parts.join('。')}。`;
}

/**
 * レースの分析。jockeys は騎手の成績（短評用）。
 * 返り値：{ verdict, outlook, top, overlays, underlays, course, field }
 */
export function raceAnalysis(pred, rec, { jockeys } = {}) {
  const race = pred.race;
  const oddsKnown = !pred.noOdds;
  const rows = [...pred.rows].sort((a, b) => b.pWin - a.pWin);
  const ratioOf = (r) => (oddsKnown && r.marketProb > 0 ? r.pWin / r.marketProb : null);
  const top = rows.slice(0, 5).map((r) => {
    const ratio = ratioOf(r);
    return { row: r, ratio, value: valueLabel(ratio), comment: horseComment(r, pred, jockeys) };
  });
  // AI がオッズより高く見ている馬（妙味）と、低く見ている人気馬（人気先行）
  const overlays = oddsKnown
    ? rows
        .filter((r) => r.pWin >= 0.04 && ratioOf(r) >= 1.15)
        .sort((a, b) => ratioOf(b) - ratioOf(a))
        .slice(0, 3)
        .map((r) => ({ row: r, ratio: ratioOf(r), reason: horseComment(r, pred, jockeys).pros[0] || null }))
    : [];
  const underlays = oddsKnown
    ? rows
        .filter((r) => r.entry.popularity > 0 && r.entry.popularity <= 4 && ratioOf(r) <= 0.88)
        .sort((a, b) => ratioOf(a) - ratioOf(b))
        .slice(0, 2)
        .map((r) => ({ row: r, ratio: ratioOf(r), reason: horseComment(r, pred, jockeys).cons[0] || null }))
    : [];
  // このレースの脚質の顔ぶれ
  const field = Object.fromEntries(STYLES.map((s) => [s, []]));
  for (const r of pred.rows) if (field[r.style?.style]) field[r.style.style].push(r);
  // このコースの過去の傾向（学習期間）
  const key = `${race.course}|${race.surface}|${race.distance}`;
  const cs = COURSE_STATS?.courses?.[key] || null;
  let course = null;
  if (cs) {
    const styleBest = cs.style ? STYLES.reduce((b, s) => (cs.style[s].win > cs.style[b].win ? s : b), STYLES[0]) : null;
    const innerEdge = cs.inner ? cs.inner.win - cs.inner.runners : null;
    course = { key, ...cs, period: COURSE_STATS.period, styleBest, innerEdge, fitting: styleBest ? field[styleBest].map((r) => r.entry.name) : [] };
  }
  return { verdict: verdictOf(pred, rec), outlook: outlookOf(pred, top), top, overlays, underlays, course, field };
}

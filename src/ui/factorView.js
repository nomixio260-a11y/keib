// 要素ごとの実績（scripts/factor-analysis.mjs）：騎手・厩舎・父・枠・脚質・間隔などで馬を分け、実際の勝ち数を
// 単勝オッズ（市場）が見込んだ勝ち数と比べたもの。「データ」画面の表と、出馬表の各馬の「要素の実績」に使う。

import { FACTOR_STATS } from '../data/factorStats.js';
import { classLevel } from '../engine/constants.js';
import { esc, pct } from './format.js';

export const FACTOR_LABELS = {
  jockey: '騎手',
  trainer: '厩舎',
  sire: '父',
  sireSurface: '父 × 芝ダ',
  gate: '枠（内・中・外）',
  style: '脚質（前の出走の位置取り）',
  rest: '間隔',
  classChange: 'クラスの上下',
  distChange: '距離の変化',
  bodyWeight: '馬体重の増減',
  popularity: '人気',
  jockeyChange: '乗り替わり',
  going: '馬場 × 1番人気',
  age: '年齢',
  sex: '性別',
};
const ORDER = ['popularity', 'rest', 'classChange', 'distChange', 'style', 'gate', 'bodyWeight', 'jockeyChange', 'going', 'age', 'sex', 'jockey', 'trainer', 'sire', 'sireSurface'];

const S = FACTOR_STATS;
const idx = Object.fromEntries((S?.cols || []).map((c, i) => [c, i]));
const rowObj = (r) => (r ? Object.fromEntries(Object.entries(idx).map(([c, i]) => [c, r[i]])) : null);
const lookup = new Map();
for (const [f, rows] of Object.entries(S?.factors || {})) lookup.set(f, new Map(rows.map((r) => [r[0], r])));
/** 要素 f の値 v の実績（なければ null） */
export function factorStat(f, v) {
  return rowObj(lookup.get(f)?.get(v) || null);
}

const aeText = (ae) => (ae == null ? '—' : ae.toFixed(2));
const aeClass = (ae, n) => (ae == null || n < 30 ? '' : ae >= 1.1 ? 'tx-good' : ae <= 0.9 ? 'tx-bad' : '');
const distBand = (d) => (d <= 1400 ? '短距離' : d <= 1800 ? 'マイル' : d <= 2200 ? '中距離' : '長距離');
const dayNum = (d) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86400000);
const restBand = (days) => (days == null ? '初出走' : days < 14 ? '連闘〜中1週' : days < 28 ? '中2〜3週' : days < 56 ? '中4〜7週' : days < 112 ? '2〜3か月' : days < 224 ? '4〜7か月' : '8か月以上');
const bwBand = (d) => (d == null ? null : d <= -10 ? '−10kg以下' : d <= -4 ? '−4〜−8kg' : d <= 2 ? '−2〜+2kg' : d <= 8 ? '+4〜+8kg' : '+10kg以上');

/** 出馬表の1頭について、当てはまる要素の値（scripts/factor-analysis.mjs と同じ分け方） */
export function horseFactorValues(race, entry) {
  const out = [];
  const n = race.entries.filter((e) => !e.scratched).length;
  const past = (entry.past || []).filter((p) => p.date && p.date < race.date).sort((a, b) => (a.date < b.date ? 1 : -1));
  const last = past[0] || null;
  if (entry.jockey) out.push(['jockey', entry.jockey]);
  if (entry.trainer) out.push(['trainer', entry.trainer]);
  if (entry.sire) out.push(['sireSurface', `${entry.sire}|${race.surface}`]);
  out.push(['rest', restBand(last ? dayNum(race.date) - dayNum(last.date) : null)]);
  if (last) {
    const d = classLevel(race.grade) - classLevel(last.grade);
    out.push(['classChange', d > 0 ? '昇級（クラスが上がる）' : d < 0 ? '降級（クラスが下がる）' : '同じクラス']);
    if (last.distance) {
      const dd = race.distance - last.distance;
      out.push(['distChange', dd >= 200 ? '距離延長' : dd <= -200 ? '距離短縮' : '同じ距離']);
    }
    if (last.jockey && entry.jockey) out.push(['jockeyChange', last.jockey === entry.jockey ? '同じ騎手' : '乗り替わり']);
  }
  if (n >= 8 && entry.number) {
    const pos = (entry.number - 1) / (n - 1);
    out.push(['gate', `${race.surface}|${distBand(race.distance)}|${pos <= 1 / 3 ? '内' : pos >= 2 / 3 ? '外' : '中'}`]);
  }
  const bw = bwBand(entry.bodyWeightDiff ?? null);
  if (bw) out.push(['bodyWeight', bw]);
  // 脚質：前の出走（最大4走）の最初のコーナーの位置の平均
  const xs = past
    .slice(0, 4)
    .filter((p) => Array.isArray(p.passing) && p.passing.length && p.fieldSize > 1)
    .map((p) => (p.passing[0] - 1) / (p.fieldSize - 1));
  if (xs.length) {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    out.push(['style', `${race.surface}|${m < 0.12 ? '逃げ' : m < 0.35 ? '先行' : m < 0.65 ? '差し' : '追込'}`]);
  }
  return out;
}

/** 出馬表の1頭の「要素の実績」（実績のある値だけ） */
export function horseFactorHtml(race, entry) {
  if (!S) return '';
  const items = horseFactorValues(race, entry)
    .map(([f, v]) => ({ f, v, s: factorStat(f, v) }))
    .filter((x) => x.s);
  if (!items.length) return '';
  const li = items
    .map(({ f, v, s }) => {
      const shown = f === 'sireSurface' ? v.replace('|', '・') : f === 'gate' || f === 'style' ? v.split('|').join('・') : v;
      return `<li><span class="fx-k">${esc(FACTOR_LABELS[f] || f)}</span><span class="fx-v">${esc(shown)}</span><span class="fx-ae num ${aeClass(s.ae, s.n)}" title="実際の勝ち数 ÷ 単勝オッズの見込みの勝ち数（${s.n.toLocaleString('ja-JP')}頭）">${aeText(s.ae)}</span></li>`;
    })
    .join('');
  return `<div class="fx-horse"><h4>要素の実績 <small>実績 ÷ 市場の見込み（1 より大きいほど人気以上に勝っている）</small></h4><ul class="fx-list">${li}</ul></div>`;
}

function factorTable(f, rows, { limit = 0 } = {}) {
  const yrs = S.years || [];
  let list = rows.map(rowObj);
  if (limit) list = [...list].sort((a, b) => b.n - a.n).slice(0, limit);
  const body = list
    .map((r) => {
      const v = f === 'sireSurface' ? r.value.replace('|', '・') : f === 'gate' || f === 'style' || f === 'going' ? r.value.split('|').join('・') : r.value;
      const years = r.byYear.map((ae, i) => `<span class="fx-y ${aeClass(ae, 30)}" title="${esc(yrs[i])}年">${aeText(ae)}</span>`).join('');
      return `<tr><th scope="row">${esc(v)}</th><td class="num">${r.n.toLocaleString('ja-JP')}</td><td class="num ${aeClass(r.ae, r.n)}">${aeText(r.ae)}</td><td class="num">${r.winRoi != null ? pct(r.winRoi, 0) : '—'}</td><td class="num">${r.placeRoi != null ? pct(r.placeRoi, 0) : '—'}</td><td class="fx-years">${years}</td><td class="num ${aeClass(r.holdAe, r.holdN)}">${r.holdN ? `${aeText(r.holdAe)}<small>（${r.holdN}頭）</small>` : '—'}</td></tr>`;
    })
    .join('');
  return `<div class="table-scroll"><table class="bt-table fx-table">
    <thead><tr><th>${esc(FACTOR_LABELS[f] || f)}</th><th>頭数</th><th>実績÷見込み</th><th>単勝の回収率</th><th>複勝の回収率</th><th>年ごと（${esc(yrs.join('・'))}）</th><th>検証期間</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

/** 「データ」画面：要素ごとの実績 */
export function factorSection() {
  if (!S?.factors) return '';
  const notable = (S.notable || [])
    .slice(0, 12)
    .map((x) => `<li><b>${esc(FACTOR_LABELS[x.factor] || x.factor)}</b> ${esc(String(x.value).split('|').join('・'))}：実績÷見込み ${aeText(x.ae)}（${x.n.toLocaleString('ja-JP')}頭・年ごとに同じ向き ${x.yearsSame}/${x.years}）→ 検証期間 ${aeText(x.holdAe)}（${x.holdN}頭・${x.sameInHold ? '同じ向き' : '逆の向き'}）</li>`)
    .join('');
  const blocks = ORDER.filter((f) => S.factors[f]?.length)
    .map((f) => {
      const many = S.factors[f].length > 20;
      return `<details class="fx-block"${f === 'popularity' ? ' open' : ''}><summary>${esc(FACTOR_LABELS[f] || f)} <small>${S.factors[f].length}通り${many ? '（頭数の多い順に30）' : ''}</small></summary>${factorTable(f, S.factors[f], { limit: many ? 30 : 0 })}</details>`;
    })
    .join('');
  return `<section class="bt-section fx-section">
    <h2 class="section-title">要素ごとの実績 <small>${esc(S.from)}〜${esc(S.to)}・${S.races.toLocaleString('ja-JP')}レース</small></h2>
    <p class="panel-note">騎手・厩舎・父・枠・脚質・間隔などで馬を分け、実際の勝ち数を単勝オッズ（市場）が見込んだ勝ち数と比べました（実績÷見込み。1 より大きいほど人気以上に勝っている）。回収率は単勝・複勝を全部 100円ずつ買った場合です。学習期間（${esc(S.testStart)} より前）の合計と年ごと、検証期間（${esc(S.testStart)} から）を分けています。間隔・前走のクラス・脚質は、そのレースより前の出走だけから作っています。父は ${esc(S.sireFrom)} から（それより前は血統を集めた馬が「その後も走り続けた馬」に偏るため）。</p>
    <p class="panel-note">ほとんどの要素で実績÷見込みは 0.9〜1.1 に収まり、オッズはこれらの要素をほぼ織り込んでいます。何百もの値を調べると、偶然だけでも数個は大きく外れるので、年ごと・検証期間でも同じ向きかを確かめてください。</p>
    ${notable ? `<h3 class="fx-h3">学習期間で見込みと大きく違った値（偶然の可能性も大きい）</h3><ul class="fx-notable">${notable}</ul>` : ''}
    ${blocks}
  </section>`;
}

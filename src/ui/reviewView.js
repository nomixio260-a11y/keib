// 外れたレースの分析：レース一覧の左の欄（その日と表示中の期間の外れ方）と、バックテスト画面の節
// （読み込んだ開催日の集計と、学習期間の分割外・検証期間の長期の分析 src/engine/missStats.js）

import { MISS_KINDS, reviewSummary } from '../engine/review.js';
import { MISS_STATS } from '../engine/missStats.js';
import { esc, pct } from './format.js';

const KIND_ORDER = ['hit', 'near', 'upset', 'overlook'];

/** レースの集まりから、確定したレースの答え合わせ（quickPicks の review と AI推奨の精算） */
export function reviewItems(races, quickPicks) {
  const items = [];
  let pending = 0;
  for (const r of races) {
    if (!r.result?.length || r.jump) continue;
    const p = quickPicks.get(r.id);
    if (!p) {
      pending++;
      continue;
    }
    if (p.review) items.push({ review: p.review, bet: p.settle });
  }
  return { items, pending };
}

const verdictChip = (v) => `<span class="rv-verdict v-${esc(v.key)}">${esc(v.label)}</span>`;

/** 左の欄：その日の外れ方（と、2日以上あれば表示中の期間） */
export function renderReviewCompact(races, ctx) {
  const { items } = reviewItems(races, ctx.quickPicks);
  if (!items.length) return '';
  const s = reviewSummary(items);
  const kinds = KIND_ORDER.filter((k) => k !== 'hit')
    .map((k) => `${MISS_KINDS[k].short} <b class="num">${s.kinds[k]}</b>`)
    .join('・');
  const all = reviewItems(
    ctx.days.flatMap((d) => d.races),
    ctx.quickPicks,
  );
  const ps = all.items.length > items.length ? reviewSummary(all.items) : null;
  const flagged = (ps || s).segments.filter((x) => x.flag);
  return `<div class="ds-review" aria-label="外れ方">
    <div class="ds-title">外れ方 <small>AI の見込みと比べる</small></div>
    <p class="ds-note">◎ <b class="num">${s.hits}</b>勝（見込み ${s.exp.toFixed(1)}）${verdictChip(s.verdict)}<br>${kinds}</p>
    ${ps ? `<p class="ds-note">表示中の${ctx.days.filter((d) => d.races.some((r) => r.result?.length && !r.jump)).length}日：◎ ${ps.hits}/${ps.races}勝（見込み ${ps.exp.toFixed(1)}）${verdictChip(ps.verdict)}</p>` : ''}
    ${flagged.length ? `<p class="ds-note tx-bad">見込みからのずれが大きい条件：${esc(flagged.map((x) => `${x.key}（${x.hits}/${x.n}勝・見込み ${x.exp.toFixed(1)}）`).join('、'))}</p>` : ''}
  </div>`;
}

function liveSection(ctx) {
  const doneDays = ctx.days.filter((d) => d.races.some((r) => r.result?.length && !r.jump));
  const { items, pending } = reviewItems(
    doneDays.flatMap((d) => d.races),
    ctx.quickPicks,
  );
  if (!items.length) return `<p class="muted">確定したレースの答え合わせを計算中です（レース画面を開くと計算が進みます）。</p>`;
  const s = reviewSummary(items);
  const miss = s.races - s.hits;
  const kindRows = KIND_ORDER.map(
    (k) => `<tr><th>${esc(MISS_KINDS[k].label)}${MISS_KINDS[k].desc ? `<small>${esc(MISS_KINDS[k].desc)}</small>` : ''}</th><td class="num">${s.kinds[k]}</td><td class="num">${pct(s.kinds[k] / s.races)}</td><td class="num">${k === 'hit' ? '—' : miss ? pct(s.kinds[k] / miss) : '—'}</td></tr>`,
  ).join('');
  // 条件の区分ごとに見出しの行をはさむ（狭い画面で同じ言葉をくり返さないように）
  let lastDim = '';
  const segRows = s.segments
    .filter((x) => x.n >= 5)
    .map((x) => {
      const group = x.dim !== lastDim ? `<tr class="rv-group"><th colspan="4">${esc(x.label)}</th></tr>` : '';
      lastDim = x.dim;
      const key = x.key.startsWith(x.label) ? x.key.slice(x.label.length).trim() : x.key;
      const verdict = x.n >= 20 ? verdictChip(x.flag ? (x.z > 0 ? { key: 'good', label: '見込みより当たっている' } : { key: 'bad', label: '見込みより外れが多い' }) : { key: 'ok', label: '見込みどおり' }) : '<small class="muted">レースが少ない</small>';
      return `${group}<tr class="${x.flag ? 'is-flag' : ''}"><td>${esc(key)}</td><td class="num">${x.n}</td><td class="num">${x.hits}<small>/${x.exp.toFixed(1)}</small></td><td>${verdict}</td></tr>`;
    })
    .join('');
  const b = s.bets;
  return `<p>表示中の <b>${doneDays.length}日・${s.races}レース</b>${pending ? `（計算中 ${pending}レース）` : ''}の答え合わせです。◎は <b class="num">${s.hits}勝</b>（AI の見込み ${s.exp.toFixed(1)}勝）${verdictChip(s.verdict)}${b.races ? `、AI推奨を買った ${b.races}レースのうち的中 <b class="num">${b.hits}</b>（見込み ${b.exp.toFixed(1)}）${verdictChip(b.verdict)}` : ''}。</p>
    <div class="result-cols">
      <div>
        <h3 class="panel-h3">外れ方の内訳</h3>
        <div class="table-scroll"><table class="rv-table"><thead><tr><th>型</th><th class="num">レース</th><th class="num">全体の</th><th class="num">外れの</th></tr></thead><tbody>${kindRows}</tbody></table></div>
      </div>
      <div>
        <h3 class="panel-h3">条件ごとの◎ <small>勝ち数／見込み（AI の勝率の合計）</small></h3>
        <div class="table-scroll"><table class="rv-table"><thead><tr><th>条件</th><th class="num">レース</th><th class="num">◎の勝ち</th><th>判定</th></tr></thead><tbody>${segRows}</tbody></table></div>
      </div>
    </div>
    <p class="panel-note">判定は「実際の勝ち数 − 見込み」をばらつき（各レースの p(1−p) の合計の平方根）で割った値で、±2 を超えたら「ずれが大きい」としています（20レース以上の区分だけ）。ずれが大きい条件が続けて出るときは、モデルの見直しの合図です。</p>`;
}

function studySection() {
  const m = MISS_STATS;
  if (!m) return '';
  const sets = ['oof', 'hold', 'r60'].filter((k) => m.sets?.[k]);
  const head = sets.map((k) => `<th>${esc(m.sets[k].label)}<small>${esc(m.sets[k].period)}・${m.sets[k].races.toLocaleString('ja-JP')}R</small></th>`).join('');
  const row = (label, f) => `<tr><th>${label}</th>${sets.map((k) => `<td class="num">${f(m.sets[k])}</td>`).join('')}</tr>`;
  const kindRows = [
    row('◎の勝率（AI の見込み）', (s) => `${pct(s.hit)}（${pct(s.exp)}）`),
    row(`${esc(MISS_KINDS.near.label)}<small>${esc(MISS_KINDS.near.desc)}</small>`, (s) => pct(s.kinds.near / (s.races - s.hits))),
    row(`${esc(MISS_KINDS.upset.label)}<small>${esc(MISS_KINDS.upset.desc)}</small>`, (s) => pct(s.kinds.upset / (s.races - s.hits))),
    row(`${esc(MISS_KINDS.overlook.label)}<small>${esc(MISS_KINDS.overlook.desc)}</small>`, (s) => pct(s.kinds.overlook / (s.races - s.hits))),
    row('外れたときの◎の着順', (s) => `2着 ${pct(s.honmeiFin[2] / (s.races - s.hits), 0)}・3着 ${pct(s.honmeiFin[3] / (s.races - s.hits), 0)}・4着以下 ${pct(s.honmeiFin.out / (s.races - s.hits), 0)}`),
    row('◎が1番人気と同じ', (s) => pct(s.favShare)),
    row('◎≠1番人気のときの勝率', (s) => `◎ ${pct(s.diff.honmeiWin)}・1番人気 ${pct(s.diff.favWin)}`),
  ].join('');
  const c = m.calibration;
  return `<h3 class="panel-h3">長期の分析 <small>学習に使っていない予測（${esc(m.generatedAt)}）</small></h3>
    <div class="table-scroll"><table class="rv-table rv-study"><thead><tr><th></th>${head}</tr></thead><tbody>${kindRows}</tbody></table></div>
    <p>外れの約半分は AI の2・3番手が勝った「惜しい外れ」、残りのほとんどは人気も AI も低く見ていた馬が勝った「波乱」で、AI が人気馬を見落とした外れは少数です。AI が1番人気と違う馬を◎にしたレースでは、◎のほうが1番人気より多く勝っています。</p>
    ${recentNote(m)}
    ${c ? `<p>条件（芝ダ・距離・頭数・クラス・馬場・季節・競馬場など）と馬の型（休み明け・キャリア・昇級・距離変化・前走着順・馬体重・脚質・枠など）の${c.dims}項目・${c.cells}区分で、AI の見込みと実際の勝ち数を比べました。学習期間で見込みから大きくずれ（|z| ≥ ${c.zCut}）、検証期間でも同じ向きだった区分は <b>${c.flagged.length ? `${c.flagged.length}区分` : 'ありません'}</b>${c.flagged.length ? `（${esc(c.flagged.join('、'))}）` : ''}。ずれがまったくなくても偶然で約${Math.round(c.cells * 0.0228)}区分はこの条件に当たるので、偶然の範囲です。当日の馬場の傾向（前のレースで前・内の馬が勝っているか）も、オッズにすでに織り込まれていました。外れは決まった型の見落としではなく、確率どおりに起きているものがほとんどです。</p>` : ''}`;
}

/** 直近60日の外れの分析（利用者の依頼 2026-10-05） */
function recentNote(m) {
  const r = m.sets?.r60;
  if (!r) return '';
  const miss = r.races - r.hits;
  const b = m.bets60;
  const rec = m.calibration?.recent || [];
  return `<p><b>直近60日</b>（${esc(r.period)}・${r.races}レース）：◎の勝率は ${pct(r.hit)}（AI の見込み ${pct(r.exp)}）で、見込みどおりかやや上です。外れた ${miss}レースのうち、${pct(r.kinds.near / miss, 0)}は AI の2・3番手が勝った惜しい外れ、${pct(r.kinds.upset / miss, 0)}は人気も AI も低く見ていた馬が勝った波乱で、AI が人気馬を見落とした外れは ${pct(r.kinds.overlook / miss, 0)}だけでした。${
    b?.races ? `AI推奨（的中重視の自動・1R 上限 3,000円・1日の予算つき）は ${b.races}レースを買って ${b.hits}レース的中${b.hits === b.races ? '（外れなし）' : `・外れ ${b.races - b.hits}レース`}、回収率 ${pct(b.roi)}。` : ''
  }</p>${
    rec.length
      ? `<p>直近60日で見込みから大きくずれ、検証期間・学習期間でも同じ向きだった区分：${esc(rec.join('、'))}。長い期間ではずれが小さく（実際÷見込み 0.92〜0.98倍）、勝率を補正すると◎の勝率と当てはまりはわずかに良くなりましたが、的中重視の利益が下がった（学習期間の分割外で回収率 111.0% → 109.1%）ので、予想には入れていません。</p>`
      : ''
  }`;
}

/** バックテスト画面の節 */
export function renderReviewSection(ctx) {
  return `<section class="bt-section review-section" id="review-section">
    <h2 class="section-title">外れたレースの分析 <small>外れ方の型と、AI の見込みどおりか</small></h2>
    ${liveSection(ctx)}
    ${studySection()}
  </section>`;
}

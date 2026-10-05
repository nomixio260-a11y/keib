// 予想画面：レース見出し・出馬表・展開・買い目・重み付け

import { BET_LABEL, COURSES, GOINGS, gradeLabel } from '../engine/constants.js';
import { FACTORS } from '../engine/model.js';
import { STRATEGIES, ESTIMATED_TYPES, BET_TEMP, LOW_ODDS_LABEL, AUTO_STAKE, ticketLabel, evaluateFormations } from '../engine/bets.js';
import { settingsLine } from './settingsView.js';
import { horseComment, paceComment } from '../engine/comments.js';
/** 的中重視の自動：金額の決め方の種類（金額の欄の説明） */
const [ADJ1, ADJ2] = AUTO_STAKE.adjust;
const AUTO_KIND = {
  strong: `当たる確率 ${Math.round(AUTO_STAKE.minP * 100)}% 以上（1.1 倍は ${Math.round(AUTO_STAKE.lowP * 100)}% 以上）で期待値が ${AUTO_STAKE.minEv.toFixed(1)} 以上の強い買い目。自信（有利さ）に応じて上限まで`,
  adjust: `このレースの条件（AI と市場の見立て・オッズ・頭数）で見込む回収率 R̂ に応じた金額（R̂ ${Math.round(ADJ1.minR * 100)}% で予算の ${Math.round(ADJ1.share * 100)}%、高いほど多く。上限は予算の全額）`,
  join: `参加の買い目：強い買い目も調整の買い目もないレースで、当たる確率 ${Math.round(AUTO_STAKE.join.minP * 100)}% 以上・R̂ ${Math.round(AUTO_STAKE.join.minR * 100)}% 以上の複勝を、当たって +${AUTO_STAKE.minProfit}円になる最低額で（発走の${AUTO_STAKE.freshMin}分前より後のオッズのときだけ）`,
  raised: `当たっても利益が ${AUTO_STAKE.minProfit}円に届かない金額だったので、届く最低額まで上げました（予算の ${Math.round(AUTO_STAKE.minStakeUp * 100)}% まで。発走の${AUTO_STAKE.freshMin}分前より後のオッズのときだけ）`,
};
import { speedFigure } from '../engine/speed.js';
import { REAL_STATS } from '../engine/realStats.js';
import { REAL_BACKTEST } from '../data/realBacktest.js';
import { volatilityFactors } from '../engine/volatility.js';
import { raceAnalysis } from '../engine/analysis.js';
import { VOLATILITY_MODEL } from '../engine/volatilityModel.js';
import { formatDateJa, formatShortDate, formatTime } from '../engine/util.js';
import { contribBars, paceMap, positionStrip } from './charts.js';
import { esc, fixed, frameBadge, entryBadge, markClass, odds, pct, signed, STYLE_CLASS, surfaceName, yen } from './format.js';
import { horseFactorHtml } from './factorView.js';
import { gradeChip, statusBadge } from './timeline.js';
import { renderResultPanel } from './resultView.js';
import { startMs } from '../engine/raceTime.js';
import { STAKE_MODEL } from '../engine/stakeModel.js';

const timeOf = (iso) => {
  if (!iso) return '';
  const d = new Date(Date.parse(iso) + 9 * 3600 * 1000);
  return d.toISOString().slice(11, 16);
};

// ---------------------------------------------------------------------------
// レース見出しとサマリー

function renderHead(race, ctx) {
  const { edits, now } = ctx;
  const dir = race.direction || COURSES[race.course]?.dir;
  const going = GOINGS.map(
    (g) => `<button type="button" class="seg-btn${race.going === g ? ' is-on' : ''}" data-going="${g}" aria-pressed="${race.going === g}">${g}</button>`,
  ).join('');
  const hasEdits = edits && (edits.going || Object.keys(edits.odds || {}).length || Object.keys(edits.scratched || {}).length);
  const surf = race.surface === '障' ? '障害' : surfaceName(race.surface);
  let source = '';
  if (race.imported) source = '<span class="pill pill-import">取り込みデータ</span>';
  else if (race.provisional) source = '<span class="src-note">JRA 特別レース登録馬（出馬表の前）</span>';
  else if (race.status === 'result') source = '<span class="src-note">JRA 確定オッズ・結果</span>';
  else if (race.source === 'JRA') {
    const hasOdds = race.entries.some((e) => e.odds > 1);
    source = `<span class="src-note">JRA 出馬表${hasOdds ? `・オッズ ${esc(timeOf(race.oddsAt))} 時点` : '・オッズ未発表'}</span>`;
  }
  return `<div class="race-head">
    <div class="rh-eyebrow">
      <span>${race.date ? esc(formatDateJa(race.date)) : ''} ${esc(race.course)} ${esc(race.raceNo)}R</span>
      ${race.startTime ? `<span class="num">${esc(race.startTime)} 発走</span>` : ''}
      ${race.weather ? `<span>天候 ${esc(race.weather)}</span>` : ''}
      ${race.imported ? '' : statusBadge(race, now, { withTime: true })}
      ${source}
    </div>
    <h1 class="rh-title">${esc(race.name)} ${gradeChip(race.grade)}</h1>
    <div class="rh-chips">
      <span class="chip ${race.surface === '芝' ? 'is-turf' : race.surface === 'ダ' ? 'is-dirt' : ''}">${esc(surf)} ${esc(race.distance)}m${dir ? `（${esc(dir)}${race.lane ? `・${esc(race.lane)}` : ''}）` : ''}</span>
      ${race.ageCond ? `<span class="chip">${esc(race.ageCond)}</span>` : ''}
      ${race.grade ? `<span class="chip">${esc(gradeLabel(race.grade))}</span>` : ''}
      ${race.weightRule ? `<span class="chip">${esc(race.weightRule)}</span>` : ''}
      <span class="chip">${race.provisional ? `登録${race.entries.length}頭${race.maxRunners ? `（出走できるのは${race.maxRunners}頭まで）` : ''}` : `${race.entries.filter((e) => !e.scratched).length}頭`}</span>
    </div>
    ${
      race.provisional
        ? `<p class="prov-note">特別登録の段階の<b>暫定の予想</b>です。枠順・騎手・単勝オッズは出馬表（土曜のレースは木曜、日曜・月曜のレースは金曜〜土曜）で決まり、出たら自動で予想を出し直します。いまの勝率は、登録馬の前4走・負担重量・厩舎などからオッズを使わずに計算した機械学習（AI単独）の予想です（騎手・枠順はまだ使っていません）。${
            race.maxRunners && race.entries.length > race.maxRunners ? `登録が${race.entries.length}頭で出走できる頭数（${race.maxRunners}頭）より多いので、除外・抽選で出走馬が変わります。` : ''
          }</p>`
        : ''
    }
    ${
      race.jump
        ? ''
        : `<div class="rh-controls">
      <div class="seg going-seg" role="group" aria-label="馬場状態"><span class="seg-label">馬場${race.going ? '' : '（未発表）'}</span>${going}</div>
      ${hasEdits ? '<button type="button" class="ghost-btn" data-action="reset-edits">変更を元に戻す</button>' : ''}
    </div>`
    }
  </div>`;
}

/** 検証（学習に使っていない期間）で、同じ自信度のときの◎の成績 */
/** 荒れ度ごとの実績（検証期間）。20レース以上あるときだけ */
export function volRecord(vol, preset = 'balance') {
  const p = REAL_BACKTEST?.presets?.[preset] || REAL_BACKTEST?.presets?.balance;
  const v = p?.byVolatility?.[vol];
  return v && v.n >= 20 ? v : null;
}

export function gradeRecord(grade, preset = 'balance') {
  const p = REAL_BACKTEST?.presets?.[preset] || REAL_BACKTEST?.presets?.balance;
  const g = p?.byGrade?.[grade];
  return g && g.n >= 20 ? g : null;
}

/** 荒れ度の要素の分析（過去のレースで、その条件のときに人気3頭以外が勝った割合） */
function renderVolFactors(pred) {
  const vf = volatilityFactors(pred);
  if (!vf.length) return '';
  const up = vf.filter((f) => f.delta >= 0.02).slice(0, 3);
  const down = vf.filter((f) => f.delta <= -0.02).slice(0, 3);
  const chip = (f) => `<span class="vf-chip ${f.delta > 0 ? 'is-up' : 'is-down'}">${esc(f.value)}</span>`;
  const rows = vf
    .map((f) => `<tr><th>${esc(f.label)}</th><td>${esc(f.value)}</td><td class="num">${pct(f.rate, 0)}</td><td class="num ${f.delta >= 0.02 ? 'tx-bad' : f.delta <= -0.02 ? 'tx-good' : ''}">${f.delta >= 0 ? '+' : '−'}${Math.abs(f.delta * 100).toFixed(0)}pt</td></tr>`)
    .join('');
  return `<details class="vol-factors"><summary>荒れ度の要素${up.length ? `　荒れやすい：${up.map(chip).join('')}` : ''}${down.length ? `　堅い：${down.map(chip).join('')}` : ''}</summary>
    <table class="vf-table"><thead><tr><th>要素</th><th>このレース</th><th>人気3頭以外が勝った割合</th><th>全体との差</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="vf-note">過去のレース（学習期間）で、同じ条件のときに人気3頭以外が勝った割合です（全体 ${pct(VOLATILITY_MODEL.overall, 0)}）。荒れ度の数字そのものは、すべての要素を合わせたモデルの勝率から計算しています。</p>
  </details>`;
}

export function renderSummary(pred, rec, preset = 'balance') {
  const h = pred.order[0];
  const e = h.entry;
  const c = pred.confidence;
  const gr = gradeRecord(c.grade, preset);
  const vr = volRecord(c.volatility, preset);
  const pc = paceComment(pred);
  const dots = Array.from({ length: 5 }, (_, i) => `<span class="meter-dot${i < c.upset ? ' is-on' : ''}"></span>`).join('');
  const nige = pred.rows.filter((r) => r.style.style === '逃げ').length;
  const total = rec.tickets.reduce((a, t) => a + t.stake, 0);
  return `<div class="summary">
    <div class="tile tile-honmei">
      <div class="tile-label">本命</div>
      <div class="tile-main"><span class="mark mk-h big">◎</span>${entryBadge(e)}<span class="tile-horse">${esc(e.name)}</span></div>
      <div class="tile-sub">勝率 <b class="num">${pct(h.pWin)}</b>・複勝率 <b class="num">${pct(h.pTop3)}</b>${h.odds ? `・単勝 <b class="num">${odds(h.odds)}</b>倍` : ''}</div>
    </div>
    <div class="tile tile-pace">
      <div class="tile-label">展開</div>
      <div class="tile-main"><span class="pace-badge pace-${pred.pace.label}">${pred.pace.label}</span><span class="tile-strong">${esc(pc.name)}</span></div>
      <div class="tile-sub">逃げ候補 ${nige}頭・直線${pred.straightBias > 0.4 ? '短め' : pred.straightBias < -0.4 ? '長め' : '標準'}</div>
    </div>
    <div class="tile tile-conf">
      <div class="tile-label">自信度・荒れ度</div>
      <div class="tile-main"><span class="grade-big g-${c.grade}">${c.grade}</span>${
        c.volatility
          ? `<span class="vol-badge v-${['solid', 'mid', 'wild'][c.volatilityIndex ?? 1]}" title="人気3頭以外が勝つ確率 ${pct(c.upsetProb || 0)}">${esc(c.volatility)}</span><span class="meter" role="img" aria-label="荒れ度 ${c.upset} / 5">${dots}</span>`
          : '<span class="vol-badge v-mid" title="単勝オッズの発表後に計算します">荒れ度は—</span>'
      }</div>
      <div class="tile-sub">◎が勝つ確率 <b class="num">${pct(c.winProb ?? c.top, 0)}</b>${c.placeProb != null ? `・複勝圏 <b class="num">${pct(c.placeProb, 0)}</b>` : ''}${gr && !pred.aiOnly ? `<small>（自信度${esc(c.grade)}の実績：勝率 ${pct(gr.winRate, 0)}・複勝 ${pct(gr.top3Rate, 0)}・${gr.n}R）</small>` : ''}<br>${
        c.volatility
          ? `人気3頭以外が勝つ確率 <b class="num">${pct(c.upsetProb || 0, 0)}</b>${vr ? `<small>（「${esc(c.volatility)}」の実績 ${pct(vr.upsetRate, 0)}・${vr.n}R）</small>` : ''}`
          : '人気3頭以外が勝つ確率（荒れ度）は、単勝オッズの発表後に計算します'
      }</div>
      ${renderVolFactors(pred)}
    </div>
    <a class="tile tile-link tile-bets" href="#panel-bets" data-action="goto-bets">
      <div class="tile-label">AI推奨（${esc(STRATEGIES[rec.strategy].label)}）</div>
      ${
        rec.noOdds && pred.race.provisional
          ? '<div class="tile-main"><span class="tile-strong">出馬表待ち</span></div><div class="tile-sub">枠順・騎手・単勝オッズが出たら買い目を計算します</div>'
          : rec.noOdds
          ? '<div class="tile-main"><span class="tile-strong">オッズ待ち</span></div><div class="tile-sub">単勝オッズが出たら買い目を計算します</div>'
          : `<div class="tile-main"><span class="tile-strong num">${rec.tickets.length}点</span><span class="tile-strong num">${yen(total)}</span></div>
      <div class="tile-sub">${rec.tickets.length ? `的中率 <b class="num">${pct(rec.stats.hitRate)}</b>・AI想定の回収率 <b class="num">${pct(rec.stats.roi, 0)}</b>` : '条件に合う買い目なし（見送り）'}</div>`
      }
    </a>
  </div>`;
}

// ---------------------------------------------------------------------------
// 出馬表

function evClass(ev) {
  if (ev == null) return '';
  if (ev >= 1.2) return 'ev-hi';
  if (ev >= 1.0) return 'ev-ok';
  return 'ev-lo';
}

function pastTable(row, race, stats) {
  const runs = row?.runs?.length ? row.runs : [];
  if (!runs.length) return '<p class="muted">出走歴がありません（初出走）。騎手・枠順・人気から評価しています。</p>';
  const body = runs
    .map((r) => {
      const si = speedFigure(r, stats || REAL_STATS);
      const fin = r.finish > 0 ? r.finish : '中止';
      return `<tr>
        <td class="num">${esc(formatShortDate(r.date))}</td>
        <td>${esc(r.course)}</td>
        <td class="pp-race">${esc(r.raceName || '')}${r.grade ? `<small>${esc(gradeLabel(r.grade))}</small>` : ''}</td>
        <td><span class="${r.surface === '芝' ? 'tx-turf' : 'tx-dirt'}">${esc(r.surface)}</span>${esc(r.distance)} ${esc(r.going)}</td>
        <td class="num pp-fin${r.finish === 1 ? ' is-win' : r.finish > 0 && r.finish <= 3 ? ' is-top3' : ''}">${esc(fin)}<small>/${esc(r.fieldSize)}</small></td>
        <td class="num">${esc(formatTime(r.time))}</td>
        <td class="num">${r.margin != null ? esc(Number(r.margin).toFixed(1)) : '—'}</td>
        <td class="num">${r.last3f ? esc(Number(r.last3f).toFixed(1)) : '—'}${r.last3fRank ? `<small>(${esc(r.last3fRank)})</small>` : ''}</td>
        <td class="num">${esc((r.passing || []).join('-'))}</td>
        <td class="num pp-si">${si != null ? esc(si.toFixed(0)) : '—'}</td>
        <td>${esc(r.jockey || '')}</td>
        <td class="num">${r.weight ? esc(r.weight) : ''}</td>
        <td class="num">${r.popularity ? `${esc(r.popularity)}人` : ''}</td>
      </tr>`;
    })
    .join('');
  return `<div class="table-scroll"><table class="pp">
    <thead><tr><th>日付</th><th>場</th><th>レース</th><th>条件</th><th>着順</th><th>タイム</th><th>着差</th><th>上り</th><th>通過</th><th title="スピード指数">指数</th><th>騎手</th><th>斤量</th><th>人気</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

function detailPanel(entry, row, pred, ctx) {
  const race = pred.race;
  const factors = FACTORS.filter((f) => pred.coefs[f.key] > 0);
  const maxAbs = Math.max(0.01, ...pred.rows.flatMap((r) => factors.map((f) => Math.abs(r.contrib[f.key]))));
  const scratched = !!entry.scratched;
  // 過去の日は、その日より前のデータだけで作った騎手・厩舎の成績（ctx.statsFor）。これからの日は全期間
  const st = ctx.statsFor?.(race.date) || REAL_STATS;
  const jockeys = race.jockeys && Object.keys(race.jockeys).length ? race.jockeys : st.jockeyRates;
  const trainerRate = st.trainerRates?.[entry.trainer];
  const comment = row ? horseComment(row, pred, jockeys) : null;
  const j = jockeys?.[entry.jockey];
  const bw = entry.bodyWeight ? `${entry.bodyWeight}kg${entry.bodyWeightDiff != null ? `（${signed(entry.bodyWeightDiff)}）` : ''}` : '—';
  const editBox = `<div class="d-edit">
      <label class="field-inline">単勝オッズ<input type="number" inputmode="decimal" step="0.1" min="1" id="odds-${esc(race.id)}-${esc(entry.number)}" data-odds="${esc(entry.number)}" value="${entry.odds ?? ''}"></label>
      <label class="check"><input type="checkbox" data-scratch="${esc(entry.number)}" ${scratched ? 'checked' : ''}>出走取消</label>
    </div>`;
  const comments = row
    ? `<div class="d-comment">
        ${comment.pros.length ? `<p><span class="d-tag is-pro">強み</span>${comment.pros.map(esc).join('、')}</p>` : ''}
        ${comment.cons.length ? `<p><span class="d-tag is-con">不安</span>${comment.cons.map(esc).join('、')}</p>` : ''}
      </div>`
    : '<p class="muted d-comment">出走取消のため予想から外しています。</p>';
  const analysis = row
    ? `<div class="d-block">
        <h4 class="d-h">評価の内訳 <small>能力スコアへの寄与（今の重み付け）</small></h4>
        ${contribBars(row, factors, maxAbs)}
      </div>
      <div class="d-block">
        <h4 class="d-h">着順の分布 <small>1〜3着は厳密計算・4着以下は${pred.sim.sims.toLocaleString('ja-JP')}回のシミュレーション</small></h4>
        ${positionStrip(row.posDist)}
        <p class="d-dist-note">1着 <b class="num">${pct(row.posDist[0])}</b>・2着 <b class="num">${pct(row.posDist[1] ?? 0)}</b>・3着 <b class="num">${pct(row.posDist[2] ?? 0)}</b></p>
        ${editBox}
      </div>`
    : `<div class="d-block">${editBox}</div>`;
  return `<div class="detail-grid">
    <div class="d-left">${comments}${analysis}</div>
    <div class="d-right">
      <h4 class="d-h">近走成績（馬柱）</h4>
      ${pastTable(row || { runs: entry.past }, race, ctx.stats)}
      <dl class="d-meta">
        <div><dt>父</dt><dd>${esc(entry.sire || '—')}</dd></div>
        ${entry.damSire ? `<div><dt>母の父</dt><dd>${esc(entry.damSire)}</dd></div>` : ''}
        <div><dt>厩舎</dt><dd>${esc(entry.trainer || '—')}${entry.trainerArea ? `（${esc(entry.trainerArea)}）` : ''}</dd></div>
        ${trainerRate ? `<div><dt>厩舎成績</dt><dd class="num">勝率 ${pct(trainerRate.winRate)}・複勝率 ${pct(trainerRate.top3Rate)}</dd></div>` : ''}
        <div><dt>馬体重</dt><dd class="num">${esc(bw)}</dd></div>
        ${entry.placeMin > 1 ? `<div><dt>複勝オッズ</dt><dd class="num">${odds(entry.placeMin)}〜${odds(entry.placeMax)}</dd></div>` : ''}
        <div><dt>騎手成績</dt><dd class="num">${j ? `勝率 ${pct(j.winRate)}・複勝率 ${pct(j.top3Rate)}${j.starts ? `（${j.starts}騎乗）` : ''}` : '—'}</dd></div>
        ${row ? `<div><dt>AI指数</dt><dd class="num">${fixed(row.index)}（${row.aiRank}位・勝率は${row.rank}位）</dd></div><div><dt>脚質</dt><dd>${esc(row.style.style)}</dd></div><div><dt>スピード指数</dt><dd class="num">最高 ${row.stats.bestSi != null ? row.stats.bestSi.toFixed(0) : '—'}・前走 ${row.stats.lastSi != null ? row.stats.lastSi.toFixed(0) : '—'}</dd></div>` : ''}
      </dl>
      ${horseFactorHtml(race, entry)}
    </div>
  </div>`;
}

function finCell(race, num) {
  if (!race.result?.length) return '';
  const f = race.finishes?.[num];
  const txt = typeof f === 'number' && f > 0 ? f : f || '—';
  const cls = f === 1 ? ' is-win' : typeof f === 'number' && f > 0 && f <= 3 ? ' is-top3' : '';
  return `<td class="c-fin num${cls}">${esc(txt)}</td>`;
}

export function renderCardTable(pred, ctx) {
  const { state } = ctx;
  const race = pred.race;
  const hasResult = !!race.result?.length;
  const byNum = new Map(pred.rows.map((r) => [r.entry.number, r]));
  const maxWin = Math.max(...pred.rows.map((r) => r.pWin), 0.01);
  let entries = [...race.entries];
  if (state.sort === 'ai') entries.sort((a, b) => (byNum.get(b.number)?.pWin ?? -1) - (byNum.get(a.number)?.pWin ?? -1));
  else if (state.sort === 'finish' && hasResult) {
    const fo = (e) => (typeof race.finishes?.[e.number] === 'number' && race.finishes[e.number] > 0 ? race.finishes[e.number] : 99);
    entries.sort((a, b) => fo(a) - fo(b) || a.number - b.number);
  }
  const expanded = new Set(state.expanded[race.id] || []);
  const cols = hasResult ? 12 : 11;
  const rows = entries
    .map((e) => {
      const r = byNum.get(e.number);
      const open = expanded.has(e.number);
      const scratched = !!e.scratched || !r;
      const cells = r
        ? `<td class="c-index num">${fixed(r.index)}</td>
           <td class="c-win"><span class="pbar" aria-hidden="true"><span style="width:${((r.pWin / maxWin) * 100).toFixed(1)}%"></span></span><span class="num">${pct(r.pWin)}</span></td>
           <td class="c-top3 num">${pct(r.pTop3)}</td>
           <td class="c-odds num">${odds(e.odds)}<small>${e.popularity ? `${e.popularity}人気` : ''}</small></td>
           <td class="c-ev num ${evClass(r.ev)}">${r.ev != null ? r.ev.toFixed(2) : '—'}</td>`
        : `<td class="c-index"></td><td class="c-win"><span class="scratch-tag">取消</span></td><td class="c-top3"></td><td class="c-odds num">${odds(e.odds)}</td><td class="c-ev"></td>`;
      return `<tr class="row${open ? ' is-open' : ''}${scratched ? ' is-scratched' : ''}" data-num="${esc(e.number)}">
        ${finCell(race, e.number)}
        <td class="c-mark">${r?.mark ? `<span class="mark ${markClass(r.mark)}">${esc(r.mark)}</span>` : ''}</td>
        <td class="c-frame f${e.provisionalNumber ? '0' : esc(e.frame)}"><span>${e.provisionalNumber ? '' : esc(e.frame)}</span></td>
        <td class="c-num"><span class="num-box">${e.provisionalNumber ? '—' : esc(e.number)}</span></td>
        <td class="c-horse"><span class="h-name">${esc(e.name)}</span><span class="h-sub">${esc(`${e.sex || ''}${e.age ?? ''}`)}${e.weight ? ` · ${esc(e.weight)}kg` : ''}${e.jockey ? ` · ${esc(e.jockey)}` : ''}</span></td>
        <td class="c-style">${r ? `<span class="style-chip ${STYLE_CLASS[r.style.style]}">${esc(r.style.style)}</span>` : ''}</td>
        ${cells}
        <td class="c-toggle"><button type="button" class="icon-btn" data-toggle="${esc(e.number)}" aria-expanded="${open}" aria-label="${esc(e.name)}の詳細"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button></td>
      </tr>${open ? `<tr class="detail"><td colspan="${cols}">${detailPanel(e, r, pred, ctx)}</td></tr>` : ''}`;
    })
    .join('');
  const sortBtn = (key, label) =>
    `<button type="button" class="seg-btn${state.sort === key || (key === 'number' && !['ai', 'finish'].includes(state.sort)) ? ' is-on' : ''}" data-sort="${key}" aria-pressed="${state.sort === key}">${label}</button>`;
  return `<div class="card-tools">
      <div class="seg" role="group" aria-label="並び順">
        <span class="seg-label">並び順</span>
        ${sortBtn('number', race.provisional ? '登録順' : '馬番')}${sortBtn('ai', '勝率順')}${hasResult ? sortBtn('finish', '着順') : ''}
      </div>
      <p class="card-hint">${race.provisional ? '特別登録の馬（50音順）です。枠・馬番・騎手は出馬表で決まります。行を押すと前4走と評価の内訳が開きます。' : pred.noOdds ? `単勝オッズの発表前です。人気・期待値はオッズが出てから表示します。${pred.aiOnly ? 'いまの勝率はオッズを使わない機械学習（AI単独）の予想です（学習に使っていない期間で◎の勝率 約30%。オッズが出ると、オッズも使う機械学習の予想に切り替わります）。' : ''}` : '行を押すと馬柱・評価の内訳・オッズ修正が開きます'}</p>
    </div>
    <div class="table-scroll card-scroll"><table class="card${hasResult ? ' has-fin' : ''}">
    <thead><tr>
      ${hasResult ? '<th class="c-fin" title="確定着順">着</th>' : ''}<th class="c-mark" title="印">印</th><th class="c-frame" title="枠番">枠</th><th class="c-num">馬番</th><th class="c-horse">馬名</th><th class="c-style">脚質</th>
      <th class="c-index" title="オッズを使わない AI単独の評価をレース内の偏差値にしたもの（平均50）。勝率は今の重み付け（既定は総合）で計算">AI指数</th><th class="c-win">勝率</th><th class="c-top3">複勝率</th><th class="c-odds">単勝</th><th class="c-ev" title="勝率 × 単勝オッズ。1.0を超えると理論上プラス">期待値</th><th class="c-toggle"><span class="sr-only">詳細</span></th>
    </tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------
// サイドパネル

export function renderPacePanel(pred) {
  const pc = paceComment(pred);
  const counts = ['逃げ', '先行', '差し', '追込'].map((s) => ({ s, n: pred.rows.filter((r) => r.style.style === s).length }));
  return `<section class="panel" id="panel-pace" aria-labelledby="h-pace">
    <header class="panel-head"><h2 id="h-pace">展開予想</h2><span class="pace-badge pace-${pred.pace.label}">${pred.pace.label}</span><span class="panel-sub">${esc(pc.name)}</span></header>
    <div class="pace-map-wrap">${paceMap(pred)}</div>
    <p class="panel-text">${esc(pc.text)}</p>
    <ul class="style-counts">${counts.map((c) => `<li><span class="style-chip ${STYLE_CLASS[c.s]}">${c.s}</span><span class="num">${c.n}</span></li>`).join('')}</ul>
  </section>`;
}

/**
 * 買う時刻の案内（的中重視の自動・発走前のレース）：オッズの時点（発走の何分前か）と、買う時刻ごとの収支の推定（stakeModel.js の check.timing。
 * 学習に使っていない 2024年4月〜検証の前・1R 1,000円）
 */
function buyTimeNote(race) {
  const st = startMs(race);
  const at = race.oddsAt ? Date.parse(race.oddsAt) : null;
  if (!st || race.result?.length || Date.now() > st) return '';
  const before = at ? Math.round((st - at) / 60000) : null;
  const t = STAKE_MODEL?.check?.timing || [];
  const long = (row) => (row ? Object.entries(row.summary).filter(([k]) => k !== 'hold').reduce((s, [, x]) => s + x.profit, 0) : null);
  const signedK = (v) => `${v >= 0 ? '+' : '−'}${(Math.abs(v) / 10000).toFixed(1)}万円`;
  const parts = t.filter((row) => ['m1', 'm5', 'm10', 'm60'].includes(row.prefix)).map((row) => `${row.prefix === 'm1' ? '直前' : row.label.replace('発走', '')} ${signedK(long(row))}`);
  return `<p class="panel-note bt-buytime">${before != null ? `オッズは ${esc(timeOf(race.oddsAt))} 時点${before >= 0 ? `（発走の${before}分前）` : ''}。` : ''}<b>買うのは発走直前の最後の更新で</b>（即PAT の締切は発走1分前）：いま高く見えるオッズほど確定までに下がるので、オッズが確定に近いほど有利です${parts.length ? `（同じ規則で、2024年4月〜2026年6月の収支の推定：${parts.join('・')}、1R 1,000円）` : ''}。</p>`;
}

export function renderBetsPanel(pred, rec, ctx) {
  const { state } = ctx;
  const total = rec.tickets.reduce((a, t) => a + t.stake, 0);
  const body = rec.noOdds && pred.race.provisional
    ? '<tr><td colspan="6" class="muted bt-empty">特別登録の段階です。出馬表（枠順・騎手）と単勝オッズが出てから、期待値で買い目を選びます。</td></tr>'
    : rec.noOdds
    ? '<tr><td colspan="6" class="muted bt-empty">単勝オッズの発表前です。オッズが出ると、期待値から買い目を選びます（土曜のレースは金曜、日曜のレースは土曜に前日発売が始まります）。</td></tr>'
    : rec.tickets.length
    ? rec.tickets
        .map(
          (t) => `<tr>
          <td>${esc(BET_LABEL[t.type])}${rec.auto && t.auto === 'adjust' ? `<small class="bt-sub" title="${esc(AUTO_KIND.adjust)}">調整</small>` : ''}${rec.auto && t.auto === 'join' ? `<small class="bt-sub" title="${esc(AUTO_KIND.join)}">参加</small>` : ''}</td>
          <td class="num bt-combo">${esc(ticketLabel(t))}</td>
          <td class="num">${pct(t.pHit ?? t.pEv ?? t.p)}</td>
          <td class="num">${odds(t.odds)}${t.oddsMax ? `<small title="複勝オッズの範囲（下限で計算）">〜${odds(t.oddsMax)}</small>` : ''}${t.estimated ? '<small title="単勝オッズからの推定">推</small>' : t.type !== 'win' ? '<small class="tx-good" title="JRA の実際のオッズ">実</small>' : ''}</td>
          <td class="num ${evClass(t.ev)}">${t.ev.toFixed(2)}${t.oddsExp && t.oddsExp > t.odds + 0.005 ? `<small class="bt-sub" title="払戻の見込み（下限〜上限の幅から）">見込み${odds(t.oddsExp)}倍</small>` : ''}${rec.auto && t.r != null ? `<small class="bt-sub" title="このレースの条件で見込む回収率（R̂）：学習期間に発走前のオッズで選んだ同じような買い目が、実際にいくら戻ったか">回収見込み${pct(t.r, 0)}</small>` : ''}</td>
          <td class="num">${t.stake.toLocaleString('ja-JP')}${rec.auto ? `<small class="bt-sub" title="${esc((t.raised ? AUTO_KIND.raised : AUTO_KIND[t.auto]) || '')}">${t.raised || t.auto === 'join' ? '最低額・' : ''}予算の${Math.round((t.share ?? t.stake / rec.budget) * 100)}%</small>` : ''}</td>
        </tr>`,
        )
        .join('')
    : rec.skipped
    ? `<tr><td colspan="6" class="muted bt-empty">${esc(rec.skipReason || '自信度 S のレースだけ買う設定（控えめ）なので、このレースは見送りです。')}</td></tr>`
    : rec.dropped?.length
    ? `<tr><td colspan="6" class="muted bt-empty">期待値の条件を満たす買い目はありましたが、当たる確率が ${pct(rec.keepMinP, 0)} 以上のものがないので見送りです（下の「外した買い目」）。</td></tr>`
    : rec.lowOdds
    ? `<tr><td colspan="6" class="muted bt-empty">期待値の条件を満たすのはオッズ ${LOW_ODDS_LABEL}の買い目だけなので見送りです（9割当たっても1割しか増えず、外れるとその日の負けになるため買いません）。</td></tr>`
    : `<tr><td colspan="6" class="muted bt-empty">期待値の条件（${STRATEGIES[rec.strategy].minEv.toFixed(2)}以上）を満たす買い目がありません。このレースは見送りか、戦略や券種を変えてみてください。${
        state.betTypes.includes('place') && !pred.rows.some((r) => r.entry.placeMin > 1)
          ? '<br>複勝の実際のオッズは発走の2時間ほど前から取り込みます。それまでは単勝オッズからの推定（控えめ）で計算しています。'
          : ''
      }</td></tr>`;
  const forms = evaluateFormations(pred, state.blend);
  const formRows = forms
    .map(
      (f) => `<tr><td>${esc(f.label)}</td><td class="num">${f.points}</td><td class="num">${pct(f.hitRate)}</td><td class="num ${f.roi >= 1 ? 'ev-ok' : 'ev-lo'}">${pct(f.roi, 0)}</td></tr>`,
    )
    .join('');
  return `<section class="panel" id="panel-bets" aria-labelledby="h-bets">
    <header class="panel-head"><h2 id="h-bets">買い目</h2><span class="panel-sub">期待値（確率×推定オッズ）で選定</span></header>
    ${settingsLine(state)}
    ${rec.auto && !rec.noOdds ? buyTimeNote(pred.race) : ''}
    ${rec.formLabel ? `<p class="panel-note bt-auto">このレース：荒れ度「${esc(pred.confidence?.volatility || '')}」→ <b>${esc(rec.formLabel)}</b></p>` : ''}
    ${
      state.betTypes.some((t) => ESTIMATED_TYPES.includes(t))
        ? pred.race.exoticOdds
          ? '<p class="panel-note">馬連・ワイド・三連複は JRA の実際のオッズ（「実」）で計算しています。馬単・三連単は単勝オッズからの推定（「推」）です。</p>'
          : '<p class="panel-note bet-caution">馬連・ワイド・馬単・三連複・三連単のオッズは単勝オッズからの推定です（発走2時間前から馬連・ワイド・三連複は実際のオッズを取り込みます）。</p>'
        : ''
    }
    ${
      rec.auto && rec.day
        ? `<p class="panel-note">${
            rec.day.limit != null
              ? `1日の予算 ${yen(rec.day.limit)}：この日は${rec.day.races}レース・合計 ${yen(rec.day.total)}${rec.day.over ? ` → 予算の範囲で ${yen(rec.day.used)}（発走の早いレースから順に）` : '（予算の範囲内）'}。`
              : `1日の予算はなし：この日は${rec.day.races}レース・合計 ${yen(rec.day.total)}。`
          }${rec.day.over && rec.tickets?.some((t) => t.dayCut) ? '<br><span class="bet-caution">このレースは1日の予算の残りの分だけ買います（金額を減らしています）。</span>' : ''}${rec.day.over && !rec.tickets?.length && rec.dropped?.some((t) => t.why === 'day') ? '<br><span class="bet-caution">このレースの買い目は1日の予算に入らなかったので見送りです。</span>' : ''}</p>`
        : ''
    }
    ${(() => {
      const flat = (STRATEGIES[state.strategy].betTemp ?? BET_TEMP) !== 1;
      const exotic = state.strategy === 'hit' && state.betTypes.some((t) => ['quinella', 'wide', 'trio', 'trifecta', 'exacta'].includes(t));
      const parts = [];
      if (rec.auto) {
        parts.push(`<b>自動（レースごとに調整）</b>：毎レース、単勝・複勝の買い目ごとに、当たる確率と払戻の見込み（複勝はオッズの下限〜上限の幅と当たる確率から）で期待値と有利さを出し、さらに<b>このレースの条件で見込む回収率（R̂）</b>を出して、1つの式で金額を決めます。金額のいちばん大きい1点を買います。予算は上限で、使い切るとは限りません${rec.tickets.length ? `（このレース ${yen(rec.used)}・予算の ${Math.round((rec.used / rec.budget) * 100)}%）` : ''}。`);
        parts.push(`・強い買い目：当たる確率 ${pct(AUTO_STAKE.minP, 0)} 以上（1.1 倍は ${pct(AUTO_STAKE.lowP, 0)} 以上）で期待値が ${AUTO_STAKE.minEv.toFixed(1)} 以上 → 自信に応じて上限まで（有利さが ${pct(AUTO_STAKE.fullAt, 0)} 未満なら減らす）。期待値の余裕は、いま見ているオッズが確定までに動く分です`);
        parts.push(`・レースごとの調整（「調整」）：それ以外は、R̂ が ${pct(ADJ1.minR, 0)} 以上（当たる確率 ${pct(ADJ1.minP, 0)} 以上・期待値 ${ADJ1.minEv.toFixed(1)} 以上の複勝。単勝は ${pct(ADJ1.minRBy?.win ?? ADJ1.minR, 0)} 以上）か ${pct(ADJ2.minR, 0)} 以上（当たる確率 ${pct(ADJ2.minP, 0)} 以上の複勝）なら、予算の ${pct(ADJ1.share, 0)} から R̂ が高いほど多く（R̂ 1ポイントごとに予算の ${ADJ1.slope}%・${ADJ2.slope}%、上限は全額）`);
        parts.push(`・参加の買い目（「参加」。見送りを減らす）：どちらもないレースでも、当たる確率 ${pct(AUTO_STAKE.join.minP, 0)} 以上・R̂ ${pct(AUTO_STAKE.join.minR, 0)} 以上の複勝があれば、当たる確率のいちばん高い1点を、当たって +${AUTO_STAKE.minProfit}円になる最低額（予算の ${pct(AUTO_STAKE.join.maxShare, 0)} まで）で買います。直前のオッズでは回収率 約97%・的中率 約64% で、ほぼ損をせずに買うレースを増やします。発走の${AUTO_STAKE.freshMin}分前より後のオッズのときだけで（10分前のオッズでは回収率 92% と損）、1日の予算の最後の ${AUTO_STAKE.dayBudget.reserve}レース分は使いません（後のレースの強い買い目のため）`);
        parts.push('・R̂ は、AI の期待値・単勝オッズから見た市場の期待値・オッズ・頭数から、学習期間に発走前のオッズで選んだ同じような買い目が実際にいくら戻ったかで出します。負けたレースを分析すると、いま高く見えるオッズは確定までに下がりやすく（選んだ複勝の払戻は見込みの 8〜9割）、AI と市場の見立ての差が大きいほど当たる確率を高く見すぎていたので、レースごとにその分を割り引きます');
        parts.push(`・当たっても利益が ${AUTO_STAKE.minProfit}円に届かない金額のときは、届く最低額まで上げます（予算の ${pct(AUTO_STAKE.minStakeUp, 0)} まで。それより多く要るなら買いません）。どれもなければ見送り`);
        if (exotic) parts.push('馬連・ワイド・三連複などの組み合わせの券種は、発走前のオッズで選ぶと長い期間で損だったので、自動では買いません。');
      } else if (flat) parts.push(`買い目は、勝率を少し平らにして（荒れ度の${BET_TEMP}倍）、オッズを混ぜない AI の確率で期待値 ${STRATEGIES[state.strategy].minEv.toFixed(1)} 以上のものだけを選びます。単勝/複勝の的中重視で、学習期間の分割外 約1.2万レース（186週）の回収率 94.6% → 107.5%（週平均 −2,115円 → +601円）、直近14週 99.3% → 129.2%（−256円 → +1,961円）。的中率・期待値の欄はこの値です。`);
      if (exotic && !rec.auto) parts.push('的中重視は当たる確率 50% 以上の買い目だけを買うので、馬連・馬単・三連複・三連単はほとんど選ばれません（学習期間 385日で馬連 1点）。単勝・複勝だけとほぼ同じ成績です。');
      return parts.length ? `<details class="bet-how"><summary>この買い方のしくみ</summary><p class="panel-note">${parts.join('<br>')}</p></details>` : '';
    })()}
    <div class="table-scroll"><table class="bets">
      <thead><tr><th>券種</th><th>買い目</th><th title="AI の予想（平らにしない元の確率）で当たる確率">的中率</th><th>オッズ</th><th title="${rec.auto ? 'AI の当たる確率 × 払戻の見込み（複勝は下限〜上限の幅から）' : '少し平らにした AI の確率（とオッズの確率を混ぜた値）× オッズ'}">期待値</th><th>金額</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${
      rec.dropped?.length && rec.auto
        ? `<details class="bet-dropped"><summary>買わなかった候補 ${rec.dropped.length}点</summary><ul>${rec.dropped
            .map((t) => `<li>${esc(BET_LABEL[t.type])} <b class="num">${esc(ticketLabel(t))}</b> 当たる確率 <span class="num">${pct(t.pHit)}</span>・オッズ <span class="num">${odds(t.odds)}</span>・期待値 <span class="num">${t.ev.toFixed(2)}</span>${t.r != null ? `・回収見込み <span class="num">${pct(t.r, 0)}</span>` : ''} <small>${t.why === 'one' ? '（1レースで買う点数・予算の上限のため）' : t.why === 'thin' ? `（当たっても利益が ${AUTO_STAKE.minProfit}円に届かない金額）` : t.why === 'low' ? `（${LOW_ODDS_LABEL}は当たる確率 ${pct(AUTO_STAKE.lowP, 0)} 以上のときだけ）` : t.why === 'day' ? '（1日の予算に入らない）' : t.why === 'small' ? '（予算が小さく、金額が 100円に届かない）' : '（利益の見込みが足りない）'}</small></li>`)
            .join('')}</ul><p class="muted">強い買い目（当たる確率 ${pct(AUTO_STAKE.minP, 0)} 以上・期待値 ${AUTO_STAKE.minEv.toFixed(1)} 以上）か、このレースの条件で見込む回収率（R̂）が ${pct(ADJ1.minR, 0)} 以上（単勝は ${pct(ADJ1.minRBy?.win ?? ADJ1.minR, 0)} 以上）の買い目のうち、金額のいちばん大きい1点を、当たって ${AUTO_STAKE.minProfit}円以上の利益になる金額で買います。どちらもなければ、当たる確率 ${pct(AUTO_STAKE.join.minP, 0)} 以上・R̂ ${pct(AUTO_STAKE.join.minR, 0)} 以上の複勝を参加の買い目として最低額で（その日の買い目の合計が1日の予算を超えたら、発走の早いレースから順に予算まで）。発走前のオッズで選んだ場合の推定は、バックテスト画面にあります。</p></details>`
        : rec.dropped?.length
        ? `<details class="bet-dropped"><summary>外した買い目 ${rec.dropped.length}点（当たる確率が ${pct(rec.keepMinP, 0)} 未満）</summary><ul>${rec.dropped
            .map((t) => `<li>${esc(BET_LABEL[t.type])} <b class="num">${esc(ticketLabel(t))}</b> 当たる確率 <span class="num">${pct(t.pHit)}</span>・オッズ <span class="num">${odds(t.odds)}</span>・期待値 <span class="num">${t.ev.toFixed(2)}</span></li>`)
            .join('')}</ul><p class="muted">期待値の条件は満たしていますが、当たりにくいので買いません。学習に使っていない約1.2万レースで、こうして絞ると的中率が 52% → 76% に上がり、損が続いたときの落ち込みが約3分の1になりました（回収率は 107.5% → 105.4%）。</p></details>`
        : ''
    }
    <dl class="bet-stats">
      <div><dt>合計</dt><dd class="num">${yen(total)}</dd></div>
      <div><dt>どれかが当たる確率</dt><dd class="num">${pct(rec.stats.hitRate)}</dd></div>
      <div><dt>AI想定の回収率</dt><dd class="num">${pct(rec.stats.roi, 0)}</dd></div>
      <div><dt>収支がプラスになる確率</dt><dd class="num">${pct(rec.stats.profitRate)}</dd></div>
    </dl>
    <p class="panel-note">AIとオッズの見立てがずれた馬券ほど期待値が高く見えます（勝者の呪い）。オッズの確率を混ぜるほど見込みは控えめで現実に近くなります。的中率はAIのシミュレーション、回収率は混ぜた確率で計算した見込みなので、実際の成績はバックテストで確かめてください。</p>
    <div class="panel-actions">
      <button type="button" class="btn" data-action="copy-bets" ${rec.tickets.length ? '' : 'disabled'}>買い目をコピー</button>
      <span class="copy-status" role="status" aria-live="polite"></span>
    </div>
    <textarea class="copy-fallback" id="copy-fallback-bets" readonly hidden aria-label="コピー用の買い目"></textarea>
    <h3 class="panel-h3">印から組む定番の買い方 <small>1点100円</small></h3>
    <div class="table-scroll"><table class="bets forms">
      <thead><tr><th>買い方</th><th>点数</th><th>的中率</th><th>期待回収率</th></tr></thead>
      <tbody>${formRows}</tbody>
    </table></div>
    <p class="panel-note">オッズの「推」は単勝オッズから推定した値で、発売中の実際のオッズとは異なります。複勝は JRA のオッズ（下限〜上限）が取れているときは下限で計算しています。</p>
  </section>`;
}

export function renderRaceMain(pred, rec, ctx) {
  const race = pred.race;
  const result = race.result?.length ? renderResultPanel(pred, rec, ctx) : '';
  return `${renderHead(race, ctx)}<div id="slot-summary">${renderSummary(pred, rec, ctx.state.preset)}</div>${renderAnalysisPanel(pred, rec, ctx)}${result}<div class="card-wrap" id="slot-card">${renderCardTable(pred, ctx)}</div>`;
}

/** レース分析：結論（買う・見送りとその理由）、有力馬の比較、AI と人気のずれ、このコースの過去の傾向 */
export function renderAnalysisPanel(pred, rec, ctx) {
  const race = pred.race;
  const a = raceAnalysis(pred, rec, { jockeys: race.jockeys && Object.keys(race.jockeys).length ? race.jockeys : REAL_STATS.jockeyRates });
  const v = a.verdict;
  const oddsKnown = !pred.noOdds;
  const horse = (r) => `${entryBadge(r.entry, 'sm')} <span class="ra-name">${esc(r.entry.name)}</span>`;
  const ticketLine = (t, dropped = false) =>
    `<li${dropped ? ' class="muted"' : ''}>${esc(BET_LABEL[t.type])} <b class="num">${esc(ticketLabel(t))}</b> 当たる確率 <span class="num">${pct(t.pHit ?? t.p, 0)}</span>・オッズ <span class="num">${odds(t.odds)}</span>・期待値 <span class="num">${t.ev.toFixed(2)}</span>${!dropped && t.stake ? `・<span class="num">${yen(t.stake)}</span>` : ''}</li>`;
  const verdictHtml = `<div class="ra-verdict ra-${v.kind}">
      <span class="ra-badge">${esc(v.title)}</span>
      <p>${esc(v.text)}</p>
      ${v.tickets?.length ? `<ul class="ra-tickets">${v.tickets.map((t) => ticketLine(t)).join('')}</ul>` : ''}
      ${v.dropped?.length ? `<ul class="ra-tickets">${v.dropped.slice(0, 3).map((t) => ticketLine(t, true)).join('')}</ul>` : ''}
    </div>`;
  const topRows = a.top
    .map(
      (h) => `<tr>
        <td class="c-mark">${h.row.mark ? `<span class="mark ${markClass(h.row.mark)}">${esc(h.row.mark)}</span>` : ''}</td>
        <td><span class="ra-horse">${horse(h.row)}</span></td>
        <td class="num">${pct(h.row.pWin)}</td>
        <td class="num">${pct(h.row.pTop3)}</td>
        <td class="num">${oddsKnown ? `${pct(h.row.marketProb)}<small>${h.row.entry.popularity ? `・${h.row.entry.popularity}人気` : ''}</small>` : '—'}</td>
        <td>${h.value ? `<span class="ra-value v-${h.value.key}">${esc(h.value.label)}</span>` : '—'}</td>
        <td class="ra-note">${h.comment.pros[0] ? `<span class="tx-good">＋${esc(h.comment.pros[0])}</span>` : ''}${h.comment.cons[0] ? ` <span class="tx-bad">－${esc(h.comment.cons[0])}</span>` : ''}</td>
      </tr>`,
    )
    .join('');
  const gapHtml = !oddsKnown
    ? '<p class="muted">単勝オッズが出たら、AI とオッズの見立てのずれを表示します。</p>'
    : a.overlays.length || a.underlays.length
    ? `${a.overlays.length ? `<p class="ra-sub">AI の評価がオッズより高い（妙味）</p><ul>${a.overlays.map((o) => `<li>${horse(o.row)} AI ${pct(o.row.pWin, 0)} 対 オッズ ${pct(o.row.marketProb, 0)}${o.reason ? `：${esc(o.reason)}` : ''}</li>`).join('')}</ul>` : ''}
       ${a.underlays.length ? `<p class="ra-sub">人気ほど AI は評価していない（人気先行）</p><ul>${a.underlays.map((o) => `<li>${horse(o.row)} AI ${pct(o.row.pWin, 0)} 対 オッズ ${pct(o.row.marketProb, 0)}${o.reason ? `：${esc(o.reason)}` : ''}</li>`).join('')}</ul>` : ''}`
    : '<p class="muted">AI とオッズの見立てに大きなずれはありません（オッズどおりの評価）。</p>';
  const c = a.course;
  const STY = ['逃げ', '先行', '差し', '追込'];
  const courseHtml = c
    ? `<p class="ra-sub">${esc(pred.race.course)} ${esc(pred.race.surface === '芝' ? '芝' : pred.race.surface === 'ダ' ? 'ダート' : pred.race.surface)}${esc(pred.race.distance)}m・過去 ${c.n.toLocaleString('ja-JP')}レース</p>
       <dl class="ra-dl">
         <div><dt>1番人気</dt><dd>勝率 <b class="num">${pct(c.favWin, 0)}</b>・複勝率 <b class="num">${pct(c.favTop3, 0)}</b></dd></div>
         <div><dt>人気3頭以外の勝ち</dt><dd class="num">${pct(c.upset, 0)}</dd></div>
         <div><dt>単勝の配当</dt><dd>平均 <span class="num">${yen(c.avgWinPay)}</span>${c.medWinPay ? `・中央値 <span class="num">${yen(c.medWinPay)}</span>` : ''}</dd></div>
         ${c.inner ? `<div><dt>内枠（1〜4枠）</dt><dd>勝ちの <span class="num">${pct(c.inner.win, 0)}</span>（出走の ${pct(c.inner.runners, 0)}）${c.innerEdge > 0.05 ? '：内枠が有利' : c.innerEdge < -0.05 ? '：外枠が有利' : '：大きな差なし'}</dd></div>` : ''}
       </dl>
       ${
         c.style
           ? `<div class="ra-styles">${STY.map((s) => `<div class="ra-style${s === c.styleBest ? ' is-best' : ''}"><span>${s}</span><span class="ra-bar"><i style="width:${Math.min(100, c.style[s].win * 500).toFixed(0)}%"></i></span><span class="num">${pct(c.style[s].win, 0)}</span></div>`).join('')}</div>
              <p class="ra-foot">脚質ごとの勝率（勝ち ÷ 出走）。いちばん勝っているのは「${esc(c.styleBest)}」${c.fitting.length ? `：このレースでは ${c.fitting.slice(0, 4).map((n) => esc(n)).join('・')}` : '：このレースには見当たりません'}。</p>`
           : ''
       }
       <p class="ra-foot muted">学習期間（${esc(c.period)}）のレース結果から集計。</p>`
    : '<p class="muted">このコースは過去のレースが少ないため、傾向を出していません。</p>';
  const fieldHtml = STY.map((s) => `<span class="style-chip ${STYLE_CLASS[s]}">${s} ${a.field[s].length}</span>`).join('');
  return `<section class="panel race-analysis" aria-labelledby="h-analysis">
    <header class="panel-head"><h2 id="h-analysis">レース分析</h2><span class="panel-sub">結論・有力馬・AIと人気のずれ・コースの傾向</span></header>
    ${verdictHtml}
    ${a.outlook ? `<p class="ra-outlook">${esc(a.outlook)}</p>` : ''}
    <div class="table-scroll"><table class="ra-top">
      <thead><tr><th class="c-mark">印</th><th>馬</th><th title="AI の予想">勝率</th><th>複勝率</th><th title="単勝オッズから見た勝率">オッズの勝率</th><th>評価</th><th>ひとこと</th></tr></thead>
      <tbody>${topRows}</tbody>
    </table></div>
    <div class="ra-grid">
      <div class="ra-box"><h3>AI と人気のずれ</h3>${gapHtml}</div>
      <div class="ra-box"><h3>このコースの傾向</h3>${courseHtml}<p class="ra-foot">このレースの脚質：${fieldHtml}</p></div>
    </div>
  </section>`;
}

/** 障害レース：予想の対象外（出馬表と結果だけ表示） */
export function renderJumpRace(race, ctx) {
  const body = race.entries
    .map((e) => {
      const f = race.finishes?.[e.number];
      return `<tr class="${e.scratched ? 'is-scratched' : ''}">
        ${race.result?.length ? `<td class="c-fin num">${esc(typeof f === 'number' && f > 0 ? f : f || '—')}</td>` : ''}
        <td class="c-frame f${esc(e.frame)}"><span>${esc(e.frame)}</span></td>
        <td class="c-num"><span class="num-box">${esc(e.number)}</span></td>
        <td class="c-horse"><span class="h-name">${esc(e.name)}</span><span class="h-sub">${esc(`${e.sex || ''}${e.age ?? ''}`)}${e.weight ? ` · ${esc(e.weight)}kg` : ''}${e.jockey ? ` · ${esc(e.jockey)}` : ''}</span></td>
        <td class="c-odds num">${odds(e.odds)}<small>${e.popularity ? `${e.popularity}人気` : ''}</small></td>
      </tr>`;
    })
    .join('');
  return `${renderHead(race, ctx)}
    <div class="note-box"><p>障害レースは、平地とは能力の測り方が違うため予想の対象外です。出馬表${race.result?.length ? 'と結果' : ''}だけ表示しています。</p></div>
    <div class="table-scroll card-scroll"><table class="card jump-card">
      <thead><tr>${race.result?.length ? '<th class="c-fin">着</th>' : ''}<th class="c-frame">枠</th><th class="c-num">馬番</th><th class="c-horse">馬名</th><th class="c-odds">単勝</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

export function renderEmptyRace(ctx) {
  const { loadState, loadError } = ctx;
  if (loadState === 'loading') {
    return `<div class="empty-state"><h1>実データを読み込んでいます</h1><p>JRAの出馬表・オッズ・結果を読み込んでいます…</p></div>`;
  }
  if (loadState === 'none' || loadState === 'error') {
    return `<div class="empty-state">
      <h1>実データがありません</h1>
      <p>KEIB は架空のデータでは予想しません。JRAの実際の出馬表・オッズ・結果を読み込むと予想が表示されます。</p>
      ${loadError ? `<p class="muted">${esc(loadError)}</p>` : ''}
      <ul class="empty-steps">
        <li>自分のパソコンで <code>npm run server</code> を実行すると、JRAの出馬表・オッズ・結果を自動で取り込み、リアルタイムで予想します。</li>
        <li>手元の出馬表を使うときは、<button type="button" class="link-btn" data-tab="data">データ画面</button>で CSV か JSON を取り込んでください。</li>
      </ul>
    </div>`;
  }
  return `<div class="empty-state">
    <h1>レースがありません</h1>
    <p>左の一覧から開催日とレースを選んでください。</p>
  </div>`;
}

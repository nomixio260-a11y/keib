// 予想画面：レース見出し・出馬表・展開・買い目・重み付け

import { BET_LABEL, BET_TYPES, COURSES, GOINGS, gradeLabel } from '../engine/constants.js';
import { FACTORS, PRESETS } from '../engine/model.js';
import { BLEND_OPTIONS, STRATEGIES, ticketLabel, evaluateFormations } from '../engine/bets.js';
import { horseComment, paceComment } from '../engine/comments.js';
import { speedFigure } from '../engine/speed.js';
import { REAL_STATS } from '../engine/realStats.js';
import { formatDateJa, formatShortDate, formatTime } from '../engine/util.js';
import { contribBars, paceMap, positionStrip } from './charts.js';
import { esc, fixed, frameBadge, markClass, odds, pct, signed, STYLE_CLASS, surfaceName, yen } from './format.js';
import { gradeChip, statusBadge } from './timeline.js';
import { renderResultPanel } from './resultView.js';

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
      <span class="chip">${race.entries.filter((e) => !e.scratched).length}頭</span>
    </div>
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

export function renderSummary(pred, rec) {
  const h = pred.order[0];
  const e = h.entry;
  const c = pred.confidence;
  const pc = paceComment(pred);
  const dots = Array.from({ length: 5 }, (_, i) => `<span class="meter-dot${i < c.upset ? ' is-on' : ''}"></span>`).join('');
  const nige = pred.rows.filter((r) => r.style.style === '逃げ').length;
  const total = rec.tickets.reduce((a, t) => a + t.stake, 0);
  return `<div class="summary">
    <div class="tile tile-honmei">
      <div class="tile-label">本命</div>
      <div class="tile-main"><span class="mark mk-h big">◎</span>${frameBadge(e.frame, e.number)}<span class="tile-horse">${esc(e.name)}</span></div>
      <div class="tile-sub">勝率 <b class="num">${pct(h.pWin)}</b>・複勝率 <b class="num">${pct(h.pTop3)}</b>${h.odds ? `・単勝 <b class="num">${odds(h.odds)}</b>倍` : ''}</div>
    </div>
    <div class="tile tile-pace">
      <div class="tile-label">展開</div>
      <div class="tile-main"><span class="pace-badge pace-${pred.pace.label}">${pred.pace.label}</span><span class="tile-strong">${esc(pc.name)}</span></div>
      <div class="tile-sub">逃げ候補 ${nige}頭・直線${pred.straightBias > 0.4 ? '短め' : pred.straightBias < -0.4 ? '長め' : '標準'}</div>
    </div>
    <div class="tile tile-conf">
      <div class="tile-label">自信度・波乱度</div>
      <div class="tile-main"><span class="grade-big g-${c.grade}">${c.grade}</span><span class="meter" role="img" aria-label="波乱度 ${c.upset} / 5">${dots}</span></div>
      <div class="tile-sub">◎と○の勝率差 <b class="num">${((c.top - c.second) * 100).toFixed(1)}</b>pt</div>
    </div>
    <a class="tile tile-link tile-bets" href="#panel-bets" data-action="goto-bets">
      <div class="tile-label">AI推奨（${esc(STRATEGIES[rec.strategy].label)}）</div>
      ${
        rec.noOdds
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
  const jockeys = race.jockeys && Object.keys(race.jockeys).length ? race.jockeys : REAL_STATS.jockeyRates;
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
        <h4 class="d-h">評価の内訳 <small>AI指数への寄与</small></h4>
        ${contribBars(row, factors, maxAbs)}
      </div>
      <div class="d-block">
        <h4 class="d-h">着順の分布 <small>${pred.sim.sims.toLocaleString('ja-JP')}回のシミュレーション</small></h4>
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
        ${REAL_STATS.trainerRates?.[entry.trainer] ? `<div><dt>厩舎成績</dt><dd class="num">勝率 ${pct(REAL_STATS.trainerRates[entry.trainer].winRate)}・複勝率 ${pct(REAL_STATS.trainerRates[entry.trainer].top3Rate)}</dd></div>` : ''}
        <div><dt>馬体重</dt><dd class="num">${esc(bw)}</dd></div>
        <div><dt>騎手成績</dt><dd class="num">${j ? `勝率 ${pct(j.winRate)}・複勝率 ${pct(j.top3Rate)}${j.starts ? `（${j.starts}騎乗）` : ''}` : '—'}</dd></div>
        ${row ? `<div><dt>AI指数</dt><dd class="num">${fixed(row.index)}（${row.rank}位）</dd></div><div><dt>脚質</dt><dd>${esc(row.style.style)}</dd></div><div><dt>スピード指数</dt><dd class="num">最高 ${row.stats.bestSi != null ? row.stats.bestSi.toFixed(0) : '—'}・前走 ${row.stats.lastSi != null ? row.stats.lastSi.toFixed(0) : '—'}</dd></div>` : ''}
      </dl>
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
        <td class="c-frame f${esc(e.frame)}"><span>${esc(e.frame)}</span></td>
        <td class="c-num"><span class="num-box">${esc(e.number)}</span></td>
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
        ${sortBtn('number', '馬番')}${sortBtn('ai', 'AI評価')}${hasResult ? sortBtn('finish', '着順') : ''}
      </div>
      <p class="card-hint">${pred.noOdds ? '単勝オッズの発表前です。人気・期待値はオッズが出てから表示します。' : '行を押すと馬柱・評価の内訳・オッズ修正が開きます'}</p>
    </div>
    <div class="table-scroll card-scroll"><table class="card${hasResult ? ' has-fin' : ''}">
    <thead><tr>
      ${hasResult ? '<th class="c-fin" title="確定着順">着</th>' : ''}<th class="c-mark" title="印">印</th><th class="c-frame" title="枠番">枠</th><th class="c-num">馬番</th><th class="c-horse">馬名</th><th class="c-style">脚質</th>
      <th class="c-index" title="レース内の偏差値（平均50）">AI指数</th><th class="c-win">勝率</th><th class="c-top3">複勝率</th><th class="c-odds">単勝</th><th class="c-ev" title="勝率 × 単勝オッズ。1.0を超えると理論上プラス">期待値</th><th class="c-toggle"><span class="sr-only">詳細</span></th>
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

export function renderBetsPanel(pred, rec, ctx) {
  const { state } = ctx;
  const budgets = [1000, 3000, 5000, 10000];
  const strategies = Object.entries(STRATEGIES)
    .map(([k, s]) => `<button type="button" class="seg-btn${state.strategy === k ? ' is-on' : ''}" data-strategy="${k}" aria-pressed="${state.strategy === k}">${esc(s.label)}</button>`)
    .join('');
  const types = BET_TYPES.map(
    (t) =>
      `<label class="toggle-chip"><input type="checkbox" data-bettype="${t}" ${state.betTypes.includes(t) ? 'checked' : ''}><span>${esc(BET_LABEL[t])}</span></label>`,
  ).join('');
  const total = rec.tickets.reduce((a, t) => a + t.stake, 0);
  const body = rec.noOdds
    ? '<tr><td colspan="6" class="muted bt-empty">単勝オッズの発表前です。オッズが出ると、期待値から買い目を選びます（土曜のレースは金曜、日曜のレースは土曜に前日発売が始まります）。</td></tr>'
    : rec.tickets.length
    ? rec.tickets
        .map(
          (t) => `<tr>
          <td>${esc(BET_LABEL[t.type])}</td>
          <td class="num bt-combo">${esc(ticketLabel(t))}</td>
          <td class="num">${pct(t.pEv ?? t.p)}</td>
          <td class="num">${odds(t.odds)}${t.estimated ? '<small title="単勝オッズからの推定">推</small>' : ''}</td>
          <td class="num ${evClass(t.ev)}">${t.ev.toFixed(2)}</td>
          <td class="num">${t.stake.toLocaleString('ja-JP')}</td>
        </tr>`,
        )
        .join('')
    : `<tr><td colspan="6" class="muted bt-empty">期待値の条件（${STRATEGIES[rec.strategy].minEv.toFixed(2)}以上）を満たす買い目がありません。このレースは見送りか、戦略や券種を変えてみてください。</td></tr>`;
  const forms = evaluateFormations(pred, state.blend);
  const formRows = forms
    .map(
      (f) => `<tr><td>${esc(f.label)}</td><td class="num">${f.points}</td><td class="num">${pct(f.hitRate)}</td><td class="num ${f.roi >= 1 ? 'ev-ok' : 'ev-lo'}">${pct(f.roi, 0)}</td></tr>`,
    )
    .join('');
  return `<section class="panel" id="panel-bets" aria-labelledby="h-bets">
    <header class="panel-head"><h2 id="h-bets">買い目</h2><span class="panel-sub">期待値（確率×推定オッズ）で選定</span></header>
    <div class="field-row">
      <label class="field" for="budget">予算（円）</label>
      <input id="budget" type="number" inputmode="numeric" min="100" step="100" value="${esc(state.budget)}" data-budget-input>
      <div class="quick">${budgets.map((b) => `<button type="button" class="mini-btn${state.budget === b ? ' is-on' : ''}" data-budget="${b}">${b.toLocaleString('ja-JP')}</button>`).join('')}</div>
    </div>
    <div class="seg strat-seg" role="group" aria-label="買い方">${strategies}</div>
    <p class="panel-note">${esc(STRATEGIES[state.strategy].desc)}</p>
    <div class="chips-row" role="group" aria-label="券種">${types}</div>
    <div class="field-row">
      <label class="field" for="blend">期待値にオッズを混ぜる</label>
      <select id="blend" data-blend>
        ${BLEND_OPTIONS.map((o) => `<option value="${o.value}" ${Number(state.blend) === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
    </div>
    <div class="table-scroll"><table class="bets">
      <thead><tr><th>券種</th><th>買い目</th><th>的中率</th><th>オッズ</th><th title="(1−混合率)×AIの確率＋混合率×オッズの確率 で計算">期待値</th><th>金額</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
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
    <p class="panel-note">オッズの「推」は単勝オッズから割引ハーヴィル式で推定した値です。発売中の実際のオッズとは異なります。</p>
  </section>`;
}

export function renderWeightsPanel(ctx) {
  const { state } = ctx;
  const presets = Object.entries(PRESETS)
    .map(([k, p]) => `<button type="button" class="seg-btn${state.preset === k ? ' is-on' : ''}" data-preset="${k}" aria-pressed="${state.preset === k}">${esc(p.label)}</button>`)
    .join('');
  const sliders = FACTORS.map(
    (f) => `<div class="slider">
      <label for="w-${f.key}"><span>${esc(f.label)}</span><output class="num" id="wo-${f.key}">${esc(state.weights[f.key])}</output></label>
      <input type="range" id="w-${f.key}" min="0" max="100" step="1" value="${esc(state.weights[f.key])}" data-weight="${f.key}" aria-describedby="wd-${f.key}">
      <p class="slider-desc" id="wd-${f.key}">${esc(f.desc)}</p>
    </div>`,
  ).join('');
  return `<section class="panel" id="panel-weights" aria-labelledby="h-weights">
    <header class="panel-head"><h2 id="h-weights">予想の重み付け</h2><span class="pill" id="custom-pill" ${state.preset === 'custom' ? '' : 'hidden'}>カスタム</span></header>
    <div class="seg preset-seg" role="group" aria-label="プリセット">${presets}</div>
    ${PRESETS[state.preset]?.desc ? `<p class="panel-note preset-desc">${esc(PRESETS[state.preset].desc)}</p>` : ''}
    <div class="sliders">${sliders}</div>
    <div class="slider">
      <label for="noise"><span>荒れ度</span><output class="num" id="noise-out">${Number(state.noise).toFixed(1)}</output></label>
      <input type="range" id="noise" min="0.6" max="1.6" step="0.1" value="${esc(state.noise)}" data-noise>
      <p class="slider-desc">小さいほど能力どおりの堅い決着、大きいほど波乱を多めに見込みます。</p>
    </div>
    <div class="field-row">
      <label class="field" for="sims">シミュレーション回数</label>
      <select id="sims" data-sims>
        ${[5000, 20000, 50000].map((n) => `<option value="${n}" ${state.sims === n ? 'selected' : ''}>${n.toLocaleString('ja-JP')}回</option>`).join('')}
      </select>
    </div>
    <div class="panel-actions"><button type="button" class="ghost-btn" data-action="reset-weights">既定に戻す</button></div>
  </section>`;
}

export function renderRaceMain(pred, rec, ctx) {
  const race = pred.race;
  const result = race.result?.length ? renderResultPanel(pred, rec, ctx) : '';
  return `${renderHead(race, ctx)}<div id="slot-summary">${renderSummary(pred, rec)}</div>${result}<div class="card-wrap" id="slot-card">${renderCardTable(pred, ctx)}</div>`;
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

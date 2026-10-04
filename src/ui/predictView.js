// 予想画面：レース見出し・出馬表・展開・買い目・重み付け

import { BET_LABEL, BET_TYPES, COURSES, GOINGS, gradeLabel } from '../engine/constants.js';
import { FACTORS, PRESETS } from '../engine/model.js';
import { BLEND_OPTIONS, KEEP_OPTIONS, STRATEGIES, ESTIMATED_TYPES, BET_TEMP, ticketLabel, evaluateFormations } from '../engine/bets.js';
import { horseComment, paceComment } from '../engine/comments.js';
import { speedFigure } from '../engine/speed.js';
import { REAL_STATS } from '../engine/realStats.js';
import { REAL_BACKTEST } from '../data/realBacktest.js';
import { volatilityFactors } from '../engine/volatility.js';
import { VOLATILITY_MODEL } from '../engine/volatilityModel.js';
import { formatDateJa, formatShortDate, formatTime } from '../engine/util.js';
import { contribBars, paceMap, positionStrip } from './charts.js';
import { esc, fixed, frameBadge, entryBadge, markClass, odds, pct, signed, STYLE_CLASS, surfaceName, yen } from './format.js';
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
        ? `<p class="prov-note">特別登録の段階の<b>暫定の予想</b>です。枠順・騎手・単勝オッズは出馬表（土曜のレースは木曜、日曜・月曜のレースは金曜〜土曜）で決まり、出たら自動で予想を出し直します。いまの勝率は、登録馬の前4走・負担重量・厩舎などからオッズを使わずに計算した「AI単独」の予想です（騎手・枠順はまだ使っていません）。${
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
        ${REAL_STATS.trainerRates?.[entry.trainer] ? `<div><dt>厩舎成績</dt><dd class="num">勝率 ${pct(REAL_STATS.trainerRates[entry.trainer].winRate)}・複勝率 ${pct(REAL_STATS.trainerRates[entry.trainer].top3Rate)}</dd></div>` : ''}
        <div><dt>馬体重</dt><dd class="num">${esc(bw)}</dd></div>
        ${entry.placeMin > 1 ? `<div><dt>複勝オッズ</dt><dd class="num">${odds(entry.placeMin)}〜${odds(entry.placeMax)}</dd></div>` : ''}
        <div><dt>騎手成績</dt><dd class="num">${j ? `勝率 ${pct(j.winRate)}・複勝率 ${pct(j.top3Rate)}${j.starts ? `（${j.starts}騎乗）` : ''}` : '—'}</dd></div>
        ${row ? `<div><dt>AI指数</dt><dd class="num">${fixed(row.index)}（${row.aiRank}位・勝率は${row.rank}位）</dd></div><div><dt>脚質</dt><dd>${esc(row.style.style)}</dd></div><div><dt>スピード指数</dt><dd class="num">最高 ${row.stats.bestSi != null ? row.stats.bestSi.toFixed(0) : '—'}・前走 ${row.stats.lastSi != null ? row.stats.lastSi.toFixed(0) : '—'}</dd></div>` : ''}
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
      <p class="card-hint">${race.provisional ? '特別登録の馬（50音順）です。枠・馬番・騎手は出馬表で決まります。行を押すと前4走と評価の内訳が開きます。' : pred.noOdds ? `単勝オッズの発表前です。人気・期待値はオッズが出てから表示します。${pred.aiOnly ? 'いまの勝率はオッズを使わない「AI単独」の予想です（学習に使っていない期間で◎の勝率 29%。オッズが出ると機械学習の予想に切り替わります）。' : ''}` : '行を押すと馬柱・評価の内訳・オッズ修正が開きます'}</p>
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
  const body = rec.noOdds && pred.race.provisional
    ? '<tr><td colspan="6" class="muted bt-empty">特別登録の段階です。出馬表（枠順・騎手）と単勝オッズが出てから、期待値で買い目を選びます。</td></tr>'
    : rec.noOdds
    ? '<tr><td colspan="6" class="muted bt-empty">単勝オッズの発表前です。オッズが出ると、期待値から買い目を選びます（土曜のレースは金曜、日曜のレースは土曜に前日発売が始まります）。</td></tr>'
    : rec.tickets.length
    ? rec.tickets
        .map(
          (t) => `<tr>
          <td>${esc(BET_LABEL[t.type])}</td>
          <td class="num bt-combo">${esc(ticketLabel(t))}</td>
          <td class="num">${pct(t.pHit ?? t.pEv ?? t.p)}</td>
          <td class="num">${odds(t.odds)}${t.oddsMax ? `<small title="複勝オッズの範囲（下限で計算）">〜${odds(t.oddsMax)}</small>` : ''}${t.estimated ? '<small title="単勝オッズからの推定">推</small>' : t.type !== 'win' ? '<small class="tx-good" title="JRA の実際のオッズ">実</small>' : ''}</td>
          <td class="num ${evClass(t.ev)}">${t.ev.toFixed(2)}</td>
          <td class="num">${t.stake.toLocaleString('ja-JP')}</td>
        </tr>`,
        )
        .join('')
    : rec.skipped
    ? `<tr><td colspan="6" class="muted bt-empty">${esc(rec.skipReason || '自信度 S のレースだけ買う設定（控えめ）なので、このレースは見送りです。')}</td></tr>`
    : rec.dropped?.length
    ? `<tr><td colspan="6" class="muted bt-empty">期待値の条件を満たす買い目はありましたが、当たる確率が ${pct(rec.keepMinP, 0)} 以上のものがないので見送りです（下の「外した買い目」）。</td></tr>`
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
    <div class="field-row">
      <label class="field" for="budget">予算（円）</label>
      <input id="budget" type="number" inputmode="numeric" min="100" step="100" value="${esc(state.budget)}" data-budget-input>
      <div class="quick">${budgets.map((b) => `<button type="button" class="mini-btn${state.budget === b ? ' is-on' : ''}" data-budget="${b}">${b.toLocaleString('ja-JP')}</button>`).join('')}</div>
    </div>
    <div class="seg strat-seg" role="group" aria-label="買い方">${strategies}</div>
    <p class="panel-note">${esc(STRATEGIES[state.strategy].desc)}</p>
    ${rec.formLabel ? `<p class="panel-note bt-auto">このレース：荒れ度「${esc(pred.confidence?.volatility || '')}」→ <b>${esc(rec.formLabel)}</b></p>` : ''}
    <div class="chips-row" role="group" aria-label="券種">${types}</div>
    ${
      state.betTypes.some((t) => ESTIMATED_TYPES.includes(t))
        ? pred.race.exoticOdds
          ? '<p class="panel-note">馬連・ワイド・三連複は JRA の実際のオッズ（「実」）で計算しています。馬単・三連単は単勝オッズからの推定（「推」）です。</p>'
          : '<p class="panel-note bet-caution">馬連・ワイド・馬単・三連複・三連単のオッズは単勝オッズからの推定です（発走2時間前から馬連・ワイド・三連複は実際のオッズを取り込みます）。推定オッズを期待値で選ぶと、実際の払戻は見込みを大きく下回りました。参考程度にしてください。</p>'
        : ''
    }
    <div class="field-row">
      <label class="field" for="keep">当たる確率で絞る</label>
      <select id="keep" data-keep>
        ${KEEP_OPTIONS.map((o) => `<option value="${o.value}" ${String(state.keep ?? 'auto') === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
    </div>
    <div class="field-row">
      <label class="field" for="blend">期待値にオッズを混ぜる</label>
      <select id="blend" data-blend>
        ${BLEND_OPTIONS.map((o) => `<option value="${o.value}" ${String(state.blend) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
    </div>
    ${(() => {
      const flat = (STRATEGIES[state.strategy].betTemp ?? BET_TEMP) !== 1;
      const exotic = state.strategy === 'hit' && state.betTypes.some((t) => ['quinella', 'trio', 'trifecta', 'exacta', 'wide'].includes(t));
      const parts = [];
      if (flat) parts.push(`買い目は、勝率を少し平らにして（荒れ度の${BET_TEMP}倍）、オッズを混ぜない AI の確率で期待値 ${STRATEGIES[state.strategy].minEv.toFixed(1)} 以上のものだけを選びます。単勝/複勝の的中重視で、学習期間の分割外 約1.2万レース（186週）の回収率 94.6% → 107.5%（週平均 −2,115円 → +601円）、直近14週 99.3% → 129.2%（−256円 → +1,961円）。的中率・期待値の欄はこの値です。`);
      if (exotic) parts.push('<span class="bet-caution">的中重視に馬連・三連複・三連単を足すと、学習期間の約1.2万レースでは回収率が下がりました（単勝/複勝だけ 94.6% → 足すと 88.1%）。</span>');
      return parts.length ? `<p class="panel-note">${parts.join('<br>')}</p>` : '';
    })()}
    <div class="table-scroll"><table class="bets">
      <thead><tr><th>券種</th><th>買い目</th><th title="AI の予想（平らにしない元の確率）で当たる確率">的中率</th><th>オッズ</th><th title="少し平らにした AI の確率（とオッズの確率を混ぜた値）× オッズ">期待値</th><th>金額</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${
      rec.dropped?.length
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
  const ml = !!PRESETS[state.preset]?.ml;
  return `<section class="panel" id="panel-weights" aria-labelledby="h-weights">
    <header class="panel-head"><h2 id="h-weights">予想のモデル</h2><span class="pill" id="custom-pill" ${state.preset === 'custom' ? '' : 'hidden'}>カスタム</span></header>
    <div class="seg preset-seg" role="group" aria-label="プリセット">${presets}</div>
    ${PRESETS[state.preset]?.desc ? `<p class="panel-note preset-desc">${esc(PRESETS[state.preset].desc)}</p>` : ''}
    ${ml ? '' : `<div class="sliders">${sliders}</div>`}
    <div class="slider">
      <label for="noise"><span>荒れ度</span><output class="num" id="noise-out">${Number(state.noise).toFixed(1)}</output></label>
      <input type="range" id="noise" min="0.6" max="1.6" step="0.1" value="${esc(state.noise)}" data-noise>
      <p class="slider-desc">小さいほど能力どおりの堅い決着、大きいほど波乱を多めに見込みます。</p>
    </div>
    <div class="field-row">
      <label class="field" for="sims" title="勝率・複勝率・各買い目の確率は厳密に計算します。回数は着順の分布の表示と、買い目全体の統計（どれかが当たる確率など）にだけ影響します">シミュレーション回数 <small>（着順分布・買い目全体の統計用）</small></label>
      <select id="sims" data-sims>
        ${[20000, 50000, 100000].map((n) => `<option value="${n}" ${state.sims === n ? 'selected' : ''}>${n.toLocaleString('ja-JP')}回</option>`).join('')}
      </select>
    </div>
    <div class="panel-actions"><button type="button" class="ghost-btn" data-action="reset-weights">既定に戻す</button></div>
  </section>`;
}

export function renderRaceMain(pred, rec, ctx) {
  const race = pred.race;
  const result = race.result?.length ? renderResultPanel(pred, rec, ctx) : '';
  return `${renderHead(race, ctx)}<div id="slot-summary">${renderSummary(pred, rec, ctx.state.preset)}</div>${result}<div class="card-wrap" id="slot-card">${renderCardTable(pred, ctx)}</div>`;
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

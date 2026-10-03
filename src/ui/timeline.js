// レース一覧：開催日（過去・今日・これから）→ 競馬場 → レース。発走までの時間と、確定したレースの結果を並べる

import { raceStatus, STATUS_LABEL, untilText, startMs } from '../engine/raceTime.js';
import { esc, frameBadge, pct } from './format.js';
import { REAL_BACKTEST } from '../data/realBacktest.js';

const WD = ['日', '月', '火', '水', '木', '金', '土'];

/** '2026-10-04' → '10/4(日)' */
export function dayLabel(date) {
  const [y, m, d] = date.split('-').map(Number);
  const wd = WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}(${wd})`;
}

/** 開催日の区分 */
export function dayKind(date, today) {
  if (date < today) return 'past';
  if (date === today) return 'today';
  return 'future';
}

function tomorrowOf(today) {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

function kindText(date, today) {
  const k = dayKind(date, today);
  if (k === 'today') return '今日';
  if (k === 'past') return '結果';
  return date === tomorrowOf(today) ? '明日' : 'これから';
}

const GRADE_CLASS = { G1: 'gr-g1', G2: 'gr-g2', G3: 'gr-g3', L: 'gr-l', OP: 'gr-op' };

export function gradeChip(grade) {
  if (!GRADE_CLASS[grade]) return '';
  return `<span class="grade-chip ${GRADE_CLASS[grade]}">${esc(grade)}</span>`;
}

export function surfaceChip(race) {
  const cls = race.surface === '芝' ? 'is-turf' : race.surface === 'ダ' ? 'is-dirt' : 'is-jump';
  return `<span class="surf-chip ${cls}">${esc(race.surface)}${esc(race.distance)}</span>`;
}

/** 状態バッジ（確定・結果待ち・締切間近・発売中） */
export function statusBadge(race, now, { withTime = false } = {}) {
  const st = raceStatus(race, now);
  const label = STATUS_LABEL[st];
  let extra = '';
  if (withTime && (st === 'open' || st === 'closing')) {
    const t = startMs(race);
    if (t) extra = `<span class="sb-until">${esc(untilText(t - now))}</span>`;
  } else if (withTime && st === 'live') {
    const t = startMs(race);
    if (t) extra = `<span class="sb-until">発走から${Math.max(0, Math.floor((now - t) / 60000))}分・結果は数分後に反映</span>`;
  }
  return `<span class="status-badge sb-${st}">${esc(label)}${extra}</span>`;
}

/** ◎の着順の表示 */
function finishChip(fin) {
  if (fin == null) return '';
  if (typeof fin !== 'number' || fin <= 0) return `<span class="fin-chip is-out">${esc(fin || '—')}</span>`;
  return `<span class="fin-chip${fin === 1 ? ' is-win' : fin <= 3 ? ' is-top3' : ''}">${esc(fin)}着</span>`;
}

/** その日の◎の成績（実際の結果と払戻） */
export function dayScore(races, quickPicks) {
  const done = races.filter((r) => r.result?.length && quickPicks.has(r.id) && !quickPicks.get(r.id).jump);
  const s = { races: done.length, win: 0, top3: 0, winRet: 0, placeRet: 0, placeBets: 0 };
  for (const r of done) {
    const p = quickPicks.get(r.id);
    const fin = r.finishes?.[p.number];
    if (fin === 1) s.win++;
    if (typeof fin === 'number' && fin >= 1 && fin <= 3) s.top3++;
    s.winRet += r.payouts?.win?.[String(p.number)] ?? 0;
    if (r.payouts?.place && Object.keys(r.payouts.place).length) {
      s.placeBets++;
      s.placeRet += r.payouts.place[String(p.number)] ?? 0;
    }
  }
  return s;
}

function renderDayScore(races, quickPicks) {
  const withResult = races.filter((r) => r.result?.length && !r.jump);
  if (!withResult.length) return '';
  const s = dayScore(races, quickPicks);
  if (!s.races) return '<div class="day-score is-wait">◎の成績を計算中…</div>';
  return `<div class="day-score" aria-label="この日の◎の成績">
    <div class="ds-title">この日の◎ <small>${s.races}レース・実際の払戻</small></div>
    <dl class="ds-grid">
      <div><dt>1着</dt><dd class="num">${s.win}<small>/${s.races}</small></dd></div>
      <div><dt>3着内</dt><dd class="num">${s.top3}<small>/${s.races}</small></dd></div>
      <div><dt>単勝回収</dt><dd class="num ${s.winRet >= s.races * 100 ? 'tx-good' : ''}">${pct(s.winRet / (s.races * 100), 0)}</dd></div>
      <div><dt>複勝回収</dt><dd class="num ${s.placeRet >= s.placeBets * 100 ? 'tx-good' : ''}">${s.placeBets ? pct(s.placeRet / (s.placeBets * 100), 0) : '—'}</dd></div>
    </dl>
  </div>`;
}

function raceItem(r, ctx) {
  const { state, quickPicks, now } = ctx;
  const pick = quickPicks.get(r.id);
  const on = r.id === state.raceId;
  const st = raceStatus(r, now);
  const t = startMs(r);
  let pickHtml;
  if (r.jump) pickHtml = '<span class="ri-wait">障害（予想対象外）</span>';
  else if (pick && !pick.jump) {
    const fin = r.result?.length ? r.finishes?.[pick.number] : null;
    pickHtml = `<span class="mark mk-h">◎</span>${frameBadge(pick.frame, pick.number, 'sm')}<span class="ri-horse">${esc(pick.name)}</span>${finishChip(fin)}`;
  } else pickHtml = '<span class="ri-wait">計算中…</span>';
  const timeText = st === 'open' || st === 'closing' ? (t && t - now < 3 * 3600 * 1000 ? untilText(t - now) : '') : '';
  return `<li><button type="button" class="race-item${on ? ' is-on' : ''} is-${st}" data-race="${esc(r.id)}" aria-current="${on ? 'true' : 'false'}">
    <span class="ri-no">${esc(r.raceNo)}<small>R</small></span>
    <span class="ri-body">
      <span class="ri-top"><span class="ri-name">${esc(r.name)}</span>${gradeChip(r.grade)}</span>
      <span class="ri-meta">${r.startTime ? `<span class="num">${esc(r.startTime)}</span>` : ''}${surfaceChip(r)}<span>${r.entries.filter((e) => !e.scratched).length}頭</span>${st === 'closing' || st === 'live' ? statusBadge(r, now) : timeText ? `<span class="ri-until">${esc(timeText)}</span>` : ''}</span>
      <span class="ri-pick">${pickHtml}</span>
    </span>
    <span class="ri-side">${pick && !pick.jump ? `<span class="ri-grade g-${esc(pick.grade)}" title="自信度">${esc(pick.grade)}</span>` : ''}</span>
  </button></li>`;
}

export function renderRail(ctx) {
  const { state, days, today, racesOf, venuesOf, imported, quickPicks } = ctx;
  const chips = days
    .map((d) => {
      const on = d.date === state.day;
      const kind = dayKind(d.date, today);
      return `<button type="button" class="day-chip is-${kind}${on ? ' is-on' : ''}" data-day="${esc(d.date)}" aria-pressed="${on}">
        <span class="dc-date">${esc(dayLabel(d.date))}</span><span class="dc-kind">${esc(kindText(d.date, today))}</span>
      </button>`;
    })
    .join('');
  const importChip = imported.length
    ? `<button type="button" class="day-chip is-import${state.day === 'import' ? ' is-on' : ''}" data-day="import" aria-pressed="${state.day === 'import'}"><span class="dc-date">取り込み</span><span class="dc-kind">${imported.length}R</span></button>`
    : '';
  const venues = venuesOf(state.day);
  const venueBtns =
    venues.length > 1
      ? `<div class="seg venue-seg" role="group" aria-label="競馬場">${venues
          .map((v) => `<button type="button" class="seg-btn${v === state.venue ? ' is-on' : ''}" data-venue="${esc(v)}" aria-pressed="${v === state.venue}">${esc(v)}</button>`)
          .join('')}</div>`
      : '';
  const races = racesOf(state.day, state.venue);
  const items = races.length
    ? races.map((r) => raceItem(r, ctx)).join('')
    : `<li class="rail-empty">${state.day === 'import' ? '取り込んだレースはありません。' : 'この日のレースはありません。'}</li>`;
  const allDay = racesOf(state.day, null);
  // 予想の実績（学習に使っていない期間の検証結果）
  const vb = REAL_BACKTEST?.presets?.[state.preset] || REAL_BACKTEST?.presets?.balance;
  const record = vb
    ? `<button type="button" class="track-record" data-tab="backtest" title="検証の詳しい結果を見る">
        <span class="tr-title">予想の実績 <small>学習に使っていない${esc(REAL_BACKTEST.races.toLocaleString('ja-JP'))}レース</small></span>
        <span class="tr-body">◎の勝率 <b class="num">${pct(vb.ai.winRate)}</b>・複勝率 <b class="num">${pct(vb.ai.top3Rate)}</b><small>（1番人気 ${pct(vb.fav.winRate)}・${pct(vb.fav.top3Rate)}）</small></span>
        ${
          vb.byGrade
            ? `<span class="tr-grades">${['S', 'A', 'B', 'C']
                .filter((g) => vb.byGrade[g]?.n >= 20)
                .map((g) => `<span class="tr-grade"><span class="ri-grade g-${g}">${g}</span><span class="num">${pct(vb.byGrade[g].winRate, 0)}</span></span>`)
                .join('')}<small>自信度ごとの◎の勝率</small></span>`
            : ''
        }
      </button>`
    : '';
  const sheetBtn =
    state.day !== 'import' && races.length
      ? `<button type="button" class="sheet-btn${ctx.view === 'sheet' ? ' is-on' : ''}" data-action="show-sheet" aria-pressed="${ctx.view === 'sheet'}"><span class="sheet-btn-main">この日の買い目表</span><small>全レースの印・買い目・結果を1枚で</small></button>`
      : '';
  return `${ctx.railStatus ? `<p class="rail-status">${ctx.railStatus}</p>` : ''}<div class="day-strip" role="group" aria-label="開催日">${chips}${importChip}</div>${sheetBtn}${record}
    ${venueBtns}
    ${state.day !== 'import' ? renderDayScore(allDay, quickPicks) : ''}
    <ol class="race-list">${items}</ol>`;
}

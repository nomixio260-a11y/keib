// レース一覧：開催日（過去・今日・これから）→ 競馬場 → レース。発走までの時間と、確定したレースの結果を並べる

import { raceStatus, STATUS_LABEL, untilText, startMs } from '../engine/raceTime.js';
import { esc, frameBadge, entryBadge, pct } from './format.js';
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

/** 荒れ度のチップ（堅い／荒れ だけ表示。普通は出さない） */
export function volChip(vol, size = '') {
  if (vol === '堅い') return `<span class="ri-vol v-solid${size}" title="荒れ度：堅い（人気3頭以外が勝つ確率が低い）">堅</span>`;
  if (vol === '荒れ') return `<span class="ri-vol v-wild${size}" title="荒れ度：荒れ（人気3頭以外が勝つ確率が高い）">荒</span>`;
  return '';
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

/** AI推奨（今の買い方）を実際の払戻で精算した合計。quickPicks の settle を足す */
export function profitOf(races, quickPicks) {
  const s = { races: 0, bets: 0, stake: 0, pay: 0, hitRaces: 0, pending: 0 };
  for (const r of races) {
    if (!r.result?.length || r.jump) continue;
    const p = quickPicks.get(r.id);
    if (!p) {
      s.pending++;
      continue;
    }
    if (p.jump || !p.settle) continue;
    s.races++;
    if (p.settle.stake > 0) {
      s.bets++;
      s.stake += p.settle.stake;
      s.pay += p.settle.pay;
      if (p.settle.hits) s.hitRaces++;
    }
  }
  return s;
}

const signedYen = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('ja-JP')}円`;

function renderProfit(races, ctx) {
  const { quickPicks, days, state, strategyLabel } = ctx;
  const d = profitOf(races, quickPicks);
  const allRaces = days.flatMap((x) => x.races);
  const p = profitOf(allRaces, quickPicks);
  const doneDays = days.filter((x) => x.races.some((r) => r.result?.length && !r.jump)).length;
  const head = `<div class="ds-title">AI推奨どおりに買った場合 <small>${esc(strategyLabel)}・1R ${Number(state.budget).toLocaleString('ja-JP')}円</small></div>`;
  const dayHtml = d.races
    ? `<dl class="ds-grid ds-grid-3">
      <div><dt>投資</dt><dd class="num">${d.stake.toLocaleString('ja-JP')}<small>円</small></dd></div>
      <div><dt>払戻</dt><dd class="num">${Math.round(d.pay).toLocaleString('ja-JP')}<small>円</small></dd></div>
      <div><dt>収支</dt><dd class="num ${d.pay - d.stake >= 0 ? 'tx-good' : 'tx-bad'}">${signedYen(d.pay - d.stake)}</dd></div>
    </dl><p class="ds-note">この日 ${d.races}R（買い ${d.bets}R・的中 ${d.hitRaces}R）${d.pending ? `・計算中 ${d.pending}R` : ''}</p>`
    : '<p class="ds-note">計算中…</p>';
  const periodHtml =
    doneDays > 1 && p.races
      ? `<div class="ds-period"><span>表示中の ${doneDays}日の合計</span><b class="num ${p.pay - p.stake >= 0 ? 'tx-good' : 'tx-bad'}">${signedYen(p.pay - p.stake)}</b><small>投資 ${p.stake.toLocaleString('ja-JP')}円・払戻 ${Math.round(p.pay).toLocaleString('ja-JP')}円・回収率 ${p.stake ? pct(p.pay / p.stake, 1) : '—'}・${p.races}R${p.pending ? `（計算中 ${p.pending}R）` : ''}</small></div>`
      : '';
  return `<div class="ds-profit">${head}${dayHtml}${periodHtml}</div>`;
}

function renderDayScore(races, ctx) {
  const { quickPicks } = ctx;
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
    ${renderProfit(races, ctx)}
  </div>`;
}

/** 過去の開催日（アーカイブ）を選ぶ */
function renderArchivePicker(ctx) {
  const { archive, days, state } = ctx;
  if (!archive?.index?.length) return '';
  const loaded = new Set(days.map((d) => d.date));
  const byMonth = new Map();
  for (const d of archive.index) {
    const m = d.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(d);
  }
  const opts = [...byMonth]
    .map(
      ([m, ds]) =>
        `<optgroup label="${Number(m.slice(0, 4))}年${Number(m.slice(5, 7))}月">${ds
          .map((d) => `<option value="${esc(d.date)}"${d.date === state.day ? ' selected' : ''}>${esc(dayLabel(d.date))} ${esc((d.venues || []).join('・'))} ${d.races}R${loaded.has(d.date) ? ' ✓' : ''}</option>`)
          .join('')}</optgroup>`,
    )
    .join('');
  const notLoaded = archive.index.filter((d) => !loaded.has(d.date)).length;
  const oldest = archive.index[archive.index.length - 1]?.date;
  return `<div class="archive-pick">
    <label><span>過去の開催日</span><select data-archive aria-label="過去の開催日を選ぶ"><option value="">${archive.index.length}日から選ぶ</option>${opts}</select></label>
    ${notLoaded ? `<button type="button" class="link-btn" data-action="load-all-archive"${archive.allLoading ? ' disabled' : ''}>${archive.allLoading ? '読み込み中…' : `全${archive.index.length}日の収支を計算`}</button>` : ''}
    ${archive.loading ? `<small>${esc(dayLabel(archive.loading))} を読み込み中…</small>` : ''}${archive.error ? `<small class="tx-bad">${esc(archive.error)}</small>` : ''}
    <small class="muted">${oldest ? `${esc(dayLabel(oldest))}以降。` : ''}過去の日の予想は、いまのモデルで計算し直したものです（学習に使っていない期間）。</small>
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
    pickHtml = `<span class="mark mk-h">◎</span>${pick.prov ? entryBadge({ provisionalNumber: true }, 'sm') : frameBadge(pick.frame, pick.number, 'sm')}<span class="ri-horse">${esc(pick.name)}</span>${finishChip(fin)}`;
  } else pickHtml = '<span class="ri-wait">計算中…</span>';
  const timeText = st === 'open' || st === 'closing' ? (t && t - now < 3 * 3600 * 1000 ? untilText(t - now) : '') : '';
  return `<li><button type="button" class="race-item${on ? ' is-on' : ''} is-${st}" data-race="${esc(r.id)}" aria-current="${on ? 'true' : 'false'}">
    <span class="ri-no">${esc(r.raceNo)}<small>R</small></span>
    <span class="ri-body">
      <span class="ri-top"><span class="ri-name">${esc(r.name)}</span>${gradeChip(r.grade)}</span>
      <span class="ri-meta">${r.startTime ? `<span class="num">${esc(r.startTime)}</span>` : ''}${surfaceChip(r)}<span>${r.provisional ? `登録${r.entries.length}頭` : `${r.entries.filter((e) => !e.scratched).length}頭`}</span>${st === 'closing' || st === 'live' || st === 'registration' ? statusBadge(r, now) : timeText ? `<span class="ri-until">${esc(timeText)}</span>` : ''}</span>
      <span class="ri-pick">${pickHtml}</span>
    </span>
    <span class="ri-side">${pick && !pick.jump ? `<span class="ri-grade g-${esc(pick.grade)}" title="自信度${esc(pick.grade)}${pick.conf != null ? `（◎が勝つ確率 ${Math.round(pick.conf * 100)}%）` : ''}">${esc(pick.grade)}</span>${volChip(pick.vol)}` : ''}</span>
  </button></li>`;
}

export function renderRail(ctx) {
  const { state, days, today, racesOf, venuesOf, imported, quickPicks } = ctx;
  const chips = days
    .map((d) => {
      const on = d.date === state.day;
      const kind = dayKind(d.date, today);
      // 特別登録の暫定のレースだけの日（出馬表の前）
      const dayRaces = racesOf(d.date, null);
      const prov = dayRaces.length > 0 && dayRaces.every((r) => r.provisional);
      return `<button type="button" class="day-chip is-${kind}${prov ? ' is-prov' : ''}${on ? ' is-on' : ''}" data-day="${esc(d.date)}" aria-pressed="${on}" ${prov ? 'title="特別登録の段階の暫定の予想（特別レースのみ）。出馬表は木〜金曜"' : ''}>
        <span class="dc-date">${esc(dayLabel(d.date))}</span><span class="dc-kind">${esc(prov ? `${kindText(d.date, today)}・登録` : kindText(d.date, today))}</span>
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
  return `${ctx.railStatus ? `<p class="rail-status">${ctx.railStatus}</p>` : ''}<div class="day-strip" role="group" aria-label="開催日">${chips}${importChip}</div>${renderArchivePicker(ctx)}${sheetBtn}${record}
    ${venueBtns}
    ${state.day !== 'import' ? renderDayScore(allDay, ctx) : ''}
    <ol class="race-list">${items}</ol>`;
}

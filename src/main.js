// KEIB 競馬予想 — アプリ本体（実データの読み込み・状態・画面切り替え・イベント）
//
// 予想に使うのは JRA の実際の出馬表・オッズ・結果だけ（data.json）。架空のデータは使わない。
// リアルタイム版（npm run server）では data.json が1分ごとに新しくなるので、画面も読み直す。

import { BET_TYPES, classLevel } from './engine/constants.js';
import { predictRace, DEFAULT_WEIGHTS, DEFAULT_NOISE, DEFAULT_PRESET, PRESETS, FACTORS, CALIBRATION_ID } from './engine/model.js';
import { recommendBets, ticketsToText, STRATEGIES, DEFAULT_BLEND, BLEND_OPTIONS, DEFAULT_STRATEGY, DEFAULT_TYPES } from './engine/bets.js';
import { runBacktest } from './engine/backtest.js';
import { buildImportedRace, parseRacesJSON, raceToJSON, CARD_HEADER, PAST_HEADER } from './engine/importer.js';
import { jstParts, raceStatus, startMs } from './engine/raceTime.js';
import {
  renderRaceMain,
  renderSummary,
  renderCardTable,
  renderPacePanel,
  renderBetsPanel,
  renderWeightsPanel,
  renderEmptyRace,
  renderJumpRace,
} from './ui/predictView.js';
import { renderRail, dayLabel, statusBadge } from './ui/timeline.js';
import { renderBacktest, currentBacktest } from './ui/backtestView.js';
import { renderData } from './ui/dataView.js';
import { renderLogic } from './ui/logicView.js';
import { bindLineChart } from './ui/charts.js';
import { installTooltips } from './ui/tooltip.js';
import { loadState as loadSaved, saveState } from './ui/store.js';
import { esc } from './ui/format.js';
import { REAL_BACKTEST } from './data/realBacktest.js';
import { REAL_STATS } from './engine/realStats.js';

const $ = (sel, root = document) => root.querySelector(sel);

/**
 * 中身を差し替える。フォーカス中の入力欄を消すと blur で change が発火し、
 * 差し替えの途中で再描画が入れ子になるので、先にフォーカスを外しておく。
 */
function setHTML(el, html) {
  if (!el) return;
  const active = document.activeElement;
  if (active && active !== document.body && el.contains(active)) active.blur();
  el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// 状態

const saved = loadSaved();
// 校正し直したら、保存してある重み付けは使わない（古い係数用の値なので）
const sameCal = saved.calId === CALIBRATION_ID;
const TABS = ['predict', 'backtest', 'data', 'logic'];
const DATA_URL = 'data.json';

const state = {
  tab: 'predict',
  day: typeof saved.day === 'string' ? saved.day : null,
  venue: typeof saved.venue === 'string' ? saved.venue : null,
  raceId: typeof saved.raceId === 'string' ? saved.raceId : null,
  weights: { ...DEFAULT_WEIGHTS, ...(sameCal ? saved.weights || {} : {}) },
  preset: sameCal && (PRESETS[saved.preset] || saved.preset === 'custom') ? saved.preset : DEFAULT_PRESET,
  noise: (sameCal && Number(saved.noise)) || DEFAULT_NOISE,
  sims: [5000, 20000, 50000].includes(saved.sims) ? saved.sims : 20000,
  budget: Number(saved.budget) >= 100 ? Number(saved.budget) : 3000,
  strategy: sameCal && STRATEGIES[saved.strategy] ? saved.strategy : DEFAULT_STRATEGY,
  betTypes: sameCal && Array.isArray(saved.betTypes) ? saved.betTypes.filter((t) => BET_TYPES.includes(t)) : [...DEFAULT_TYPES],
  sort: ['ai', 'finish'].includes(saved.sort) ? saved.sort : 'number',
  blend: BLEND_OPTIONS.some((o) => o.value === saved.blend) ? saved.blend : DEFAULT_BLEND,
  expanded: {},
  edits: saved.edits && typeof saved.edits === 'object' ? saved.edits : {},
};
if (!FACTORS.every((f) => Number.isFinite(Number(state.weights[f.key])))) state.weights = { ...DEFAULT_WEIGHTS };
let imported = Array.isArray(saved.imported) ? saved.imported.filter((r) => r && Array.isArray(r.entries)) : [];

// 実データ
const data = { bundle: null, loadState: 'loading', loadError: '', lastFetch: null, live: false, liveUrl: null };
let raceIndex = new Map();
// 利用者がレースを選ぶまでは「次に発走するレース」を自動で追いかける
let userPicked = false;
const preferredVenue = state.venue;

const bt = { source: REAL_BACKTEST ? 'saved' : 'recent', preset: 'balance', focus: 'ai', recent: { running: false, progress: 0, result: null } };
const dataView = {
  form: { date: jstParts().date, course: '東京', raceNo: 11, name: '', grade: '3勝', surface: '芝', distance: 1600, going: '良', card: '', past: '' },
  messages: null,
  json: '',
  jsonMessage: null,
};

let current = { pred: null, rec: null };

function persist() {
  const { day, venue, raceId, weights, preset, noise, sims, budget, strategy, betTypes, sort, blend, edits } = state;
  saveState({ calId: CALIBRATION_ID, day, venue, raceId, weights, preset, noise, sims, budget, strategy, betTypes, sort, blend, edits, imported });
}

const today = () => jstParts().date;
const days = () => data.bundle?.days || [];

function racesOf(day, venue) {
  if (day === 'import') return imported;
  const d = days().find((x) => x.date === day);
  if (!d) return [];
  return venue ? d.races.filter((r) => r.course === venue) : d.races;
}

function venuesOf(day) {
  if (day === 'import') return [];
  const d = days().find((x) => x.date === day);
  return d ? d.venues || [...new Set(d.races.map((r) => r.course))] : [];
}

const baseRace = (id) => raceIndex.get(id) || imported.find((r) => r.id === id) || null;
const dayOfRace = (race) => (race.imported ? 'import' : race.date);

/** 最初に開く開催日：今日 → 次の開催日 → 直近の開催日 */
function defaultDay() {
  const t = today();
  const list = days().map((d) => d.date);
  if (list.includes(t)) return t;
  return list.find((d) => d > t) || list[list.length - 1] || (imported.length ? 'import' : null);
}

/** その日のメインレース（格がいちばん上、同じなら11R寄り） */
function featuredRace(races) {
  const score = (r) => classLevel(r.grade) * 100 - Math.abs((r.raceNo || 0) - 11);
  return [...races].filter((r) => !r.jump).sort((a, b) => score(b) - score(a))[0] || races[0];
}

/** 最初に開くレース：今日なら次に発走するレース、ほかの日はメインレース */
function defaultRace(day, venue) {
  const races = racesOf(day, venue);
  if (!races.length) return null;
  if (day === today()) {
    const now = Date.now();
    const upcoming = races.filter((r) => !r.result?.length && startMs(r) && startMs(r) > now - 10 * 60 * 1000).sort((a, b) => startMs(a) - startMs(b));
    if (upcoming.length) return upcoming[0];
  }
  return day === 'import' ? races[races.length - 1] : featuredRace(races);
}

/** 開いている開催日・場・レースが無効なら直す */
function ensureSelection() {
  const valid = (d) => d === 'import' ? imported.length > 0 : days().some((x) => x.date === d);
  const cur = state.raceId ? baseRace(state.raceId) : null;
  if (cur && userPicked) {
    state.day = dayOfRace(cur);
    if (!cur.imported) state.venue = cur.course;
    return;
  }
  if (!userPicked || !state.day || !valid(state.day)) state.day = defaultDay();
  if (!state.day) return;
  const venues = venuesOf(state.day);
  if (!userPicked && venues.includes(preferredVenue)) state.venue = preferredVenue;
  if (!venues.includes(state.venue)) state.venue = venues[0] || null;
  if (!userPicked || !cur || dayOfRace(cur) !== state.day || (!cur.imported && cur.course !== state.venue)) {
    state.raceId = defaultRace(state.day, state.day === 'import' ? null : state.venue)?.id ?? null;
  }
}

/** ユーザーの変更（馬場・オッズ・取消）を反映したレース */
function effectiveRace(base) {
  const ed = state.edits[base.id];
  if (!ed) return base;
  const odds = ed.odds || {};
  const scr = ed.scratched || {};
  const entries = base.entries.map((e) => {
    const o = odds[e.number];
    const sc = scr[e.number];
    return o == null && sc == null ? e : { ...e, odds: o ?? e.odds, scratched: sc ?? e.scratched };
  });
  if (Object.keys(odds).length || Object.keys(scr).length) {
    const ranked = entries.filter((e) => !e.scratched && e.odds > 1).sort((a, b) => a.odds - b.odds);
    const pop = new Map(ranked.map((e, k) => [e.number, k + 1]));
    entries.forEach((e, i) => {
      if (pop.get(e.number) !== e.popularity) entries[i] = { ...e, popularity: pop.get(e.number) ?? null };
    });
  }
  return { ...base, going: ed.going || base.going, entries };
}

// ---------------------------------------------------------------------------
// 実データの読み込み（data.json）

function setBundle(bundle) {
  data.bundle = bundle;
  data.loadState = bundle.days?.length ? 'ok' : 'none';
  data.live = !!bundle.live;
  raceIndex = new Map();
  for (const d of bundle.days || []) for (const r of d.races) raceIndex.set(r.id, r);
}

/** HTML に埋め込まれた実データ（ビルドした時点のもの） */
function inlineBundle() {
  try {
    const json = JSON.parse(document.getElementById('keib-data')?.textContent || 'null');
    return json && Array.isArray(json.days) ? json : null;
  } catch {
    return null;
  }
}

/** リアルタイム版（GitHub Actions の Live ワークフロー）が公開中なら、その URL（live.json） */
async function fetchLiveInfo() {
  if (data.live) return;
  try {
    const res = await fetch('live.json', { cache: 'no-store' });
    if (!res.ok) throw new Error();
    const info = await res.json();
    data.liveUrl = info?.url && Date.parse(info.until) > Date.now() && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(info.url) ? info.url : null;
  } catch {
    data.liveUrl = null;
  }
}

/** data.json を読む。変わっていれば true。読めないときは埋め込みの実データを使う */
async function fetchBundle() {
  try {
    const res = await fetch(DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw Object.assign(new Error(`data.json を取得できません（HTTP ${res.status}）`), { missing: res.status === 404 });
    const json = await res.json();
    if (!json || !Array.isArray(json.days)) throw new Error('data.json の形式が違います');
    data.lastFetch = new Date().toISOString();
    if (data.bundle && json.generatedAt === data.bundle.generatedAt && !!json.live === data.live) {
      // 中身は同じ：確認した時刻だけ更新
      data.bundle.checkedAt = json.checkedAt;
      return false;
    }
    setBundle(json);
    data.loadError = '';
    return true;
  } catch (e) {
    if (!data.bundle) {
      const inline = inlineBundle();
      if (inline) {
        setBundle(inline);
        data.lastFetch = new Date().toISOString();
        return true;
      }
      data.loadState = e.missing || e instanceof TypeError ? 'none' : 'error';
      data.loadError = e instanceof TypeError ? '' : e.message;
    }
    return false;
  }
}

/** 予想に使う統計：実データの統計に、バンドルにある最近の開催日の馬場差を足したもの */
let statsCache = { bundle: null, stats: REAL_STATS };
function currentStats() {
  if (statsCache.bundle !== data.bundle) {
    const extra = data.bundle?.dayVariant;
    statsCache = { bundle: data.bundle, stats: extra && Object.keys(extra).length ? { ...REAL_STATS, dayVariant: { ...(REAL_STATS.dayVariant || {}), ...extra } } : REAL_STATS };
  }
  return statsCache.stats;
}

/** 予想のキャッシュに使う、レースの中身の目印 */
const raceSig = (race) => `${race.id}|${race.oddsAt || ''}|${race.status || ''}|${race.going || ''}|${race.result?.length || 0}`;

// ---------------------------------------------------------------------------
// 予想（キャッシュつき）

const predCache = new Map();
const settingsKey = () => JSON.stringify([state.preset, state.weights, state.noise, state.sims]);

function getPrediction(race) {
  const key = `${raceSig(race)}|${JSON.stringify(state.edits[race.id] || null)}|${settingsKey()}`;
  const hit = predCache.get(key);
  if (hit) return hit;
  const pred = predictRace(race, { weights: state.weights, noise: state.noise, sims: state.sims, stats: currentStats(), ml: !!PRESETS[state.preset]?.ml });
  predCache.set(key, pred);
  if (predCache.size > 60) predCache.delete(predCache.keys().next().value);
  return pred;
}

const quickPicks = new Map();
let quickKey = '';
let quickTimer = null;

function pickOf(pred, race) {
  if (pred.empty) return { jump: !!pred.jump, sig: raceSig(race) };
  const h = pred.order[0];
  return { number: h.entry.number, frame: h.entry.frame, name: h.entry.name, grade: pred.confidence.grade, sig: raceSig(race) };
}

/** 一覧の◎（とその日の成績）を裏で少しずつ計算 */
function scheduleQuickPicks() {
  const key = `${settingsKey()}|${JSON.stringify(state.edits)}`;
  if (key !== quickKey) {
    quickPicks.clear();
    quickKey = key;
  }
  clearTimeout(quickTimer);
  const venueFirst = (r) => (state.day === 'import' || r.course === state.venue ? 0 : 1);
  const queue = racesOf(state.day, null)
    .filter((r) => quickPicks.get(r.id)?.sig !== raceSig(r))
    .sort((a, b) => venueFirst(a) - venueFirst(b));
  const step = () => {
    const t0 = performance.now();
    while (queue.length && performance.now() - t0 < 24) {
      const race = effectiveRace(queue.shift());
      quickPicks.set(race.id, pickOf(getPrediction(race), race));
    }
    if (state.tab === 'predict') renderRailOnly();
    if (queue.length) quickTimer = setTimeout(step, 16);
  };
  if (queue.length) quickTimer = setTimeout(step, 30);
}

// ---------------------------------------------------------------------------
// 描画

const ctx = () => ({
  state,
  days: days(),
  today: today(),
  now: Date.now(),
  racesOf,
  venuesOf,
  quickPicks,
  imported,
  edits: state.edits[state.raceId],
  bt,
  dataView,
  strategyLabel: STRATEGIES[state.strategy].label,
  recentCount: recentRaces().length,
  railStatus: statusHtml(),
  stats: currentStats(),
  ...data,
});

/** データの更新状況（ヘッダーと、狭い画面ではレース一覧の上に出す） */
function statusHtml() {
  if (data.loadState !== 'ok') return data.loadState === 'loading' ? '読み込み中…' : '<span class="live-dot is-off" aria-hidden="true"></span>実データなし';
  const t = today();
  const upcoming = days().filter((d) => d.date >= t);
  const label = upcoming.length ? upcoming.map((d) => dayLabel(d.date)).join('・') : `${dayLabel(days()[days().length - 1].date)}まで`;
  const at = data.bundle.checkedAt || data.bundle.generatedAt;
  const gen = at ? new Date(Date.parse(at) + 9 * 3600 * 1000).toISOString() : '';
  const genText = gen ? `${Number(gen.slice(5, 7))}/${Number(gen.slice(8, 10))} ${gen.slice(11, 16)}` : '';
  const liveLink = data.liveUrl ? `<a class="live-link" href="${esc(data.liveUrl)}" target="_blank" rel="noopener">リアルタイム版（1分更新）を開く</a>` : '';
  return `<span class="live-dot${data.live ? ' is-live' : ''}" aria-hidden="true"></span>${esc(label)}<span class="meet-sub">JRA ${esc(genText)} 更新${data.live ? '・自動更新中' : ''}</span>${liveLink}`;
}

function renderTopStatus() {
  const el = $('#meet-date');
  if (el) el.innerHTML = statusHtml();
}

let railSel = null;
function renderRailOnly() {
  const rail = $('#race-rail');
  if (!rail) return;
  const list = rail.querySelector('.race-list');
  const strip = rail.querySelector('.day-strip');
  const scroll = list?.scrollLeft ?? 0;
  const stripScroll = strip?.scrollLeft ?? null;
  const scrollTop = rail.scrollTop;
  if (!days().length && !imported.length) {
    setHTML(rail, '');
    return;
  }
  // 一覧を作り直してもキーボードの位置を保つ
  const a = document.activeElement;
  const focusSel = a && rail.contains(a) ? ['race', 'day', 'venue'].map((k) => (a.dataset?.[k] ? `[data-${k}="${a.dataset[k]}"]` : '')).find(Boolean) : null;
  setHTML(rail, renderRail(ctx()));
  if (focusSel) rail.querySelector(focusSel)?.focus({ preventScroll: true });
  const nl = rail.querySelector('.race-list');
  if (nl) {
    // 狭い画面ではレース一覧が横に並ぶ。選んだレースが変わったら、そのレースが見える位置まで動かす
    const on = nl.querySelector('.race-item.is-on');
    if (railSel !== state.raceId && on && nl.scrollWidth > nl.clientWidth) {
      const li = on.parentElement;
      nl.scrollLeft = Math.max(0, li.offsetLeft - nl.offsetLeft - (nl.clientWidth - li.offsetWidth) / 2);
    } else nl.scrollLeft = scroll;
    railSel = state.raceId;
  }
  const ns = rail.querySelector('.day-strip');
  if (ns) {
    if (stripScroll != null) ns.scrollLeft = stripScroll;
    else ns.querySelector('.day-chip.is-on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  rail.scrollTop = scrollTop;
}

function computeCurrent() {
  ensureSelection();
  const base = state.raceId ? baseRace(state.raceId) : null;
  if (!base) return null;
  const race = effectiveRace(base);
  if (race.jump || race.surface === '障') return { pred: null, rec: null, jump: race };
  const pred = getPrediction(race);
  if (pred.empty) return { pred, rec: null };
  quickPicks.set(race.id, pickOf(pred, race));
  const rec = recommendBets(pred, { budget: state.budget, strategy: state.strategy, types: state.betTypes, blend: state.blend });
  return { pred, rec };
}

function renderPredict() {
  current = computeCurrent() || { pred: null, rec: null };
  renderTopStatus();
  renderRailOnly();
  const main = $('#race-main');
  if (current.jump) {
    setHTML(main, renderJumpRace(current.jump, ctx()));
    setHTML($('#slot-pace'), '');
    setHTML($('#slot-bets'), '');
    setHTML($('#slot-weights'), renderWeightsPanel(ctx()));
    scheduleQuickPicks();
    return;
  }
  if (!current.pred || current.pred.empty) {
    setHTML(main, renderEmptyRace(ctx()));
    setHTML($('#slot-pace'), '');
    setHTML($('#slot-bets'), '');
    setHTML($('#slot-weights'), data.loadState === 'ok' || imported.length ? renderWeightsPanel(ctx()) : '');
    scheduleQuickPicks();
    return;
  }
  setHTML(main, renderRaceMain(current.pred, current.rec, ctx()));
  setHTML($('#slot-pace'), renderPacePanel(current.pred));
  setHTML($('#slot-bets'), renderBetsPanel(current.pred, current.rec, ctx()));
  setHTML($('#slot-weights'), renderWeightsPanel(ctx()));
  scheduleQuickPicks();
}

/** 重みを動かしている最中・データ更新時：スライダーは作り直さずに、予想だけ更新 */
function refreshPrediction() {
  current = computeCurrent() || current;
  if (!current.pred || current.pred.empty || current.jump) return renderPredict();
  const main = $('#race-main');
  const scrollY = window.scrollY;
  setHTML(main, renderRaceMain(current.pred, current.rec, ctx()));
  setHTML($('#slot-pace'), renderPacePanel(current.pred));
  setHTML($('#slot-bets'), renderBetsPanel(current.pred, current.rec, ctx()));
  window.scrollTo({ top: scrollY });
  scheduleQuickPicks();
  renderRailOnly();
}

function refreshBets() {
  if (!current.pred || current.pred.empty) return;
  current.rec = recommendBets(current.pred, { budget: state.budget, strategy: state.strategy, types: state.betTypes, blend: state.blend });
  setHTML($('#slot-bets'), renderBetsPanel(current.pred, current.rec, ctx()));
  const sum = $('#slot-summary');
  if (sum) setHTML(sum, renderSummary(current.pred, current.rec, state.preset));
  if (current.pred.race.result?.length) {
    // 答え合わせも今の買い方で作り直す
    const scrollY = window.scrollY;
    setHTML($('#race-main'), renderRaceMain(current.pred, current.rec, ctx()));
    window.scrollTo({ top: scrollY });
  }
}

function refreshCard() {
  const slot = $('#slot-card');
  if (slot && current.pred) setHTML(slot, renderCardTable(current.pred, ctx()));
}

/** 発走までの時間・状態の表示だけ更新 */
function tickClock() {
  if (state.tab !== 'predict') return;
  renderRailOnly();
  const race = current.pred?.race || current.jump;
  const badge = $('#race-main .rh-eyebrow .status-badge');
  if (race && badge && !race.imported) badge.outerHTML = statusBadge(race, Date.now(), { withTime: true });
}

// ---------------------------------------------------------------------------
// バックテスト

/** 直近の開催日の、結果が確定した平地のレース */
function recentRaces() {
  const t = today();
  return days()
    .filter((d) => d.date <= t)
    .flatMap((d) => d.races)
    .filter((r) => r.result?.length && !r.jump && r.surface !== '障');
}

function renderBacktestView() {
  const el = $('#view-backtest');
  setHTML(el, renderBacktest(ctx()));
  const res = currentBacktest(bt);
  if (res) {
    const focus = res.strategies.find((s) => s.key === bt.focus) || res.strategies[0];
    const base = res.strategies.find((s) => s.key === 'fav');
    const step = res.step || 1;
    bindLineChart(
      $('#bt-line'),
      [
        { label: focus.label, values: focus.curve },
        { label: base.label, values: base.curve },
      ],
      null,
      (i) => Math.min(res.races, (i + 1) * step),
    );
  }
}

function updateProgress() {
  const bar = $('#view-backtest .progress');
  if (!bar) return;
  bar.hidden = false;
  bar.setAttribute('aria-valuenow', String(Math.round(bt.recent.progress * 100)));
  bar.firstElementChild.style.width = `${(bt.recent.progress * 100).toFixed(0)}%`;
}

async function runRecentBacktest() {
  if (bt.recent.running) return;
  const races = recentRaces().map(effectiveRace);
  if (!races.length) return;
  bt.recent.running = true;
  bt.recent.progress = 0;
  bt.source = 'recent';
  renderBacktestView();
  try {
    bt.recent.result = await runBacktest(
      races,
      { weights: state.weights, noise: state.noise, blend: state.blend, stats: currentStats(), ml: !!PRESETS[state.preset]?.ml },
      {
        sims: 4000,
        onProgress: (p) => {
          bt.recent.progress = p;
          updateProgress();
        },
      },
    );
  } finally {
    bt.recent.running = false;
    if (state.tab === 'backtest') renderBacktestView();
  }
}

// ---------------------------------------------------------------------------
// 画面

function renderDataView() {
  setHTML($('#view-data'), renderData(ctx()));
}

function renderLogicView() {
  setHTML($('#view-logic'), renderLogic(ctx()));
}

function setHash(token) {
  try {
    history.replaceState(null, '', token ? `#${token}` : location.pathname + location.search);
  } catch {
    // フレーム内などで使えない場合は無視
  }
}

function showTab(tab, { updateHash = true } = {}) {
  state.tab = TABS.includes(tab) ? tab : 'predict';
  document.querySelectorAll('.tab[data-tab]').forEach((b) => {
    const on = b.dataset.tab === state.tab;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });
  for (const t of TABS) $(`#view-${t}`).hidden = t !== state.tab;
  if (state.tab === 'predict') renderPredict();
  else if (state.tab === 'backtest') renderBacktestView();
  else if (state.tab === 'data') renderDataView();
  else renderLogicView();
  renderTopStatus();
  if (updateHash) setHash(state.tab === 'predict' ? state.raceId : state.tab);
}

function selectRace(id) {
  const base = baseRace(id);
  if (!base) return;
  state.raceId = id;
  state.day = dayOfRace(base);
  if (!base.imported) state.venue = base.course;
  userPicked = true;
  persist();
  if (state.tab !== 'predict') showTab('predict');
  else {
    renderPredict();
    setHash(id);
  }
  const head = $('#race-main');
  if (head && head.getBoundingClientRect().top < 0) head.scrollIntoView({ block: 'start' });
}

function selectDay(day) {
  state.day = day;
  const venues = venuesOf(day);
  if (!venues.includes(state.venue)) state.venue = venues[0] || null;
  const race = defaultRace(day, day === 'import' ? null : state.venue);
  if (race) return selectRace(race.id);
  persist();
  renderPredict();
}

// ---------------------------------------------------------------------------
// 変更の記録

function editOf(id) {
  if (!state.edits[id]) state.edits[id] = {};
  return state.edits[id];
}

function cleanEdits(id) {
  const ed = state.edits[id];
  if (!ed) return;
  if (ed.odds && !Object.keys(ed.odds).length) delete ed.odds;
  if (ed.scratched && !Object.keys(ed.scratched).length) delete ed.scratched;
  if (!ed.going && !ed.odds && !ed.scratched) delete state.edits[id];
}

function matchPreset(weights) {
  for (const [k, p] of Object.entries(PRESETS)) {
    if (FACTORS.every((f) => Number(p.weights[f.key]) === Number(weights[f.key]))) return k;
  }
  return 'custom';
}

let recomputeTimer = null;
function scheduleRecompute() {
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(() => {
    persist();
    refreshPrediction();
  }, 160);
}

// ---------------------------------------------------------------------------
// データの自動更新

let pendingRefresh = false;
const typing = () => {
  const a = document.activeElement;
  return a && a.matches?.('input:not([type="checkbox"]):not([type="range"]), textarea, select');
};

function applyDataUpdate() {
  if (typing()) {
    pendingRefresh = true;
    return;
  }
  pendingRefresh = false;
  if (state.tab === 'predict') {
    const before = current.pred?.race ? raceSig(current.pred.race) : null;
    const base = state.raceId ? baseRace(state.raceId) : null;
    if (!current.pred || !base || raceSig(base) !== before) refreshPrediction();
    else {
      renderTopStatus();
      renderRailOnly();
      scheduleQuickPicks();
    }
  } else if (state.tab === 'data') renderDataView();
  else renderTopStatus();
}

async function poll() {
  const liveBefore = data.liveUrl;
  await fetchLiveInfo();
  const changed = (await fetchBundle()) || liveBefore !== data.liveUrl;
  if (changed) applyDataUpdate();
  else if (state.tab === 'data') renderDataView();
  setTimeout(poll, data.live ? 60 * 1000 : 5 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// クリップボード

async function copyText(text, statusEl, fallbackEl) {
  try {
    await navigator.clipboard.writeText(text);
    if (statusEl) statusEl.textContent = 'コピーしました';
    if (fallbackEl) fallbackEl.hidden = true;
  } catch {
    if (fallbackEl) {
      fallbackEl.hidden = false;
      fallbackEl.value = text;
      fallbackEl.focus();
      fallbackEl.select();
    }
    if (statusEl) statusEl.textContent = '自動でコピーできませんでした。下の欄を選択したので Ctrl+C（⌘+C）でコピーしてください';
  }
}

// ---------------------------------------------------------------------------
// データ取り込み

function readFormFromDom() {
  const form = $('#import-form');
  if (!form) return;
  const fd = new FormData(form);
  for (const k of ['date', 'course', 'raceNo', 'name', 'grade', 'surface', 'distance', 'going', 'card', 'past']) {
    if (fd.has(k)) dataView.form[k] = String(fd.get(k));
  }
}

function addImported(races) {
  for (const r of races) {
    const i = imported.findIndex((x) => x.id === r.id);
    if (i >= 0) imported[i] = r;
    else imported.push(r);
  }
  persist();
}

async function readFileText(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // Excel などで保存した Shift_JIS の CSV
    return new TextDecoder('shift_jis').decode(buf);
  }
}

// ---------------------------------------------------------------------------
// イベント

function onClick(e) {
  const t = e.target;
  const tabBtn = t.closest('[data-tab]');
  if (tabBtn) {
    e.preventDefault();
    showTab(tabBtn.dataset.tab);
    if (tabBtn.dataset.tab !== 'predict') window.scrollTo({ top: 0 });
    return;
  }
  const raceBtn = t.closest('[data-race]');
  if (raceBtn) return selectRace(raceBtn.dataset.race);
  const dayBtn = t.closest('[data-day]');
  if (dayBtn) return selectDay(dayBtn.dataset.day);
  const venueBtn = t.closest('[data-venue]');
  if (venueBtn) {
    state.venue = venueBtn.dataset.venue;
    const race = defaultRace(state.day, state.venue);
    if (race) return selectRace(race.id);
    persist();
    return renderPredict();
  }
  const goingBtn = t.closest('[data-going]');
  if (goingBtn) {
    const base = baseRace(state.raceId);
    if (!base) return;
    const ed = editOf(state.raceId);
    ed.going = goingBtn.dataset.going === base.going ? undefined : goingBtn.dataset.going;
    if (!ed.going) delete ed.going;
    cleanEdits(state.raceId);
    persist();
    return renderPredict();
  }
  const act = t.closest('[data-action]')?.dataset.action;
  if (act === 'reset-edits') {
    delete state.edits[state.raceId];
    persist();
    return renderPredict();
  }
  if (act === 'goto-bets') {
    e.preventDefault();
    $('#panel-bets')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (act === 'copy-bets' && current.rec) {
    const race = current.pred.race;
    const text = ticketsToText(`${race.name}（${race.date} ${race.course}${race.raceNo}R）KEIB AI推奨・${STRATEGIES[state.strategy].label}`, current.rec.tickets);
    copyText(text, $('#panel-bets .copy-status'), $('#copy-fallback-bets'));
    return;
  }
  if (act === 'reset-weights') {
    state.weights = { ...DEFAULT_WEIGHTS };
    state.preset = DEFAULT_PRESET;
    state.noise = DEFAULT_NOISE;
    persist();
    return renderPredict();
  }
  if (act === 'run-recent') return runRecentBacktest();
  if (act === 'reload-data') {
    fetchBundle().then((changed) => {
      if (changed) applyDataUpdate();
      renderDataView();
    });
    return;
  }
  if (act === 'import-json') {
    const text = $('#f-json')?.value || '';
    dataView.json = text;
    const { races, errors } = parseRacesJSON(text);
    if (errors.length) dataView.jsonMessage = { error: true, text: errors.join(' / ') };
    else {
      addImported(races);
      dataView.jsonMessage = { error: false, text: `${races.length}レースを取り込みました。予想画面の「取り込み」に並んでいます。` };
    }
    return renderDataView();
  }
  if (act === 'export-json') {
    const base = baseRace(state.raceId);
    if (base) {
      dataView.json = raceToJSON(effectiveRace(base));
      dataView.jsonMessage = { error: false, text: `${base.name} を書き出しました。` };
    }
    return renderDataView();
  }
  if (act === 'copy-json') {
    const el = $('#f-json');
    if (el && el.value) copyText(el.value, null, el);
    return;
  }
  const sortBtn = t.closest('[data-sort]');
  if (sortBtn) {
    state.sort = sortBtn.dataset.sort;
    persist();
    return refreshCard();
  }
  const strat = t.closest('[data-strategy]');
  if (strat) {
    state.strategy = strat.dataset.strategy;
    persist();
    return refreshBets();
  }
  const budgetBtn = t.closest('[data-budget]');
  if (budgetBtn) {
    state.budget = Number(budgetBtn.dataset.budget);
    persist();
    return refreshBets();
  }
  const preset = t.closest('[data-preset]');
  if (preset) {
    state.preset = preset.dataset.preset;
    state.weights = { ...PRESETS[state.preset].weights };
    state.noise = PRESETS[state.preset].noise ?? 1;
    persist();
    return renderPredict();
  }
  const btPreset = t.closest('[data-bt-preset]');
  if (btPreset) {
    bt.source = 'saved';
    bt.preset = btPreset.dataset.btPreset;
    return renderBacktestView();
  }
  const focusRow = t.closest('[data-bt-focus]');
  if (focusRow) {
    bt.focus = focusRow.dataset.btFocus;
    return renderBacktestView();
  }
  const tmpl = t.closest('[data-template]');
  if (tmpl) {
    readFormFromDom();
    if (tmpl.dataset.template === 'card') dataView.form.card = dataView.form.card ? dataView.form.card : `${CARD_HEADER}\n`;
    else dataView.form.past = dataView.form.past ? dataView.form.past : `${PAST_HEADER}\n`;
    return renderDataView();
  }
  const openRace = t.closest('[data-open-race]');
  if (openRace) return selectRace(openRace.dataset.openRace);
  const del = t.closest('[data-delete-race]');
  if (del) {
    imported = imported.filter((r) => r.id !== del.dataset.deleteRace);
    delete state.edits[del.dataset.deleteRace];
    if (state.raceId === del.dataset.deleteRace) {
      state.raceId = null;
      userPicked = false;
    }
    persist();
    return renderDataView();
  }
  // 出馬表の行：開閉
  const toggle = t.closest('[data-toggle]');
  const row = t.closest('tr.row[data-num]');
  if (toggle || (row && !t.closest('input, label, a, button:not([data-toggle])'))) {
    const num = Number((toggle || row).dataset.toggle ?? row.dataset.num);
    const list = new Set(state.expanded[state.raceId] || []);
    if (list.has(num)) list.delete(num);
    else list.add(num);
    state.expanded[state.raceId] = [...list];
    refreshCard();
    $(`[data-toggle="${num}"]`)?.focus({ preventScroll: true });
  }
}

function onInput(e) {
  const t = e.target;
  if (t.matches('[data-weight]')) {
    state.weights[t.dataset.weight] = Number(t.value);
    const out = $(`#wo-${t.dataset.weight}`);
    if (out) out.textContent = t.value;
    state.preset = matchPreset(state.weights);
    document.querySelectorAll('[data-preset]').forEach((b) => {
      b.classList.toggle('is-on', b.dataset.preset === state.preset);
      b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset));
    });
    const pill = $('#custom-pill');
    if (pill) pill.hidden = state.preset !== 'custom';
    return scheduleRecompute();
  }
  if (t.matches('[data-noise]')) {
    state.noise = Number(t.value);
    const out = $('#noise-out');
    if (out) out.textContent = Number(t.value).toFixed(1);
    return scheduleRecompute();
  }
  if (t.closest('#import-form') && (t.name === 'card' || t.name === 'past')) {
    dataView.form[t.name] = t.value;
  }
  if (t.id === 'f-json') dataView.json = t.value;
}

function onChange(e) {
  const t = e.target;
  if (t.matches('[data-budget-input]')) {
    const v = Math.max(100, Math.round(Number(t.value) / 100) * 100 || 100);
    state.budget = v;
    persist();
    return refreshBets();
  }
  if (t.matches('[data-bettype]')) {
    const set = new Set(state.betTypes);
    if (t.checked) set.add(t.dataset.bettype);
    else set.delete(t.dataset.bettype);
    state.betTypes = BET_TYPES.filter((x) => set.has(x));
    persist();
    return refreshBets();
  }
  if (t.matches('[data-blend]')) {
    state.blend = Number(t.value);
    persist();
    return refreshBets();
  }
  if (t.matches('[data-sims]')) {
    state.sims = Number(t.value);
    persist();
    return refreshPrediction();
  }
  if (t.matches('[data-odds]')) {
    const num = Number(t.dataset.odds);
    const v = Number(t.value);
    const base = baseRace(state.raceId)?.entries.find((x) => x.number === num);
    const ed = editOf(state.raceId);
    ed.odds = ed.odds || {};
    if (!(v >= 1) || v === base?.odds) delete ed.odds[num];
    else ed.odds[num] = Math.round(v * 10) / 10;
    cleanEdits(state.raceId);
    persist();
    return refreshPrediction();
  }
  if (t.matches('[data-scratch]')) {
    const num = Number(t.dataset.scratch);
    const ed = editOf(state.raceId);
    ed.scratched = ed.scratched || {};
    if (t.checked) ed.scratched[num] = true;
    else delete ed.scratched[num];
    cleanEdits(state.raceId);
    persist();
    return refreshPrediction();
  }
  if (t.matches('[data-bundle-file]') && t.files?.[0]) {
    readFileText(t.files[0]).then((text) => {
      try {
        const json = JSON.parse(text);
        if (!Array.isArray(json.days)) throw new Error();
        setBundle(json);
        data.lastFetch = new Date().toISOString();
        userPicked = false;
        renderDataView();
      } catch {
        data.loadError = 'バンドルの形式が違います（data/bundle.json を選んでください）';
        renderDataView();
      }
    });
    return;
  }
  if (t.matches('[data-file-for]') && t.files?.[0]) {
    const target = t.dataset.fileFor;
    readFormFromDom();
    readFileText(t.files[0]).then((text) => {
      dataView.form[target === 'f-card' ? 'card' : 'past'] = text;
      renderDataView();
    });
  }
}

function onSubmit(e) {
  if (e.target.id !== 'import-form') return;
  e.preventDefault();
  readFormFromDom();
  const f = dataView.form;
  const { race, errors, warnings } = buildImportedRace(f, f.card, f.past);
  if (!race) {
    dataView.messages = { errors, warnings };
    renderDataView();
    $('.msg-box')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  addImported([race]);
  dataView.messages = { errors: [], warnings, okText: `${race.name}（${race.entries.length}頭）を取り込みました。` };
  selectRace(race.id);
}

function onKeydown(e) {
  const row = e.target.closest?.('[data-bt-focus]');
  if (row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    bt.focus = row.dataset.btFocus;
    renderBacktestView();
    $(`[data-bt-focus="${bt.focus}"]`)?.focus();
  }
}

// ---------------------------------------------------------------------------
// 起動

function routeFromHash() {
  const token = (location.hash || '').replace(/^#/, '');
  if (TABS.includes(token)) return { tab: token };
  if (token) return { tab: 'predict', raceId: token };
  return { tab: 'predict' };
}

function applyRoute(r) {
  if (r.raceId && baseRace(r.raceId)) {
    state.raceId = r.raceId;
    userPicked = true;
  }
  showTab(r.tab, { updateHash: false });
}

async function start() {
  const app = $('#app');
  app.addEventListener('click', onClick);
  app.addEventListener('input', onInput);
  app.addEventListener('change', onChange);
  app.addEventListener('submit', onSubmit);
  app.addEventListener('keydown', onKeydown);
  app.addEventListener('focusout', () => {
    if (pendingRefresh) setTimeout(() => !typing() && applyDataUpdate(), 0);
  });
  installTooltips(app);
  window.addEventListener('hashchange', () => applyRoute(routeFromHash()));
  const route = routeFromHash();
  showTab(route.tab, { updateHash: false });
  await Promise.all([fetchBundle(), fetchLiveInfo()]);
  applyRoute(route);
  setInterval(tickClock, 30 * 1000);
  setTimeout(poll, data.live ? 60 * 1000 : 5 * 60 * 1000);
}

start();

// KEIB 競馬予想 — アプリ本体（状態・画面切り替え・イベント）

import { generateRaceDay, backtestRaceStream, SAMPLE_DATE } from './data/generator.js';
import { SIRE_MAP } from './data/names.js';
import { BET_TYPES } from './engine/constants.js';
import { predictRace, DEFAULT_WEIGHTS, PRESETS, FACTORS } from './engine/model.js';
import { recommendBets, ticketsToText, STRATEGIES, DEFAULT_BLEND, BLEND_OPTIONS } from './engine/bets.js';
import { runBacktest } from './engine/backtest.js';
import { buildImportedRace, parseRacesJSON, raceToJSON, CARD_TEMPLATE, PAST_TEMPLATE } from './engine/importer.js';
import { formatDateJa } from './engine/util.js';
import {
  renderRail,
  renderRaceMain,
  renderSummary,
  renderCardTable,
  renderPacePanel,
  renderBetsPanel,
  renderWeightsPanel,
  renderEmptyRace,
} from './ui/predictView.js';
import { renderBacktest } from './ui/backtestView.js';
import { renderData } from './ui/dataView.js';
import { renderLogic } from './ui/logicView.js';
import { bindLineChart } from './ui/charts.js';
import { installTooltips } from './ui/tooltip.js';
import { loadState, saveState } from './ui/store.js';

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
// データと状態

const day = generateRaceDay();
const sampleById = new Map(day.races.map((r) => [r.id, r]));
const saved = loadState();

const TABS = ['predict', 'backtest', 'data', 'logic'];

const state = {
  tab: 'predict',
  venue: ['東京', '京都', 'import'].includes(saved.venue) ? saved.venue : '東京',
  raceId: typeof saved.raceId === 'string' ? saved.raceId : 'tky11',
  weights: { ...DEFAULT_WEIGHTS, ...(saved.weights || {}) },
  preset: saved.preset || 'balance',
  noise: Number(saved.noise) || 1,
  sims: [5000, 20000, 50000].includes(saved.sims) ? saved.sims : 20000,
  budget: Number(saved.budget) >= 100 ? Number(saved.budget) : 3000,
  strategy: STRATEGIES[saved.strategy] ? saved.strategy : 'balance',
  betTypes: Array.isArray(saved.betTypes) ? saved.betTypes.filter((t) => BET_TYPES.includes(t)) : [...BET_TYPES],
  sort: saved.sort === 'ai' ? 'ai' : 'number',
  blend: BLEND_OPTIONS.some((o) => o.value === saved.blend) ? saved.blend : DEFAULT_BLEND,
  expanded: {},
  edits: saved.edits && typeof saved.edits === 'object' ? saved.edits : {},
};
let imported = Array.isArray(saved.imported) ? saved.imported.filter((r) => r && Array.isArray(r.entries)) : [];

const bt = { count: 200, running: false, progress: 0, stage: '', result: null, focus: 'ai', stream: null, races: [], started: false };
const dataView = {
  form: { date: SAMPLE_DATE, course: '中山', raceNo: 11, name: '', grade: '3勝', surface: '芝', distance: 1800, going: '良', card: '', past: '' },
  messages: null,
  json: '',
  jsonMessage: null,
};

let current = { pred: null, rec: null };

function persist() {
  const { venue, raceId, weights, preset, noise, sims, budget, strategy, betTypes, sort, blend, edits } = state;
  saveState({ venue, raceId, weights, preset, noise, sims, budget, strategy, betTypes, sort, blend, edits, imported });
}

const venues = () => [
  { key: '東京', label: '東京' },
  { key: '京都', label: '京都' },
  { key: 'import', label: '取り込み', count: imported.length },
];

const racesOf = (venue) => (venue === 'import' ? imported : day.races.filter((r) => r.course === venue));
const baseRace = (id) => sampleById.get(id) || imported.find((r) => r.id === id) || null;
const venueOf = (race) => (race.imported ? 'import' : race.course);

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
// 予想（キャッシュつき）

const predCache = new Map();
const settingsKey = () => JSON.stringify([state.weights, state.noise, state.sims]);

function getPrediction(race) {
  const key = `${race.id}|${JSON.stringify(state.edits[race.id] || null)}|${settingsKey()}`;
  const hit = predCache.get(key);
  if (hit) return hit;
  const pred = predictRace(race, { weights: state.weights, noise: state.noise, sims: state.sims, sires: SIRE_MAP });
  predCache.set(key, pred);
  if (predCache.size > 30) predCache.delete(predCache.keys().next().value);
  return pred;
}

const quickPicks = new Map();
let quickKey = '';
let quickTimer = null;

function pickOf(pred) {
  const h = pred.order[0];
  return { number: h.entry.number, frame: h.entry.frame, name: h.entry.name, grade: pred.confidence.grade };
}

/** レース一覧の◎を裏で少しずつ計算 */
function scheduleQuickPicks() {
  const key = `${settingsKey()}|${JSON.stringify(state.edits)}`;
  if (key !== quickKey) {
    quickPicks.clear();
    quickKey = key;
  }
  clearTimeout(quickTimer);
  const queue = racesOf(state.venue).filter((r) => !quickPicks.has(r.id));
  const step = () => {
    const t0 = performance.now();
    while (queue.length && performance.now() - t0 < 24) {
      const race = effectiveRace(queue.shift());
      const pred = getPrediction(race);
      if (!pred.empty) quickPicks.set(race.id, pickOf(pred));
    }
    if (state.tab === 'predict') renderRailOnly();
    if (queue.length) quickTimer = setTimeout(step, 16);
  };
  if (queue.length) quickTimer = setTimeout(step, 30);
}

// ---------------------------------------------------------------------------
// 描画

const ctx = () => ({ state, venues: venues(), racesOf, quickPicks, edits: state.edits[state.raceId], bt, dataView, imported });

function renderRailOnly() {
  const rail = $('#race-rail');
  const scroll = rail.querySelector('.race-list')?.scrollLeft ?? 0;
  const scrollTop = rail.scrollTop;
  setHTML(rail, renderRail(ctx()));
  const list = rail.querySelector('.race-list');
  if (list) list.scrollLeft = scroll;
  rail.scrollTop = scrollTop;
}

function computeCurrent() {
  let base = baseRace(state.raceId);
  if (!base) {
    base = racesOf(state.venue)[0] || day.races[0];
    if (base) state.raceId = base.id;
  }
  if (!base) return null;
  if (venueOf(base) !== state.venue) state.venue = venueOf(base);
  const race = effectiveRace(base);
  const pred = getPrediction(race);
  if (pred.empty) return { pred, rec: null };
  quickPicks.set(race.id, pickOf(pred));
  const rec = recommendBets(pred, { budget: state.budget, strategy: state.strategy, types: state.betTypes, blend: state.blend });
  return { pred, rec };
}

function renderPredict() {
  current = computeCurrent() || { pred: null, rec: null };
  renderRailOnly();
  const main = $('#race-main');
  if (!current.pred || current.pred.empty) {
    setHTML(main, renderEmptyRace(ctx()));
    setHTML($('#slot-pace'), '');
    setHTML($('#slot-bets'), '');
    setHTML($('#slot-weights'), renderWeightsPanel(ctx()));
    return;
  }
  setHTML(main, renderRaceMain(current.pred, current.rec, ctx()));
  setHTML($('#slot-pace'), renderPacePanel(current.pred));
  setHTML($('#slot-bets'), renderBetsPanel(current.pred, current.rec, ctx()));
  setHTML($('#slot-weights'), renderWeightsPanel(ctx()));
  scheduleQuickPicks();
}

/** 重みを動かしている最中：スライダーは作り直さずに、予想だけ更新 */
function refreshPrediction() {
  current = computeCurrent() || current;
  if (!current.pred || current.pred.empty) return renderPredict();
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
  if (sum) setHTML(sum, renderSummary(current.pred, current.rec));
}

function refreshCard() {
  const slot = $('#slot-card');
  if (slot && current.pred) setHTML(slot, renderCardTable(current.pred, ctx()));
}

function renderBacktestView() {
  const el = $('#view-backtest');
  setHTML(el, renderBacktest(ctx()));
  if (bt.result) {
    const focus = bt.result.strategies.find((s) => s.key === bt.focus) || bt.result.strategies[0];
    const base = bt.result.strategies.find((s) => s.key === 'fav');
    bindLineChart($('#bt-line'), [
      { label: focus.label, values: focus.curve },
      { label: base.label, values: base.curve },
    ]);
  }
}

function updateProgress() {
  const bar = $('#view-backtest .progress');
  if (!bar) return;
  bar.hidden = false;
  bar.setAttribute('aria-valuenow', String(Math.round(bt.progress * 100)));
  bar.firstElementChild.style.width = `${(bt.progress * 100).toFixed(0)}%`;
  const label = $('#view-backtest .progress-label');
  if (label) label.textContent = bt.stage;
}

function renderDataView() {
  setHTML($('#view-data'), renderData(ctx()));
}

function renderLogicView() {
  setHTML($('#view-logic'), renderLogic(ctx()));
}

function setHash(token) {
  try {
    history.replaceState(null, '', `#${token}`);
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
  else if (state.tab === 'backtest') {
    renderBacktestView();
    if (!bt.started) runBacktestUI();
  } else if (state.tab === 'data') renderDataView();
  else renderLogicView();
  if (updateHash) setHash(state.tab === 'predict' ? state.raceId : state.tab);
}

function selectRace(id) {
  const base = baseRace(id);
  if (!base) return;
  state.raceId = id;
  state.venue = venueOf(base);
  persist();
  if (state.tab !== 'predict') showTab('predict');
  else {
    renderPredict();
    setHash(id);
  }
  const head = $('#race-main');
  if (head && head.getBoundingClientRect().top < 0) head.scrollIntoView({ block: 'start' });
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
// バックテスト

async function runBacktestUI() {
  if (bt.running) return;
  bt.started = true;
  bt.running = true;
  bt.progress = 0;
  bt.stage = '過去レースを用意しています';
  renderBacktestView();
  try {
    if (!bt.stream) bt.stream = backtestRaceStream(777);
    while (bt.races.length < bt.count) {
      const t0 = performance.now();
      while (bt.races.length < bt.count && performance.now() - t0 < 40) bt.races.push(bt.stream.next());
      bt.progress = 0.45 * (bt.races.length / bt.count);
      updateProgress();
      await new Promise((r) => setTimeout(r, 0));
    }
    bt.stage = '予想して払戻を精算しています';
    const result = await runBacktest(
      bt.races.slice(0, bt.count),
      { weights: state.weights, noise: state.noise, blend: state.blend, sires: SIRE_MAP },
      {
        sims: 2000,
        onProgress: (p) => {
          bt.progress = 0.45 + 0.55 * p;
          updateProgress();
        },
      },
    );
    bt.result = result;
  } finally {
    bt.running = false;
    bt.stage = '';
    if (state.tab === 'backtest') renderBacktestView();
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
  const venueBtn = t.closest('[data-venue]');
  if (venueBtn) {
    state.venue = venueBtn.dataset.venue;
    const first = racesOf(state.venue)[0];
    if (first) state.raceId = first.id;
    persist();
    renderPredict();
    if (first) setHash(first.id);
    return;
  }
  const goingBtn = t.closest('[data-going]');
  if (goingBtn) {
    const base = baseRace(state.raceId);
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
    const text = ticketsToText(`${race.name}（${race.course}${race.raceNo}R）KEIB AI推奨・${STRATEGIES[state.strategy].label}`, current.rec.tickets);
    copyText(text, $('#panel-bets .copy-status'), $('#copy-fallback-bets'));
    return;
  }
  if (act === 'reset-weights') {
    state.weights = { ...DEFAULT_WEIGHTS };
    state.preset = 'balance';
    state.noise = 1;
    persist();
    return renderPredict();
  }
  if (act === 'run-backtest') return runBacktestUI();
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
    persist();
    return renderPredict();
  }
  const focusRow = t.closest('[data-bt-focus]');
  if (focusRow) {
    bt.focus = focusRow.dataset.btFocus;
    return renderBacktestView();
  }
  const tmpl = t.closest('[data-template]');
  if (tmpl) {
    readFormFromDom();
    if (tmpl.dataset.template === 'card') {
      dataView.form.card = CARD_TEMPLATE;
      if (!dataView.form.name) Object.assign(dataView.form, { name: 'サンプル特別', course: '中山', grade: '3勝', surface: '芝', distance: 1800 });
    } else dataView.form.past = PAST_TEMPLATE;
    return renderDataView();
  }
  const openRace = t.closest('[data-open-race]');
  if (openRace) return selectRace(openRace.dataset.openRace);
  const del = t.closest('[data-delete-race]');
  if (del) {
    imported = imported.filter((r) => r.id !== del.dataset.deleteRace);
    delete state.edits[del.dataset.deleteRace];
    if (state.raceId === del.dataset.deleteRace) {
      state.raceId = 'tky11';
      state.venue = '東京';
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
  if (t.matches('[data-bt-count]')) {
    bt.count = Number(t.value);
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
  state.venue = 'import';
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
  if (token && baseRace(token)) return { tab: 'predict', raceId: token };
  return { tab: 'predict' };
}

function start() {
  $('#meet-date').textContent = `${formatDateJa(day.date)} 東京・京都`;
  const app = $('#app');
  app.addEventListener('click', onClick);
  app.addEventListener('input', onInput);
  app.addEventListener('change', onChange);
  app.addEventListener('submit', onSubmit);
  app.addEventListener('keydown', onKeydown);
  installTooltips(app);
  window.addEventListener('hashchange', () => {
    const r = routeFromHash();
    if (r.raceId) state.raceId = r.raceId;
    showTab(r.tab, { updateHash: false });
  });
  const r = routeFromHash();
  if (r.raceId) state.raceId = r.raceId;
  showTab(r.tab, { updateHash: false });
}

start();

// データ取り込み：CSV（出馬表・過去走）と JSON。日本語の列名に対応し、誤りは行番号つきで返す。

import { COURSE_NAMES, GOINGS, GRADES, frameOf } from './constants.js';
import { hashString } from './rng.js';
import { parseTime, isValidDate } from './util.js';

/** CSV/TSV を2次元配列に（ダブルクォート・改行・BOM 対応） */
export function parseCSV(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delim = firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

const toHalfWidth = (s) =>
  String(s ?? '')
    .replace(/[０-９Ａ-Ｚａ-ｚ．：－＋]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[−―]/g, '-')
    .trim();

const num = (s) => {
  const t = toHalfWidth(s).replace(/,/g, '');
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

export function normDate(s) {
  const t = toHalfWidth(s).replace(/[./年月]/g, '-').replace(/日$/, '');
  const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const v = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return isValidDate(v) ? v : null;
}

export function normSurface(s) {
  const t = toHalfWidth(s);
  if (/^芝/.test(t) || /^turf$/i.test(t)) return '芝';
  if (/^ダ/.test(t) || /^dirt$/i.test(t)) return 'ダ';
  return null;
}

export function normGoing(s) {
  const t = toHalfWidth(s);
  if (GOINGS.includes(t)) return t;
  if (t === '稍') return '稍重';
  if (t === '不') return '不良';
  return null;
}

export function normGrade(s) {
  let t = toHalfWidth(s).toUpperCase().replace(/Ⅰ/g, '1').replace(/Ⅱ/g, '2').replace(/Ⅲ/g, '3').replace(/\s/g, '');
  t = t.replace(/^JPN/, 'G').replace(/クラス$/, '').replace(/万下$/, '');
  if (/^G[123]$/.test(t)) return t;
  if (t === 'L' || t === 'LISTED' || t === 'リステッド') return 'L';
  if (t === 'OP' || t === 'オープン' || t === 'OPEN') return 'OP';
  if (/^[123]勝$/.test(t)) return t;
  if (t === '500') return '1勝';
  if (t === '1000') return '2勝';
  if (t === '1600') return '3勝';
  if (t === '新馬' || t === 'メイクデビュー') return '新馬';
  if (t === '未勝利') return '未勝利';
  return null;
}

export function normCourse(s) {
  const t = toHalfWidth(s).replace(/競馬場$/, '');
  return COURSE_NAMES.find((c) => t === c || t.includes(c)) || null;
}

function splitSexAge(s) {
  const t = toHalfWidth(s);
  const m = t.match(/^(牡|牝|セ|騸)\s*(\d+)$/);
  if (!m) return null;
  return { sex: m[1] === '騸' ? 'セ' : m[1], age: Number(m[2]) };
}

function parseBodyWeight(s) {
  const t = toHalfWidth(s);
  const m = t.match(/^(\d{3})\s*\(([-+]?\d+)\)$/);
  if (m) return { bodyWeight: Number(m[1]), bodyWeightDiff: Number(m[2]) };
  const v = num(t);
  return { bodyWeight: v };
}

function parseRate(s) {
  const t = toHalfWidth(s).replace('%', '');
  const v = num(t);
  if (v == null) return null;
  return v > 1 ? v / 100 : v;
}

// 列名の別名
const CARD_COLUMNS = {
  frame: ['枠', '枠番'],
  number: ['馬番', '番'],
  name: ['馬名'],
  sexAge: ['性齢'],
  sex: ['性', '性別'],
  age: ['齢', '年齢'],
  weight: ['斤量', '負担重量'],
  jockey: ['騎手'],
  bodyWeight: ['馬体重'],
  bodyWeightDiff: ['増減', '体重増減'],
  odds: ['単勝', '単勝オッズ', 'オッズ'],
  popularity: ['人気'],
  sire: ['父', '種牡馬'],
  trainer: ['調教師', '厩舎'],
  jockeyWin: ['騎手勝率'],
  jockeyTop3: ['騎手複勝率'],
  scratched: ['取消', '除外'],
};

const PAST_COLUMNS = {
  number: ['馬番'],
  name: ['馬名'],
  date: ['日付', '年月日'],
  course: ['競馬場', '場', '開催'],
  raceName: ['レース名', 'レース'],
  grade: ['クラス', '格', 'グレード'],
  surface: ['芝ダ', '芝・ダ', 'コース', '馬場種別'],
  distance: ['距離'],
  going: ['馬場', '馬場状態'],
  fieldSize: ['頭数'],
  pastNumber: ['過去馬番', '当時馬番'],
  finish: ['着順', '着'],
  time: ['タイム', '走破タイム'],
  margin: ['着差'],
  last3f: ['上がり', '上がり3F', '上り', '上り3F'],
  last3fRank: ['上がり順位', '上り順位'],
  passing: ['通過', '通過順'],
  weight: ['斤量'],
  jockey: ['騎手'],
  bodyWeight: ['馬体重'],
  odds: ['単勝', 'オッズ'],
  popularity: ['人気'],
};

function mapHeader(header, columns) {
  const idx = {};
  header.forEach((h, i) => {
    const key = toHalfWidth(h).replace(/\s/g, '');
    for (const [field, names] of Object.entries(columns)) {
      if (idx[field] == null && names.includes(key)) idx[field] = i;
    }
  });
  return idx;
}

/** 出馬表 CSV → entries */
export function parseRaceCard(text) {
  const rows = parseCSV(text);
  const errors = [];
  const warnings = [];
  if (rows.length < 2) return { entries: [], jockeys: {}, errors: ['出馬表にデータ行がありません（1行目は列名、2行目から1頭ずつ）'], warnings };
  const idx = mapHeader(rows[0], CARD_COLUMNS);
  if (idx.number == null) errors.push('出馬表に「馬番」列がありません');
  if (idx.name == null) errors.push('出馬表に「馬名」列がありません');
  if (errors.length) return { entries: [], jockeys: {}, errors, warnings };
  const get = (r, f) => (idx[f] != null ? r[idx[f]] ?? '' : '');
  const entries = [];
  const jockeys = {};
  const seen = new Set();
  rows.slice(1).forEach((r, k) => {
    const line = k + 2;
    const number = num(get(r, 'number'));
    const name = get(r, 'name');
    if (!Number.isInteger(number) || number < 1 || number > 18) {
      errors.push(`出馬表 ${line}行目：馬番「${get(r, 'number')}」は1〜18の整数で入力してください`);
      return;
    }
    if (seen.has(number)) {
      errors.push(`出馬表 ${line}行目：馬番${number}が重複しています`);
      return;
    }
    seen.add(number);
    if (!name) {
      errors.push(`出馬表 ${line}行目：馬名が空です`);
      return;
    }
    const sa = splitSexAge(get(r, 'sexAge'));
    const bw = parseBodyWeight(get(r, 'bodyWeight'));
    const e = {
      frame: num(get(r, 'frame')),
      number,
      name,
      sex: sa?.sex || (['牡', '牝', 'セ'].includes(get(r, 'sex')) ? get(r, 'sex') : ''),
      age: sa?.age ?? num(get(r, 'age')),
      weight: num(get(r, 'weight')),
      jockey: get(r, 'jockey'),
      trainer: get(r, 'trainer'),
      bodyWeight: bw.bodyWeight,
      bodyWeightDiff: bw.bodyWeightDiff ?? num(get(r, 'bodyWeightDiff')),
      odds: num(get(r, 'odds')),
      popularity: num(get(r, 'popularity')),
      sire: get(r, 'sire'),
      scratched: /^(1|○|◯|取消|除外|true|yes)$/i.test(get(r, 'scratched')),
      past: [],
    };
    if (e.odds != null && e.odds < 1) {
      warnings.push(`出馬表 ${line}行目：単勝オッズ「${e.odds}」は1.0以上で入力してください（無視します）`);
      e.odds = null;
    }
    const jw = parseRate(get(r, 'jockeyWin'));
    const jt = parseRate(get(r, 'jockeyTop3'));
    if (e.jockey && (jw != null || jt != null)) jockeys[e.jockey] = { winRate: jw ?? 0.07, top3Rate: jt ?? 0.21 };
    entries.push(e);
  });
  entries.sort((a, b) => a.number - b.number);
  const n = Math.max(entries.length, ...entries.map((e) => e.number));
  for (const e of entries) if (!e.frame) e.frame = frameOf(e.number, n);
  // 人気がなければオッズから付ける
  if (entries.some((e) => e.popularity == null)) {
    const withOdds = entries.filter((e) => e.odds > 1).sort((a, b) => a.odds - b.odds);
    withOdds.forEach((e, k) => {
      e.popularity = k + 1;
    });
  }
  if (!entries.some((e) => e.odds > 1)) warnings.push('単勝オッズがないため、期待値と推定オッズは表示されません');
  return { entries, jockeys, errors, warnings };
}

/** 過去走 CSV → 馬番（または馬名）ごとの過去走 */
export function parsePastRuns(text) {
  const rows = parseCSV(text);
  const errors = [];
  const warnings = [];
  const byKey = new Map();
  if (rows.length < 2) return { byKey, errors, warnings, count: 0 };
  const idx = mapHeader(rows[0], PAST_COLUMNS);
  if (idx.number == null && idx.name == null) errors.push('過去走に「馬番」または「馬名」列がありません');
  if (idx.date == null) errors.push('過去走に「日付」列がありません');
  if (idx.distance == null) errors.push('過去走に「距離」列がありません');
  if (errors.length) return { byKey, errors, warnings, count: 0 };
  const get = (r, f) => (idx[f] != null ? r[idx[f]] ?? '' : '');
  let count = 0;
  rows.slice(1).forEach((r, k) => {
    const line = k + 2;
    const key = idx.number != null ? num(get(r, 'number')) : get(r, 'name');
    const date = normDate(get(r, 'date'));
    if (key == null || key === '') {
      errors.push(`過去走 ${line}行目：馬番（馬名）が空です`);
      return;
    }
    if (!date) {
      errors.push(`過去走 ${line}行目：日付「${get(r, 'date')}」は 2026-09-06 の形で入力してください`);
      return;
    }
    let distRaw = toHalfWidth(get(r, 'distance'));
    let surface = normSurface(get(r, 'surface'));
    const m = distRaw.match(/^(芝|ダ|ダート)?\s*(\d{3,4})m?$/);
    if (m) {
      if (!surface && m[1]) surface = normSurface(m[1]);
      distRaw = m[2];
    }
    const distance = num(distRaw);
    if (!distance || distance < 800 || distance > 4000) {
      errors.push(`過去走 ${line}行目：距離「${get(r, 'distance')}」が読めません（例：1600 または 芝1600）`);
      return;
    }
    const course = normCourse(get(r, 'course'));
    if (get(r, 'course') && !course) warnings.push(`過去走 ${line}行目：競馬場「${get(r, 'course')}」はJRA10場ではないため、コース補正なしで計算します`);
    const finishRaw = toHalfWidth(get(r, 'finish'));
    const finish = /^\d+$/.test(finishRaw) ? Number(finishRaw) : 0;
    const passing = toHalfWidth(get(r, 'passing'))
      .split(/[-‐・,\s]+/)
      .map(Number)
      .filter((v) => Number.isInteger(v) && v > 0);
    const run = {
      date,
      course: course || toHalfWidth(get(r, 'course')),
      raceName: get(r, 'raceName'),
      grade: normGrade(get(r, 'grade')) || '2勝',
      surface: surface || '芝',
      distance,
      going: normGoing(get(r, 'going')) || '良',
      fieldSize: num(get(r, 'fieldSize')) || 16,
      number: num(get(r, 'pastNumber')),
      finish,
      time: parseTime(get(r, 'time')),
      margin: num(get(r, 'margin')),
      last3f: num(get(r, 'last3f')),
      last3fRank: num(get(r, 'last3fRank')),
      passing,
      weight: num(get(r, 'weight')),
      jockey: get(r, 'jockey'),
      bodyWeight: parseBodyWeight(get(r, 'bodyWeight')).bodyWeight,
      odds: num(get(r, 'odds')),
      popularity: num(get(r, 'popularity')),
    };
    if (!surface) warnings.push(`過去走 ${line}行目：芝/ダートが不明なので芝として扱います`);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(run);
    count++;
  });
  for (const runs of byKey.values()) runs.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { byKey, errors, warnings, count };
}

/** レース情報（フォーム）の検証 */
export function validateRaceInfo(info) {
  const errors = [];
  const date = normDate(info.date);
  if (!date) errors.push('開催日を 2026-10-04 の形で入力してください');
  const course = normCourse(info.course);
  if (!course) errors.push('競馬場を選んでください');
  const surface = normSurface(info.surface);
  if (!surface) errors.push('芝かダートを選んでください');
  const distance = num(info.distance);
  if (!distance || distance < 800 || distance > 4000) errors.push('距離は800〜4000mで入力してください');
  const grade = normGrade(info.grade);
  if (!grade) errors.push('クラスを選んでください');
  const going = normGoing(info.going) || '良';
  return {
    errors,
    info: {
      date,
      course,
      surface,
      distance,
      grade,
      going,
      raceNo: num(info.raceNo) || 11,
      name: String(info.name || '').trim() || `${course || ''}${num(info.raceNo) || ''}R`,
      weather: info.weather || '晴',
      startTime: info.startTime || '',
    },
  };
}

/** フォーム + CSV からレースを組み立てる */
export function buildImportedRace(info, cardText, pastText) {
  const v = validateRaceInfo(info);
  const card = parseRaceCard(cardText);
  const past = pastText && pastText.trim() ? parsePastRuns(pastText) : { byKey: new Map(), errors: [], warnings: [], count: 0 };
  const errors = [...v.errors, ...card.errors, ...past.errors];
  const warnings = [...card.warnings, ...past.warnings];
  if (!errors.length && card.entries.length < 2) errors.push('出走馬は2頭以上必要です');
  if (errors.length) return { race: null, errors, warnings };
  let linked = 0;
  for (const e of card.entries) {
    const runs = past.byKey.get(e.number) || past.byKey.get(e.name) || [];
    e.past = runs.filter((r) => r.date < v.info.date).slice(0, 5);
    if (e.past.length) linked++;
  }
  if (past.count && !linked) warnings.push('過去走が出馬表のどの馬にも結び付きませんでした（馬番・馬名を確認してください）');
  const race = {
    ...v.info,
    id: `imp${hashString(`${v.info.date}|${v.info.course}|${v.info.raceNo}|${v.info.name}|${card.entries.map((e) => e.name).join(',')}`).toString(36)}`,
    ageCond: '',
    imported: true,
    entries: card.entries,
    jockeys: card.jockeys,
  };
  return { race, errors: [], warnings };
}

/** JSON（1レース or 配列）→ レースの配列 */
export function parseRacesJSON(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { races: [], errors: [`JSONとして読めません：${e.message}`] };
  }
  const list = Array.isArray(data) ? data : data?.races ? data.races : [data];
  const errors = [];
  const races = [];
  list.forEach((r, k) => {
    const label = list.length > 1 ? `${k + 1}件目：` : '';
    const v = validateRaceInfo(r || {});
    if (v.errors.length) {
      errors.push(...v.errors.map((e) => label + e));
      return;
    }
    if (!Array.isArray(r.entries) || r.entries.length < 2) {
      errors.push(`${label}entries（出走馬）が2頭以上必要です`);
      return;
    }
    const entries = r.entries.map((e, i) => ({
      frame: e.frame ?? null,
      number: Number(e.number ?? i + 1),
      name: String(e.name ?? `${i + 1}番`),
      sex: e.sex ?? '',
      age: e.age ?? null,
      weight: e.weight ?? null,
      jockey: e.jockey ?? '',
      trainer: e.trainer ?? '',
      bodyWeight: e.bodyWeight ?? null,
      bodyWeightDiff: e.bodyWeightDiff ?? null,
      odds: e.odds ?? null,
      popularity: e.popularity ?? null,
      sire: e.sire ?? '',
      scratched: !!e.scratched,
      past: Array.isArray(e.past) ? e.past.filter((p) => p && normDate(p.date)).map((p) => ({ ...p, date: normDate(p.date) })) : [],
    }));
    const n = entries.length;
    entries.forEach((e) => {
      if (!e.frame) e.frame = frameOf(e.number, n);
    });
    races.push({
      ...v.info,
      id: r.id && !String(r.id).startsWith('tky') && !String(r.id).startsWith('kyo') ? String(r.id) : `imp${hashString(JSON.stringify([v.info, entries.map((e) => e.name)])).toString(36)}`,
      imported: true,
      entries,
      jockeys: r.jockeys || {},
      result: Array.isArray(r.result) ? r.result : undefined,
      payouts: r.payouts || undefined,
    });
  });
  return { races, errors };
}

/** レースを JSON 文字列に（取り込み直せる形） */
export function raceToJSON(race) {
  const { id, date, course, raceNo, name, grade, surface, distance, going, weather, startTime, entries, jockeys, result, payouts } = race;
  const used = new Set(entries.map((e) => e.jockey));
  const js = Object.fromEntries(Object.entries(jockeys || {}).filter(([k]) => used.has(k)));
  return JSON.stringify({ id, date, course, raceNo, name, grade, surface, distance, going, weather, startTime, entries, jockeys: js, result, payouts }, null, 2);
}

export const CARD_TEMPLATE = `枠,馬番,馬名,性齢,斤量,騎手,馬体重,増減,単勝オッズ,父,騎手勝率,騎手複勝率
1,1,サンプルアロー,牡4,58,青木,486,+4,3.6,,15.2%,38.0%
2,2,テストルミナス,牝5,56,石田,452,-2,8.9,,8.1%,24.5%
3,3,デモノヴァ,牡4,58,上野,470,0,5.1,,11.0%,30.2%
4,4,レイアウトスター,セ6,58,江藤,498,+8,24.5,,5.5%,18.0%
5,5,チェックブレイヴ,牡3,56,太田,462,-4,4.4,,12.4%,33.1%
6,6,ダミーオーロラ,牝4,56,加藤,440,+2,15.8,,6.9%,21.7%`;

export const PAST_TEMPLATE = `馬番,日付,競馬場,レース名,クラス,芝ダ,距離,馬場,頭数,着順,タイム,着差,上がり3F,上がり順位,通過順,斤量,騎手
1,2026-09-06,中山,サンプル特別,3勝,芝,1800,良,14,2,1:46.8,0.1,34.6,2,5-5-4-3,58,青木
1,2026-07-20,新潟,テストS,3勝,芝,1800,良,16,1,1:45.9,-0.2,33.9,1,8-8,58,青木
2,2026-08-30,新潟,サンプル記念,3勝,芝,2000,稍重,12,4,2:00.4,0.5,35.0,5,3-3-3-4,56,石田
3,2026-09-13,中京,デモ特別,3勝,芝,1600,良,16,3,1:33.5,0.3,34.1,3,9-8,58,上野
4,2026-06-01,東京,チェックS,3勝,芝,1800,重,15,9,1:48.9,1.6,36.0,10,2-2-3-6,58,江藤
5,2026-09-20,中山,テストカップ,3勝,芝,1800,良,13,1,1:47.0,-0.1,34.3,1,2-2-2-1,56,太田
6,2026-09-06,中山,サンプル特別,3勝,芝,1800,良,14,7,1:47.5,0.8,35.1,6,10-10-9-8,56,加藤`;

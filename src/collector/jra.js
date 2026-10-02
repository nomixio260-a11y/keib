// JRA公式サイト（www.jra.go.jp/JRADB）のページを解析する。
// 出馬表（前4走つき・単勝オッズ）、レース一覧、レース結果（払戻）、最終オッズ、開催一覧を扱う。

import { parse } from 'node-html-parser';

export const COURSE_BY_CODE = {
  '01': '札幌',
  '02': '函館',
  '03': '福島',
  '04': '新潟',
  '05': '東京',
  '06': '中山',
  '07': '中京',
  '08': '京都',
  '09': '阪神',
  '10': '小倉',
};
export const CODE_BY_COURSE = Object.fromEntries(Object.entries(COURSE_BY_CODE).map(([k, v]) => [v, k]));

const z2h = (s) =>
  String(s ?? '')
    .replace(/[０-９．，：－（）／]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/ /g, ' ');

const clean = (s) => z2h(s).replace(/\s+/g, ' ').trim();

const toInt = (s) => {
  const m = clean(s).replace(/,/g, '').match(/-?\d+/);
  return m ? Number(m[0]) : null;
};

const toFloat = (s) => {
  const m = clean(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

/** '1:35.5' → 95.5 */
export function parseRaceTime(s) {
  const t = clean(s);
  let m = t.match(/^(\d+):(\d{1,2})\.(\d)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 10;
  m = t.match(/^(\d{1,2})\.(\d)$/);
  if (m) return Number(m[1]) + Number(m[2]) / 10;
  return null;
}

/** '2026年7月11日' → '2026-07-11' */
export function parseJpDate(s) {
  const m = clean(s).match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/** CNAME の中にあるレース番号・日付を取り出す（出馬表・結果・オッズ共通） */
export function raceKeyFromCname(cname) {
  const m = String(cname).match(/pw(?:01dde01|01sde10|151ou(?:S3|10)|01dpr01)(\d{2})(\d{4})(\d{2})(\d{2})(\d{2})(\d{8})/);
  if (!m) return null;
  const [, courseCode, year, kai, day, race, ymd] = m;
  return {
    raceId: `${year}${courseCode}${kai}${day}${race}`,
    courseCode,
    course: COURSE_BY_CODE[courseCode] || null,
    year: Number(year),
    kai: Number(kai),
    day: Number(day),
    raceNo: Number(race),
    date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
  };
}

/** 開催（○回○○○日）の CNAME */
export function meetingKeyFromCname(cname) {
  const m = String(cname).match(/pw01(?:drl00|srl10)(\d{2})(\d{4})(\d{2})(\d{2})(\d{8})/);
  if (!m) return null;
  const [, courseCode, year, kai, day, ymd] = m;
  return {
    courseCode,
    course: COURSE_BY_CODE[courseCode] || null,
    year: Number(year),
    kai: Number(kai),
    day: Number(day),
    date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
  };
}

const cnameFrom = (s) => {
  const m = String(s || '').match(/(p[wk]\d{2}[a-z0-9]+\/[0-9A-F]{2})/i);
  return m ? m[1] : null;
};

/** クラス表記 → 新馬・未勝利・1勝・2勝・3勝・OP・L・G3・G2・G1 */
export function normalizeGrade(...texts) {
  const t = clean(texts.filter(Boolean).join(' ')).replace(/Ⅰ/g, '1').replace(/Ⅱ/g, '2').replace(/Ⅲ/g, '3');
  if (/J・?G1|J・?G2|J・?G3/.test(t)) return t.match(/J・?G([123])/) ? `G${t.match(/J・?G([123])/)[1]}` : 'OP';
  const g = t.match(/(?:G|Jpn)\s?([123])/);
  if (g) return `G${g[1]}`;
  if (/リステッド|\(L\)|（L）/.test(t)) return 'L';
  if (/新馬|メイクデビュー/.test(t)) return '新馬';
  if (/未勝利/.test(t)) return '未勝利';
  if (/1勝|500万/.test(t)) return '1勝';
  if (/2勝|1000万/.test(t)) return '2勝';
  if (/3勝|1600万/.test(t)) return '3勝';
  if (/オープン|OP/.test(t)) return 'OP';
  return null;
}

/** 'コース：1,600メートル（ダート・左）' → { distance, surface, direction, detail } */
export function parseCourse(text) {
  const t = clean(text);
  const distance = toInt(t.replace(/コース：?/, ''));
  const detail = (t.match(/[（(]([^）)]*)[）)]/) || [])[1] || '';
  let surface = null;
  if (/障害/.test(detail) || /障害/.test(t)) surface = '障';
  else if (/ダート/.test(detail)) surface = 'ダ';
  else if (/芝/.test(detail)) surface = '芝';
  const direction = /右/.test(detail) ? '右' : /左/.test(detail) ? '左' : /直線/.test(detail) ? '直' : null;
  const lane = /外→内|内→外/.test(detail) ? detail.match(/外→内|内→外/)[0] : /外/.test(detail) ? '外' : /内/.test(detail) ? '内' : '';
  return { distance, surface, direction, lane, detail };
}

/** レースの見出し（出馬表・結果・オッズで共通） */
export function parseHeader(root) {
  const head = root.querySelector('.race_header') || root;
  const dateText = clean(head.querySelector('.date_line .date')?.text || '');
  const dm = dateText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日.*?(\d+)回\s*(\S+?)\s*(\d+)日/);
  const timeText = clean(head.querySelector('.date_line .time')?.text || '');
  const tm = timeText.match(/(\d{1,2})時(\d{2})分/);
  const goings = {};
  let weather = null;
  for (const li of head.querySelectorAll('.baba li')) {
    const cap = clean(li.querySelector('.cap')?.text || '');
    const txt = clean(li.querySelector('.txt')?.text || '');
    if (!cap) continue;
    if (cap === '天候') weather = txt;
    else if (/芝/.test(cap)) goings['芝'] = txt;
    else if (/ダート/.test(cap)) goings['ダ'] = txt;
    else if (/障害/.test(cap)) goings['障'] = txt;
  }
  const raceNoAlt = head.querySelector('.race_number img')?.getAttribute('alt') || '';
  const nameEl = head.querySelector('.race_name');
  const gradeAlt = nameEl?.querySelector('.grade_icon img')?.getAttribute('alt') || clean(nameEl?.querySelector('.grade_icon')?.text || '');
  let name = '';
  if (nameEl) {
    const copy = parse(nameEl.toString());
    copy.querySelectorAll('.grade_icon').forEach((n) => n.remove());
    name = clean(copy.text);
  }
  const type = head.querySelector('.type');
  const category = clean(type?.querySelector('.category')?.text || '');
  const className = clean(type?.querySelector('.class')?.text || '');
  const rule = clean(type?.querySelector('.rule')?.text || '');
  const weightRule = clean(type?.querySelector('.weight')?.text || '');
  const course = parseCourse(type?.querySelector('.course')?.text || '');
  const surface = course.surface;
  return {
    date: dm ? `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}` : null,
    kai: dm ? Number(dm[4]) : null,
    course: dm ? dm[5] : null,
    day: dm ? Number(dm[6]) : null,
    startTime: tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : null,
    weather,
    goings,
    going: surface === '障' ? goings['障'] || goings['芝'] || null : goings[surface] || null,
    raceNo: toInt(raceNoAlt),
    name,
    gradeIcon: gradeAlt || '',
    grade: normalizeGrade(gradeAlt, className, name),
    category,
    className,
    rule,
    weightRule,
    ...course,
    jump: surface === '障' || /障害/.test(className + name),
  };
}

function parsePast(td) {
  if (!td || !td.querySelector('.date_line')) return null;
  const nameA = td.querySelector('.race_line .name a');
  const raceName = clean(td.querySelector('.race_line .name')?.text || '');
  const classEl = td.querySelector('.r_class .grade_icon');
  const classText = clean(classEl?.querySelector('img')?.getAttribute('alt') || classEl?.text || '');
  const placeText = clean(td.querySelector('.place_line .place')?.text || '');
  const distText = clean(td.querySelector('.dist')?.text || '');
  const dm = distText.match(/(\d{3,4})\s*(芝|ダ|障)/);
  const fin = td.querySelector('.fin');
  const marginText = clean(fin?.querySelector('.time')?.text || '');
  const winner = fin ? clean(fin.text.replace(marginText, '')) : '';
  const f3 = clean(td.querySelector('.f3')?.text || '');
  const resultKey = raceKeyFromCname(nameA?.getAttribute('href') || '');
  return {
    date: parseJpDate(td.querySelector('.date')?.text || ''),
    course: clean(td.querySelector('.rc')?.text || ''),
    raceName,
    grade: normalizeGrade(classText, raceName),
    raceId: resultKey?.raceId || null,
    finish: /^\d+/.test(placeText) ? toInt(placeText) : 0,
    status: /^\d+/.test(placeText) ? '' : placeText.replace(/着$/, ''),
    fieldSize: toInt(td.querySelector('.num .max')?.text || ''),
    number: toInt(td.querySelector('.num .gate')?.text || ''),
    popularity: toInt(td.querySelector('.num .pop')?.text || ''),
    jockey: clean(td.querySelector('.info_line1 .jockey')?.text || ''),
    weight: toFloat(td.querySelector('.info_line1 .weight')?.text || ''),
    distance: dm ? Number(dm[1]) : null,
    surface: dm ? dm[2] : null,
    time: parseRaceTime(td.querySelector('.info_line2 .time')?.text || ''),
    going: clean(td.querySelector('.condition')?.text || '') || null,
    bodyWeight: toInt(td.querySelector('.h_weight')?.text || ''),
    passing: td.querySelectorAll('.corner_list li').map((li) => toInt(li.text)).filter((v) => v > 0),
    last3f: /\d/.test(f3) ? toFloat(f3.replace(/^3F/, '')) : null,
    winner,
    margin: marginText ? toFloat(marginText) : null,
  };
}

const frameFromAlt = (td) => toInt(td?.querySelector('img')?.getAttribute('alt') || td?.text || '');

/** 出馬表（前4走・単勝オッズつき） */
export function parseRaceCard(html) {
  const root = parse(html);
  const header = parseHeader(root);
  const rows = root.querySelectorAll('#syutsuba table tbody tr');
  const entries = [];
  for (const tr of rows) {
    const horseTd = tr.querySelector('td.horse');
    if (!horseTd) continue;
    const nameA = horseTd.querySelector('.name a');
    const href = nameA?.getAttribute('href') || '';
    const hid = (href.match(/pw01dud\d0(\d{10})/) || [])[1] || null;
    const oddsText = clean(horseTd.querySelector('.odds .num')?.text || '');
    const popText = clean(horseTd.querySelector('.pop_rank')?.text || '');
    const jockeyTd = tr.querySelector('td.jockey');
    const ageText = clean(jockeyTd?.querySelector('.age')?.text || '');
    const am = ageText.match(/^(牡|牝|せん|騸|セ)(\d+)(?:\/(\S+))?/);
    const jockeyA = jockeyTd?.querySelector('.jockey a') || jockeyTd?.querySelector('.jockey');
    const rowText = clean(tr.text);
    const scratched = /取消|除外/.test(clean(horseTd.querySelector('.odds')?.text || '')) || /出走取消|競走除外/.test(rowText);
    const bw = clean(horseTd.querySelector('.h_weight')?.text || '');
    const bwm = bw.match(/(\d{3})\s*(?:\(([-+]?\d+)\))?/);
    const trainerP = horseTd.querySelector('.trainer');
    const mare = horseTd.querySelector('.family_line .mare');
    const damSire = clean(mare?.querySelector('.bloodmare')?.text || '')
      .replace(/^\(母の父[:：]\s*/, '')
      .replace(/\)$/, '');
    const damName = mare ? clean(mare.text.replace(mare.querySelector('.bloodmare')?.text || '', '')).replace(/^母[:：]\s*/, '') : '';
    entries.push({
      frame: frameFromAlt(tr.querySelector('td.waku')),
      number: toInt(tr.querySelector('td.num')?.childNodes?.[0]?.text ?? tr.querySelector('td.num')?.text),
      name: clean(nameA?.text || horseTd.querySelector('.name')?.text || ''),
      horseId: hid,
      odds: /\d/.test(oddsText) ? toFloat(oddsText) : null,
      popularity: /\d/.test(popText) ? toInt(popText) : null,
      record: clean(horseTd.querySelector('.result_line .result')?.text || ''),
      trainer: clean(trainerP?.querySelector('a')?.text || trainerP?.text || '').replace(/\(.*\)$/, '').trim(),
      trainerArea: clean(trainerP?.querySelector('.division')?.text || '').replace(/[()（）]/g, ''),
      owner: clean(horseTd.querySelector('.owner')?.text || ''),
      sire: clean(horseTd.querySelector('.family_line .sire')?.text || '').replace(/^父[:：]\s*/, ''),
      dam: damName,
      damSire,
      sex: am ? (am[1] === '騸' || am[1] === 'せん' ? 'セ' : am[1]) : '',
      age: am ? Number(am[2]) : null,
      coat: am?.[3] || '',
      weight: toFloat(jockeyTd?.querySelector('.weight')?.text || ''),
      jockey: clean(jockeyA?.text || ''),
      jockeyId: ((jockeyA?.getAttribute?.('onclick') || '').match(/pw04kmk00(\d+)/) || [])[1] || null,
      bodyWeight: bwm ? Number(bwm[1]) : null,
      bodyWeightDiff: bwm && bwm[2] != null ? Number(bwm[2]) : null,
      scratched,
      past: ['p1', 'p2', 'p3', 'p4'].map((p) => parsePast(tr.querySelector(`td.past.${p}`))).filter(Boolean),
    });
  }
  const oddsCname = cnameFrom(root.querySelector('#race_related_link .odds a')?.getAttribute('onclick'));
  return { ...header, entries, oddsCname };
}

/** レース結果（着順・タイム・通過順・上がり・払戻） */
export function parseRaceResult(html) {
  const root = parse(html);
  const header = parseHeader(root);
  const table = root.querySelector('#race_result table') || root.querySelector('table.basic.narrow-xy.striped');
  const rows = [];
  for (const tr of table ? table.querySelectorAll('tbody tr') : []) {
    const horseA = tr.querySelector('td.horse a');
    if (!tr.querySelector('td.horse')) continue;
    const placeText = clean(tr.querySelector('td.place')?.text || '');
    const ageText = clean(tr.querySelector('td.age')?.text || '');
    const am = ageText.match(/^(牡|牝|せん|騸|セ)(\d+)/);
    const bw = clean(tr.querySelector('td.h_weight')?.text || '');
    const bwm = bw.match(/(\d{3})\s*(?:\(([-+]?\d+)\))?/);
    const jockeyA = tr.querySelector('td.jockey a');
    rows.push({
      finish: /^\d+$/.test(placeText) ? Number(placeText) : 0,
      status: /^\d+$/.test(placeText) ? '' : placeText,
      frame: frameFromAlt(tr.querySelector('td.waku')),
      number: toInt(tr.querySelector('td.num')?.text),
      name: clean(horseA?.text || tr.querySelector('td.horse')?.text || ''),
      horseId: ((horseA?.getAttribute('href') || '').match(/pw01dud\d0(\d{10})/) || [])[1] || null,
      sex: am ? (am[1] === '騸' || am[1] === 'せん' ? 'セ' : am[1]) : '',
      age: am ? Number(am[2]) : null,
      weight: toFloat(tr.querySelector('td.weight')?.text || ''),
      jockey: clean(jockeyA?.text || tr.querySelector('td.jockey')?.text || ''),
      jockeyId: ((jockeyA?.getAttribute('onclick') || '').match(/pw04kmk00(\d+)/) || [])[1] || null,
      time: parseRaceTime(tr.querySelector('td.time')?.text || ''),
      marginText: clean(tr.querySelector('td.margin')?.text || ''),
      passing: tr.querySelectorAll('td.corner li').map((li) => toInt(li.text)).filter((v) => v > 0),
      last3f: toFloat(tr.querySelector('td.f_time')?.text || ''),
      bodyWeight: bwm ? Number(bwm[1]) : null,
      bodyWeightDiff: bwm && bwm[2] != null ? Number(bwm[2]) : null,
      trainer: clean(tr.querySelector('td.trainer a')?.text || tr.querySelector('td.trainer')?.text || ''),
      popularity: toInt(tr.querySelector('td.pop')?.text || ''),
    });
  }
  const payouts = {};
  const KEYS = { win: 'win', place: 'place', wakuren: 'bracket', wide: 'wide', umaren: 'quinella', umatan: 'exacta', trio: 'trio', tierce: 'trifecta' };
  for (const li of root.querySelectorAll('.refund_area li')) {
    const cls = (li.getAttribute('class') || '').split(/\s+/).find((c) => KEYS[c]);
    if (!cls) continue;
    const type = KEYS[cls];
    payouts[type] = payouts[type] || {};
    for (const line of li.querySelectorAll('.line')) {
      const numText = clean(line.querySelector('.num')?.text || '');
      const yen = toInt(line.querySelector('.yen')?.text || '');
      if (!numText || yen == null) continue;
      const nums = numText.split('-').map((v) => Number(v));
      let key;
      if (type === 'exacta' || type === 'trifecta') key = nums.join('>');
      else if (type === 'win' || type === 'place') key = String(nums[0]);
      else key = [...nums].sort((a, b) => a - b).join('-');
      payouts[type][key] = yen;
    }
  }
  const oddsCname = cnameFrom(root.querySelector('a[onclick*="pw151ou"]')?.getAttribute('onclick'));
  return { ...header, rows, payouts, oddsCname };
}

/** 単勝・複勝オッズ */
export function parseOdds(html) {
  const root = parse(html);
  const header = parseHeader(root);
  const odds = [];
  for (const tr of root.querySelectorAll('table.tanpuku tbody tr')) {
    const num = toInt(tr.querySelector('td.num')?.text);
    if (num == null) continue;
    const tan = clean(tr.querySelector('td.odds_tan')?.text || '');
    odds.push({
      number: num,
      name: clean(tr.querySelector('td.horse')?.text || ''),
      odds: /\d/.test(tan) ? toFloat(tan) : null,
      status: /\d/.test(tan) ? '' : tan,
      placeMin: toFloat(tr.querySelector('td.odds_fuku .min')?.text || ''),
      placeMax: toFloat(tr.querySelector('td.odds_fuku .max')?.text || ''),
    });
  }
  return { ...header, odds };
}

/** 開催一覧（出馬表の開催選択・結果の開催選択・月別の過去結果）→ 開催日のリスト */
export function parseMeetingLinks(html) {
  const out = [];
  const seen = new Set();
  for (const m of String(html).matchAll(/(pw01(?:drl00|srl10)\d{2}\d{4}\d{2}\d{2}\d{8}\/[0-9A-F]{2})/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const key = meetingKeyFromCname(m[1]);
    if (key) out.push({ ...key, cname: m[1], type: m[1].startsWith('pw01drl') ? 'card' : 'result' });
  }
  return out;
}

/** 開催のレース一覧 → 各レースの出馬表・結果・オッズの CNAME */
export function parseRaceLinks(html) {
  const races = new Map();
  const add = (cname, field) => {
    const key = raceKeyFromCname(cname);
    if (!key) return;
    const r = races.get(key.raceId) || { ...key };
    if (!r[field]) r[field] = cname;
    races.set(key.raceId, r);
  };
  for (const m of String(html).matchAll(/(pw01dde01\d{20}\/[0-9A-F]{2})/g)) add(m[1], 'cardCname');
  for (const m of String(html).matchAll(/(pw01sde10\d{20}\/[0-9A-F]{2})/g)) add(m[1], 'resultCname');
  for (const m of String(html).matchAll(/(pw151ou(?:S3|10)\d{20}Z\/[0-9A-F]{2})/g)) add(m[1], 'oddsCname');
  return [...races.values()].sort((a, b) => a.raceNo - b.raceNo);
}

/** 過去のレース結果（年月）ページの CNAME 用チェックサム表 */
export function parseMonthParams(html) {
  const out = {};
  for (const m of String(html).matchAll(/objParam\["(\d{4})"\]\s*=\s*"([0-9A-F]{2})"/g)) out[m[1]] = m[2];
  return out;
}

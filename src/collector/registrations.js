// 特別登録（来週の特別レースの登録馬）から、出馬表が出る前の「暫定のレース」を作る。
// 出馬表（枠順・騎手・単勝オッズ）は木曜〜金曜に出る。それまでは登録馬・負担重量・前4走で、
// オッズを使わない「AI単独」の予想を出す（model.js の predictRace がオッズのないレースを自動で切り替える）。
// 馬番・枠は未定なので、登録順（50音順）の仮の番号を付け、画面では番号を出さない。

import { parseRegistrationList, parseRegistration, registrationKeyFromCname } from './jra.js';
import { runFromRecord } from '../data/history.js';

const HOUR = 3600 * 1000;
export const REGISTRATION_LIST_CNAME = 'pw03trl00/29';
const MAX_PAST = 4;

/** 特別登録のレース一覧（軽い：1ページ） */
export async function listRegistrations(client, { ttlMs = 10 * 60 * 1000 } = {}) {
  return parseRegistrationList(await client.page(REGISTRATION_LIST_CNAME, { cache: 'ttl', ttlMs }));
}

/**
 * 特別登録の全レースを取ってくる。1レースにつき一覧表示1ページ＋馬柱1〜2ページ（20頭ごと）。
 * 登録内容は締切時点で固定なので、取り直しは ttlMs（既定 6時間）ごとでよい。
 * 返り値：[{ key, top, horses }]（top＝一覧表示、horses＝馬柱の全ページの馬）
 */
export async function fetchRegistrations(client, { ttlMs = 6 * HOUR, log = () => {}, list = null } = {}) {
  const items = list || (await listRegistrations(client, { ttlMs: Math.min(ttlMs, HOUR) }));
  const out = [];
  for (const item of items) {
    try {
      const top = parseRegistration(await client.page(item.cname, { cache: 'ttl', ttlMs }));
      const horses = [];
      const seen = new Set();
      const queue = top.umabashiraCnames.filter((c) => registrationKeyFromCname(c)?.raceId === item.raceId);
      while (queue.length) {
        const c = queue.shift();
        if (seen.has(c)) continue;
        seen.add(c);
        const page = parseRegistration(await client.page(c, { cache: 'ttl', ttlMs }));
        horses.push(...page.horses);
        for (const x of page.umabashiraCnames) if (!seen.has(x) && registrationKeyFromCname(x)?.raceId === item.raceId) queue.push(x);
      }
      out.push({ key: item, top, horses });
    } catch (e) {
      log(`特別登録の取得に失敗 ${item.raceId}: ${e.message}`);
    }
  }
  return out;
}

/**
 * 特別登録 → アプリのレース形式（status: 'registration'、provisional: true）。
 * 過去走は馬柱の前4走（地方も含む公式の直近4走）を土台に、収集済みの結果（recById：raceId → 記録）にあるレースは
 * そこから（タイム・通過順・上がり・馬場までそろう）。馬柱がないときは収集済みの結果（index）の直近4走。
 */
export function registrationToRace({ key, top, horses }, { index = null, recById = null } = {}) {
  const detail = new Map(horses.filter((h) => h.horseId).map((h) => [h.horseId, h]));
  const list = top.horses.length ? top.horses : horses;
  const entries = list.map((h0, k) => {
    const h = { ...h0, ...(detail.get(h0.horseId) || {}) };
    const hist = index && h.horseId ? (index.byHorse.get(h.horseId) || []).filter((x) => x.date < key.date).slice(0, MAX_PAST) : [];
    const upgrade = (p) => {
      const rec = p.raceId && recById?.get(p.raceId);
      const runner = rec?.runners.find((r) => r.horseId === h.horseId);
      return runner ? runFromRecord(rec, runner) : p;
    };
    const past = h.past?.length ? h.past.map(upgrade) : hist.map((x) => runFromRecord(x.rec, x.runner));
    // 性齢・厩舎が馬柱にないとき（地方・外国馬など）は、収集済みの直近の出走から
    const last = hist[0]?.runner;
    return {
      frame: null,
      number: k + 1,
      provisionalNumber: true,
      name: h.name,
      horseId: h.horseId,
      sex: h.sex || last?.sex || '',
      age: h.age ?? (last?.age != null ? last.age + (Number(key.date.slice(0, 4)) - Number(hist[0].date.slice(0, 4))) : null),
      coat: h.coat || '',
      weight: h.weight ?? h0.weight ?? null,
      jockey: '',
      jockeyId: null,
      trainer: h.trainer || last?.trainer || '',
      trainerArea: '',
      bodyWeight: null,
      bodyWeightDiff: null,
      odds: null,
      popularity: null,
      sire: '',
      damSire: '',
      record: '',
      scratched: false,
      past,
    };
  });
  return {
    id: key.raceId,
    source: 'JRA',
    provisional: true,
    status: 'registration',
    date: key.date,
    course: key.course,
    courseCode: key.courseCode,
    kai: key.kai,
    day: key.day,
    raceNo: key.raceNo,
    startTime: null,
    name: top.name || key.name,
    grade: top.grade || key.grade,
    className: top.className || key.className,
    gradeIcon: top.gradeIcon || key.gradeIcon || '',
    category: top.category,
    ageCond: top.category,
    rule: top.rule,
    weightRule: top.weightRule,
    surface: top.surface || key.surface,
    distance: top.distance || key.distance,
    direction: top.direction,
    lane: top.lane,
    going: null,
    weather: null,
    jump: !!top.jump,
    registered: top.registered ?? entries.length,
    maxRunners: top.maxRunners ?? null,
    entries,
  };
}

/**
 * バンドルに暫定のレースを入れる。出馬表のあるレース（同じ raceId）と、出馬表の出た開催日のレースには入れない
 * （出馬表が出たら暫定のレースは消える）。返り値は入れたレースの数。
 */
export function addProvisionalRaces(bundle, races, { upsert }) {
  const realDates = new Set(bundle.days.filter((d) => d.races.some((r) => !r.provisional)).map((d) => d.date));
  const known = new Set(bundle.days.flatMap((d) => d.races.filter((r) => !r.provisional).map((r) => r.id)));
  let n = 0;
  for (const race of races) {
    if (known.has(race.id) || realDates.has(race.date)) continue;
    upsert(bundle, race);
    n++;
  }
  return n;
}

/** バンドルから暫定のレースを外す（空になった開催日も外す）。外したレースを返す */
export function removeProvisionalRaces(bundle) {
  const removed = [];
  for (const d of bundle.days) {
    removed.push(...d.races.filter((r) => r.provisional));
    d.races = d.races.filter((r) => !r.provisional);
  }
  bundle.days = bundle.days.filter((d) => d.races.length);
  return removed;
}

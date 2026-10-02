// 架空の競馬データを生成する（サンプル開催・バックテスト用）
//
// 各馬に「本当の能力・適性・脚質」を持たせ、過去走は仮想の対戦相手とのレースとして
// シミュレーションして作る。予想エンジンはこの隠れた真実を知らず、馬柱だけから推理する。

import { createRng } from '../engine/rng.js';
import { COURSES, COURSE_NAMES, GOINGS, isOpenClass, nextClass, frameOf, drawBias, straightBias } from '../engine/constants.js';
import { baseTime, timeFromRawSpeed } from '../engine/speed.js';
import { paceFromEarly } from '../engine/factors.js';
import { harville, normalWinProbs } from '../engine/market.js';
import { simulate, comboProbs } from '../engine/simulate.js';
import { payoutKey } from '../engine/backtest.js';
import { scoreRace } from '../engine/model.js';
import { CALIBRATION } from '../engine/calibration.js';
import { addDays, argsortDesc, clamp, daysBetween, mean, round1 } from '../engine/util.js';
import * as NAMES from './names.js';

/** クラスごとの平均的な能力（スピード指数の水準） */
export const CLASS_MEAN = { 新馬: 63, 未勝利: 65, '1勝': 74, '2勝': 79, '3勝': 84, OP: 88, L: 89, G3: 91, G2: 94, G1: 98 };

const MARKET_NOISE = 3.2; // 過去走オッズ用の見立ての誤差
const SIGMA_MIN = 4.2; // 1走ごとのパフォーマンスのばらつき（指数）
const SIGMA_MAX = 7.5;
const PRIVATE_VAR = 16; // 市場だけが持つ情報（調教・パドックなど）の誤差の分散
const MARKET_TAU = 5.2; // 過去走オッズ用（ソフトマックスの温度）
const FLB_GAMMA = 0.88; // 人気薄が買われすぎる傾向（本命-大穴バイアス）
const GOING_MUL = { 良: 0, 稍重: 0.35, 重: 1, 不良: 1.4 };

export function createWorld(seed = 20261004) {
  const rng = createRng(seed);
  const jockeys = NAMES.JOCKEYS.map((name) => {
    const skill = clamp(rng.gauss(0.2, 1.1), -2, 3);
    const winRate = clamp(0.065 + 0.024 * skill + rng.gauss(0, 0.008), 0.015, 0.24);
    const top3Rate = clamp(winRate * 2.3 + 0.07 + rng.gauss(0, 0.015), 0.08, 0.55);
    return { name, skill, winRate: Math.round(winRate * 1000) / 1000, top3Rate: Math.round(top3Rate * 1000) / 1000 };
  });
  jockeys.sort((a, b) => b.skill - a.skill);
  const stats = Object.fromEntries(jockeys.map((j) => [j.name, { winRate: j.winRate, top3Rate: j.top3Rate }]));
  return { rng, jockeys, stats, jockeyMap: Object.fromEntries(jockeys.map((j) => [j.name, j])) };
}

/** 予想エンジンに渡す騎手成績 */
export function jockeyStats(world) {
  return world.stats;
}

/** 本命-大穴バイアスをかけて市場の勝率にする */
function withFlb(p) {
  const pg = p.map((v) => Math.pow(Math.max(v, 1e-9), FLB_GAMMA));
  const zg = pg.reduce((a, b) => a + b, 0);
  return pg.map((v) => v / zg);
}

/**
 * 当日の市場（オッズ）。
 * 市場は「馬柱などの公開情報」と「市場だけが持つ情報」をベイズ的に組み合わせて強さを見積もる。
 * 公開情報の部分は予想エンジンと同じ評価なので、AIの予想はすでにオッズに織り込まれている。
 */
function marketProbs(rng, race, exps, perfSigmas, jockeys) {
  const mm = CALIBRATION.marketModel || { k: 4.27, residVar: 11.2 };
  const scored = scoreRace(race, { sires: NAMES.SIRE_MAP, jockeys });
  const S = scored.rows.map((r) => r.score);
  const mS = mean(S);
  const mE = mean(exps);
  const precA = 1 / mm.residVar;
  const precP = 1 / PRIVATE_VAR;
  const wA = precA / (precA + precP);
  const m = exps.map((e, i) => wA * mm.k * (S[i] - mS) + (1 - wA) * (e - mE + rng.gauss(0, Math.sqrt(PRIVATE_VAR))));
  // 市場は各馬の安定度（1走ごとのばらつき）もおおよそ把握している
  const post = 1 / (precA + precP);
  const sigma = perfSigmas.map((s) => Math.sqrt(s * s + post));
  const base = normalWinProbs(m, sigma);
  return { q: withFlb(base), base, m, sigma };
}

/** 過去走のオッズ表示用の簡易版（ソフトマックス） */
function quickMarketProbs(strengths) {
  const max = Math.max(...strengths);
  const ex = strengths.map((s) => Math.exp((s - max) / MARKET_TAU));
  const z = ex.reduce((a, b) => a + b, 0);
  return withFlb(ex.map((v) => v / z));
}

/** 単勝オッズ（払戻率80%、0.1倍単位の切り捨て） */
const toOdds = (q) => clamp(Math.floor((0.8 / q) * 10) / 10, 1.1, 999.9);

function ranksAsc(values) {
  const idx = values.map((v, i) => i).sort((a, b) => values[a] - values[b] || a - b);
  const rank = new Array(values.length);
  idx.forEach((i, k) => {
    rank[i] = k + 1;
  });
  return rank;
}

function horseName(rng, used) {
  for (let t = 0; t < 60; t++) {
    const name = rng.chance(0.78)
      ? rng.pick(NAMES.HORSE_PREFIXES) + rng.pick(NAMES.HORSE_WORDS)
      : rng.pick(NAMES.HORSE_FIRST) + rng.pick(NAMES.HORSE_WORDS);
    const len = [...name].length;
    if (len < 3 || len > 9 || used.has(name)) continue;
    used.add(name);
    return name;
  }
  // 候補が尽きた場合の保険（通常は起きない）
  const name = `${rng.pick(NAMES.HORSE_PREFIXES)}${rng.pick(['ワン', 'ツー', 'スリー', 'フォー'])}`;
  used.add(name);
  return name;
}

function pickSire(rng, spec) {
  const w = NAMES.SIRES.map((s) => {
    const surf = spec.surface === '芝' ? Math.max(0, -s.turf) : Math.max(0, s.turf);
    const dist = ((spec.distance - s.dist) / 700) ** 2;
    return Math.exp(-(2.2 * surf + dist));
  });
  return rng.weighted(NAMES.SIRES, w);
}

function courseAff(world, h, course) {
  if (!(course in h.courseAff)) h.courseAff[course] = world.rng.gauss(0, 0.9);
  return h.courseAff[course];
}

/** 隠れた能力：条件（芝ダ・距離・馬場・コース・騎手・斤量）を反映した強さ */
function coreStrength(world, h, cond, runsAgo) {
  let s = h.ability - h.trend * runsAgo;
  s -= cond.surface === '芝' ? 8 * Math.max(0, -h.surf) : 8 * Math.max(0, h.surf);
  const dd = (cond.distance - h.dist) / h.tol;
  s -= Math.min(12, 3.2 * dd * dd);
  s += 3 * h.heavy * (GOING_MUL[cond.going] ?? 0);
  s += h.leftPref * (COURSES[cond.course]?.dir === '左' ? 1 : -1);
  s += courseAff(world, h, cond.course);
  s += cond.jockeySkill ?? 0;
  s -= 1.8 * ((cond.weight ?? 55) - 55);
  return s;
}

/** 展開と枠順の影響 */
function raceDayEffect(early, kick, number, n, paceZ, sb, db, lone) {
  let s = 4 * (early - 0.5) * -paceZ + 2 * (early - 0.5) * sb;
  if (paceZ > 0) s += 2 * paceZ * (kick - 0.5);
  if (sb < 0) s += 3 * -sb * (kick - 0.5); // 直線が長いと末脚の差が出る
  if (lone) s += 2;
  const inner = n > 1 ? 1 - (2 * (number - 1)) / (n - 1) : 0;
  s += 2.5 * db * inner * (0.6 + 0.8 * early) * (n <= 10 ? 0.6 : 1);
  return s;
}

/** 休み明け・連闘・叩き2戦目・体調 */
function conditionEffect(h, days, prevGap, bodyIssue) {
  let s = 0;
  if (days != null) {
    if (days > 120) s -= 0.5 + 2.5 * (1 - h.fresh);
    else if (days > 75) s -= 1.2 * (1 - h.fresh);
    else if (days <= 13) s -= 0.6;
    if (prevGap != null && prevGap > 90 && days <= 75) s += 0.8;
  }
  if (bodyIssue) s -= 2.5;
  return s;
}

function ageFor(rng, spec) {
  if (spec.ageCond === '2歳') return 2;
  if (spec.ageCond === '3歳') return 3;
  return rng.weighted([3, 4, 5, 6, 7, 8], [25, 30, 24, 12, 6, 3]);
}

function newHorse(world, spec, used) {
  const rng = world.rng;
  const age = ageFor(rng, spec);
  const sex = age === 2 ? (rng.chance(0.55) ? '牡' : '牝') : rng.weighted(['牡', '牝', 'セ'], [58, 36, 6]);
  const sire = pickSire(rng, spec);
  const dist = clamp(sire.dist + rng.gauss(0, 260), 1000, 3400);
  const early = clamp(rng.gauss(0.5 + (1500 - dist) / 2600, 0.22), 0.02, 0.98);
  const trendMu = { 2: 0.9, 3: 0.45, 4: 0.1, 5: -0.1, 6: -0.35, 7: -0.6, 8: -0.8 }[age] ?? 0;
  const young = spec.grade === '未勝利' || spec.grade === '新馬';
  let ability = rng.gauss(CLASS_MEAN[spec.grade] + (isOpenClass(spec.grade) ? 1 : 1.5), young ? 5 : 4);
  if (sex === '牝') ability -= age === 2 ? 1.5 : 3; // 斤量差の分
  return {
    name: horseName(rng, used),
    age,
    sex,
    sire,
    ability,
    trend: rng.gauss(trendMu, 0.4),
    sigma: rng.range(SIGMA_MIN, SIGMA_MAX),
    surf: clamp(sire.turf + rng.gauss(0, 0.35), -1, 1),
    dist,
    tol: rng.range(350, 700),
    heavy: clamp(sire.heavy + rng.gauss(0, 0.8), -1.5, 1.5),
    early,
    kick: clamp(rng.gauss(0.5 - 0.35 * (early - 0.5), 0.15), 0, 1),
    leftPref: rng.gauss(0, 0.7),
    courseAff: {},
    fresh: rng.next(),
    bodyBase: Math.round(rng.gauss(474, 22) - (sex === '牝' ? 14 : 0) - (age === 2 ? 12 : 0)),
    trainer: rng.pick(NAMES.TRAINERS),
  };
}

function carriedWeight(rng, h, grade, age) {
  let w;
  if (age <= 2) w = h.sex === '牝' ? 55 : 56;
  else if (age === 3) w = h.sex === '牝' ? 54 : 56;
  else w = h.sex === '牝' ? 56 : 58;
  if (['OP', 'L', 'G3', 'G2'].includes(grade) && rng.chance(0.3)) w += rng.pick([-2, -1, 1]);
  return w;
}

function pastJockey(world, h) {
  const n = world.jockeys.length;
  const rel = clamp((h.ability - 80) / 15, -1, 1);
  const center = (1 - (rel + 1) / 2) * (n - 1);
  const idx = clamp(Math.round(center + world.rng.gauss(0, n / 4)), 0, n - 1);
  return world.jockeys[idx];
}

function openLabel(rng, h) {
  const a = h.ability;
  const w = { OP: 3, L: 2, G3: a >= 90 ? 2 : 0.8, G2: a >= 93 ? 1.5 : 0.3, G1: a >= 97 ? 1.2 : 0.1 };
  return rng.weighted(Object.keys(w), Object.values(w));
}

function fieldSizeFor(rng, grade) {
  if (grade === 'G1') return rng.int(16, 18);
  if (grade === '新馬') return rng.int(8, 16);
  return rng.weighted([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18], [2, 2, 3, 4, 6, 7, 9, 10, 12, 4, 5]);
}

export function raceNameFor(rng, grade, ageCond) {
  if (grade === '新馬') return `${ageCond === '2歳' ? '2歳' : '3歳'}新馬`;
  if (grade === '未勝利') return `${ageCond === '2歳' ? '2歳' : '3歳'}未勝利`;
  if (grade === '1勝' || grade === '2勝') return rng.chance(0.4) ? `${rng.pick(NAMES.SPECIAL_WORDS)}特別` : `${ageCond}${grade}クラス`;
  if (grade === '3勝') return rng.chance(0.6) ? `${rng.pick(NAMES.SPECIAL_WORDS)}ステークス` : `${ageCond}3勝クラス`;
  if (grade === 'OP' || grade === 'L') return `${rng.pick(NAMES.STAKES_WORDS)}ステークス`;
  return `${rng.pick(NAMES.STAKES_WORDS)}${rng.pick(['賞', 'カップ', '記念'])}`;
}

function runConditions(world, h, spec, cls, date, runsAgo) {
  const rng = world.rng;
  const course = rng.chance(0.3) ? spec.course : rng.pick(COURSE_NAMES);
  let pTurf = 0.5 + 0.45 * h.surf;
  pTurf = spec.surface === '芝' ? 0.3 + 0.7 * pTurf : 0.7 * pTurf;
  const surface = rng.chance(pTurf) ? '芝' : 'ダ';
  const list = COURSES[course][surface === '芝' ? 'turf' : 'dirt'];
  const center = 0.5 * h.dist + 0.5 * spec.distance;
  const distance = rng.weighted(
    list,
    list.map((d) => Math.exp(-(((d - center) / 380) ** 2)) + 0.02),
  );
  const going = rng.weighted(GOINGS, [0.68, 0.17, 0.1, 0.05]);
  const grade = isOpenClass(cls) ? openLabel(rng, h) : cls;
  const fieldSize = fieldSizeFor(rng, grade);
  const ageThen = Math.max(2, h.age - (runsAgo >= 4 && h.age > 2 && rng.chance(0.3) ? 1 : 0));
  const ageCond = ageThen === 2 ? '2歳' : ageThen === 3 && rng.chance(0.5) ? '3歳' : '3歳以上';
  return { date, course, surface, distance, going, grade, fieldSize, number: rng.int(1, fieldSize), ageThen, ageCond };
}

/** 過去走1走を、仮想の対戦相手とのレースとしてシミュレーション */
function simulateRun(world, h, cond, runsAgo, gapDays, prevGap) {
  const rng = world.rng;
  const n = cond.fieldSize;
  const mu = CLASS_MEAN[cond.grade];
  const jockey = pastJockey(world, h);
  const weight = carriedWeight(rng, h, cond.grade, cond.ageThen);

  const opp = [];
  for (let i = 0; i < n - 1; i++) {
    opp.push({
      base: rng.gauss(mu, 5.5),
      early: clamp(rng.gauss(0.5, 0.25), 0.02, 0.98),
      kick: clamp(rng.gauss(0.5, 0.15), 0, 1),
      sigma: rng.range(SIGMA_MIN, SIGMA_MAX),
    });
  }
  const others = [];
  for (let k = 1; k <= n; k++) if (k !== cond.number) others.push(k);
  rng.shuffle(others);

  const earlies = [h.early, ...opp.map((o) => o.early)];
  const pace = paceFromEarly(earlies);
  const leaders = earlies.filter((e) => e > 0.8).length;
  const lone = (e) => leaders === 1 && e > 0.8 && pace.z < 0.2;
  const sb = straightBias(cond.course, cond.surface, cond.distance);
  const db = drawBias(cond.course, cond.surface, cond.distance);

  const expH =
    coreStrength(world, h, { ...cond, jockeySkill: jockey.skill, weight }, runsAgo) +
    raceDayEffect(h.early, h.kick, cond.number, n, pace.z, sb, db, lone(h.early)) +
    conditionEffect(h, gapDays, prevGap, false);
  const perfH = expH + rng.gauss(0, h.sigma);
  const oppExp = opp.map((o, i) => o.base + raceDayEffect(o.early, o.kick, others[i], n, pace.z, sb, db, lone(o.early)));
  const oppPerf = oppExp.map((e, i) => e + rng.gauss(0, opp[i].sigma));

  let finish = 1;
  for (const p of oppPerf) if (p > perfH) finish++;
  const sorted = [perfH, ...oppPerf].sort((a, b) => b - a);
  const base = baseTime(cond.surface, cond.distance, cond.going, cond.course);
  const tOf = (p) => round1(timeFromRawSpeed(p, base));
  const time = tOf(perfH);
  const margin = finish === 1 ? -round1(tOf(sorted[1]) - time) : round1(time - tOf(sorted[0]));

  // 通過順：序盤の位置取りから、ゴールの着順へ近づいていく
  const inner = (num) => (n > 1 ? 1 - (2 * (num - 1)) / (n - 1) : 0);
  const myEarly = h.early + rng.gauss(0, 0.1) + 0.03 * inner(cond.number);
  let c1 = 1;
  opp.forEach((o, i) => {
    if (o.early + rng.gauss(0, 0.1) + 0.03 * inner(others[i]) > myEarly) c1++;
  });
  const progress = cond.distance <= 1600 ? [0.15, 0.55] : [0, 0.12, 0.35, 0.6];
  const passing = progress.map((pr) => clamp(Math.round(c1 + (finish - c1) * pr + rng.gauss(0, 0.6)), 1, n));

  // 上がり3F
  const goingL3 = cond.surface === '芝' ? { 良: 0, 稍重: 0.3, 重: 0.8, 不良: 1.5 }[cond.going] : -0.2 * (GOING_MUL[cond.going] ?? 0);
  const base3f =
    (cond.surface === '芝' ? 34.6 : 37.2) +
    (cond.surface === 'ダ' && cond.distance >= 1700 ? 0.8 : 0) +
    (cond.surface === '芝' && cond.distance <= 1400 ? 0.3 : 0) +
    0.7 * pace.z +
    goingL3;
  const l3 = (perf, early, kick) => base3f - 0.045 * (perf - mu) - 0.9 * (kick - 0.5) + 0.7 * (early - 0.5) + rng.gauss(0, 0.25);
  const myL3 = round1(l3(perfH, h.early, h.kick));
  let l3rank = 1;
  opp.forEach((o, i) => {
    if (l3(oppPerf[i], o.early, o.kick) < myL3) l3rank++;
  });

  // その時のオッズ
  const q = quickMarketProbs([expH + rng.gauss(0, MARKET_NOISE), ...oppExp.map((e) => e + rng.gauss(0, MARKET_NOISE))]);
  let popularity = 1;
  for (let i = 1; i < q.length; i++) if (q[i] > q[0]) popularity++;

  return {
    date: cond.date,
    course: cond.course,
    raceName: raceNameFor(rng, cond.grade, cond.ageCond),
    grade: cond.grade,
    surface: cond.surface,
    distance: cond.distance,
    going: cond.going,
    fieldSize: n,
    number: cond.number,
    finish,
    time,
    margin,
    last3f: myL3,
    last3fRank: l3rank,
    passing,
    weight,
    jockey: jockey.name,
    bodyWeight: Math.round(h.bodyBase + rng.gauss(0, 3) - (h.age === 2 ? runsAgo * 2 : 0)),
    odds: toOdds(q[0]),
    popularity,
  };
}

function careerRuns(rng, h, spec) {
  if (spec.grade === '新馬') return 0;
  if (h.age === 2) return rng.int(1, 4);
  if (h.age === 3 && (spec.grade === '未勝利' || spec.grade === '1勝')) return rng.int(3, 5);
  return 5;
}

function startClass(rng, spec, h, nRuns) {
  const g = spec.grade;
  if (h.age === 2 || g === '未勝利' || (h.age === 3 && nRuns < 5)) return '新馬';
  if (g === '1勝') return rng.chance(0.55) ? '1勝' : '未勝利';
  if (g === '2勝') return rng.chance(0.55) ? '2勝' : '1勝';
  if (g === '3勝') return rng.chance(0.55) ? '3勝' : '2勝';
  return rng.chance(0.75) ? 'OP' : '3勝';
}

function classMatches(final, target) {
  if (isOpenClass(target)) return isOpenClass(final);
  return final === target;
}

/** 馬柱（過去走）を作る。勝ち上がりで今回のクラスに合わなければ作り直す */
function buildHistory(world, h, spec) {
  const rng = world.rng;
  const nRuns = careerRuns(rng, h, spec);
  if (!nRuns) return { ok: true, past: [] };
  const dates = [];
  let date = spec.date;
  for (let k = 0; k < nRuns; k++) {
    const r = rng.next();
    let gap;
    if (r < 0.06) gap = rng.int(7, 13);
    else if (r < 0.8) gap = rng.int(3, 8) * 7;
    else if (r < 0.92) gap = rng.int(9, 16) * 7;
    else gap = rng.int(17, 40) * 7;
    date = addDays(date, -gap);
    dates.push(date);
  }
  dates.reverse();
  let cls = startClass(rng, spec, h, nRuns);
  const runs = [];
  for (let k = 0; k < nRuns; k++) {
    const runsAgo = nRuns - k;
    const cond = runConditions(world, h, spec, cls, dates[k], runsAgo);
    const gap = k > 0 ? daysBetween(dates[k - 1], dates[k]) : null;
    const prevGap = k > 1 ? daysBetween(dates[k - 2], dates[k - 1]) : null;
    const run = simulateRun(world, h, cond, runsAgo, gap, prevGap);
    runs.push(run);
    if (run.finish === 1 && !isOpenClass(cls)) cls = nextClass(cls);
    else if (cls === '新馬') cls = '未勝利';
  }
  return { ok: classMatches(cls, spec.grade), past: runs.reverse() };
}

function suitability(h, spec) {
  const surf = spec.surface === '芝' ? 8 * Math.max(0, -h.surf) : 8 * Math.max(0, h.surf);
  const dd = (spec.distance - h.dist) / h.tol;
  return surf + Math.min(12, 3.2 * dd * dd);
}

function makeHorse(world, spec, used) {
  let h = null;
  for (let attempt = 0; attempt < 14; attempt++) {
    const cand = newHorse(world, spec, used);
    // 条件の合わない馬はあまり出走してこない
    if (attempt < 10 && !world.rng.chance(Math.exp(-suitability(cand, spec) / 3))) {
      used.delete(cand.name);
      continue;
    }
    const hist = buildHistory(world, cand, spec);
    cand.past = hist.past;
    h = cand;
    if (hist.ok) break;
    used.delete(cand.name);
  }
  if (!used.has(h.name)) used.add(h.name);
  return h;
}

function assignTodayJockeys(world, horses) {
  const rng = world.rng;
  const used = new Set();
  const order = horses.map((h, i) => ({ i, key: h.ability + rng.gauss(0, 3) })).sort((a, b) => b.key - a.key);
  for (const { i } of order) {
    const h = horses[i];
    const last = h.past[0]?.jockey;
    let j = null;
    if (last && !used.has(last) && rng.chance(0.6)) j = world.jockeyMap[last];
    if (!j) {
      const avail = world.jockeys.filter((x) => !used.has(x.name));
      j = avail[Math.min(avail.length - 1, Math.floor(Math.abs(rng.gauss(0, 5))))];
    }
    used.add(j.name);
    h.jockey = j.name;
    h.jockeySkill = j.skill;
  }
}

/**
 * 払戻。単勝はオッズどおり、それ以外は「市場の見立て（同じ正規モデル）」での的中確率から作る。
 * アプリの推定オッズ（割引ハーヴィル式）とは計算方法が違うので、推定と実際のズレも再現される。
 */
function makePayouts(rng, horses, mk, odds, order) {
  const n = horses.length;
  const sims = 4000;
  const sim = simulate(mk.m, mk.sigma, { sims, seed: Math.floor(rng.next() * 2 ** 31) });
  const cmb = comboProbs(sim);
  const H = harville(mk.base, 0.81, 0.65); // 出現の少ない組み合わせの補助
  const est = (mc, h) => (mc * sims >= 3 ? mc : h);
  const num = (i) => horses[i].number;
  const pay = (p, rate) => Math.max(100, Math.floor(((100 * rate) / Math.max(p, 1e-6)) * Math.exp(rng.gauss(0, 0.12)) / 10) * 10);
  const out = { win: {}, place: {}, quinella: {}, wide: {}, exacta: {}, trio: {}, trifecta: {} };
  const [a, b, c] = order;
  out.win[num(a)] = Math.round(odds[a] * 100);
  const pc = n >= 8 ? 3 : n >= 5 ? 2 : 0;
  for (const i of order.slice(0, pc)) out.place[num(i)] = pay(pc === 3 ? sim.top3[i] : sim.top2[i], 0.8);
  if (n >= 2) {
    const k = Math.min(a, b) * n + Math.max(a, b);
    out.quinella[payoutKey('quinella', [num(a), num(b)])] = pay(est(cmb.quinella[k], H.quinella[k]), 0.775);
    out.exacta[payoutKey('exacta', [num(a), num(b)])] = pay(est(cmb.exacta[a * n + b], H.exacta[a * n + b]), 0.75);
  }
  if (n >= 3) {
    if (n >= 8) {
      for (const [x, y] of [
        [a, b],
        [a, c],
        [b, c],
      ]) {
        const k = Math.min(x, y) * n + Math.max(x, y);
        out.wide[payoutKey('wide', [num(x), num(y)])] = pay(est(cmb.wide[k], H.wide[k]), 0.775);
      }
    }
    const [x, y, z] = [a, b, c].sort((u, v) => u - v);
    const kt = (x * n + y) * n + z;
    out.trio[payoutKey('trio', [num(a), num(b), num(c)])] = pay(est(cmb.trio[kt], H.trio[kt]), 0.75);
    const kf = (a * n + b) * n + c;
    out.trifecta[payoutKey('trifecta', [num(a), num(b), num(c)])] = pay(est(cmb.trifecta[kf], H.trifecta[kf]), 0.725);
  }
  return out;
}

/** 出馬表（必要なら結果と払戻も）を生成 */
export function generateRace(world, spec, { withResult = false, used = new Set(), debugTruth = false } = {}) {
  const rng = world.rng;
  const horses = [];
  for (let i = 0; i < spec.fieldSize; i++) horses.push(makeHorse(world, spec, used));
  assignTodayJockeys(world, horses);
  rng.shuffle(horses);
  const n = horses.length;
  horses.forEach((h, k) => {
    h.number = k + 1;
    h.frame = frameOf(k + 1, n);
    h.weight = carriedWeight(rng, h, spec.grade, h.age);
    const last = h.past[0];
    h.days = last ? daysBetween(last.date, spec.date) : null;
    h.prevGap = h.past[1] ? daysBetween(h.past[1].date, last.date) : null;
    const big = rng.chance(0.08);
    const diff = big ? (rng.chance(0.5) ? 1 : -1) * rng.int(10, 18) : Math.round(rng.gauss(0, 4));
    h.bodyIssue = big && rng.chance(0.5);
    h.bodyWeight = (last?.bodyWeight ?? h.bodyBase) + (last ? diff : 0);
    h.bodyWeightDiff = last ? diff : null;
  });

  const earlies = horses.map((h) => h.early);
  const pace = paceFromEarly(earlies);
  const leaders = earlies.filter((e) => e > 0.8).length;
  const sb = straightBias(spec.course, spec.surface, spec.distance);
  const db = drawBias(spec.course, spec.surface, spec.distance);
  for (const h of horses) {
    h.exp =
      coreStrength(world, h, { ...spec, jockeySkill: h.jockeySkill, weight: h.weight }, 0) +
      raceDayEffect(h.early, h.kick, h.number, n, pace.z, sb, db, leaders === 1 && h.early > 0.8 && pace.z < 0.2) +
      conditionEffect(h, h.days, h.prevGap, h.bodyIssue);
  }
  const race = {
    id: spec.id,
    date: spec.date,
    course: spec.course,
    raceNo: spec.raceNo,
    name: spec.name,
    grade: spec.grade,
    surface: spec.surface,
    distance: spec.distance,
    going: spec.going,
    weather: spec.weather || '晴',
    ageCond: spec.ageCond,
    startTime: spec.startTime || '',
    sample: true,
    entries: horses.map((h) => ({
      frame: h.frame,
      number: h.number,
      name: h.name,
      sex: h.sex,
      age: h.age,
      weight: h.weight,
      jockey: h.jockey,
      trainer: h.trainer,
      bodyWeight: h.bodyWeight,
      bodyWeightDiff: h.bodyWeightDiff,
      odds: null,
      popularity: null,
      sire: h.sire.name,
      past: h.past,
    })),
  };
  const mk = marketProbs(
    rng,
    race,
    horses.map((h) => h.exp),
    horses.map((h) => h.sigma),
    world.stats,
  );
  const odds = mk.q.map(toOdds);
  const popularity = ranksAsc(odds);
  race.entries.forEach((e, i) => {
    e.odds = odds[i];
    e.popularity = popularity[i];
  });
  if (debugTruth) {
    race.entries.forEach((e, i) => Object.assign(e, { _exp: horses[i].exp, _ability: horses[i].ability, _sigma: horses[i].sigma, _base: mk.base[i] }));
    race._market = { m: mk.m, sigma: mk.sigma };
  }
  if (withResult) {
    const perf = horses.map((h) => h.exp + rng.gauss(0, h.sigma));
    const order = argsortDesc(perf);
    race.result = order.map((i) => horses[i].number);
    race.payouts = makePayouts(rng, horses, mk, odds, order);
  }
  return race;
}

// ---------------------------------------------------------------------------
// サンプル開催日（2026年10月4日 東京・京都）

export const SAMPLE_DATE = '2026-10-04';

const DAY_SPECS = [
  { course: '東京', raceNo: 1, startTime: '09:55', name: '2歳未勝利', grade: '未勝利', ageCond: '2歳', surface: 'ダ', distance: 1400, fieldSize: 16 },
  { course: '東京', raceNo: 2, startTime: '10:25', name: '2歳未勝利', grade: '未勝利', ageCond: '2歳', surface: '芝', distance: 1600, fieldSize: 18 },
  { course: '東京', raceNo: 3, startTime: '10:55', name: '2歳新馬', grade: '新馬', ageCond: '2歳', surface: '芝', distance: 1800, fieldSize: 12 },
  { course: '東京', raceNo: 4, startTime: '11:25', name: '3歳以上1勝クラス', grade: '1勝', ageCond: '3歳以上', surface: 'ダ', distance: 1600, fieldSize: 16 },
  { course: '東京', raceNo: 5, startTime: '12:15', name: '3歳以上1勝クラス', grade: '1勝', ageCond: '3歳以上', surface: '芝', distance: 2000, fieldSize: 14 },
  { course: '東京', raceNo: 6, startTime: '12:45', name: '3歳以上1勝クラス', grade: '1勝', ageCond: '3歳以上', surface: 'ダ', distance: 1300, fieldSize: 16 },
  { course: '東京', raceNo: 7, startTime: '13:15', name: '3歳以上2勝クラス', grade: '2勝', ageCond: '3歳以上', surface: '芝', distance: 1400, fieldSize: 16 },
  { course: '東京', raceNo: 8, startTime: '13:45', name: '3歳以上2勝クラス', grade: '2勝', ageCond: '3歳以上', surface: 'ダ', distance: 2100, fieldSize: 15 },
  { course: '東京', raceNo: 9, startTime: '14:20', name: '星屑特別', grade: '2勝', ageCond: '3歳以上', surface: '芝', distance: 1800, fieldSize: 12 },
  { course: '東京', raceNo: 10, startTime: '15:00', name: '秋雲ステークス', grade: '3勝', ageCond: '3歳以上', surface: 'ダ', distance: 1600, fieldSize: 16 },
  { course: '東京', raceNo: 11, startTime: '15:45', name: 'KEIB記念', grade: 'G2', ageCond: '3歳以上', surface: '芝', distance: 1800, fieldSize: 15 },
  { course: '東京', raceNo: 12, startTime: '16:25', name: '3歳以上2勝クラス', grade: '2勝', ageCond: '3歳以上', surface: 'ダ', distance: 1400, fieldSize: 16 },
  { course: '京都', raceNo: 1, startTime: '09:50', name: '2歳未勝利', grade: '未勝利', ageCond: '2歳', surface: 'ダ', distance: 1200, fieldSize: 16 },
  { course: '京都', raceNo: 2, startTime: '10:20', name: '2歳未勝利', grade: '未勝利', ageCond: '2歳', surface: '芝', distance: 1400, fieldSize: 16 },
  { course: '京都', raceNo: 3, startTime: '10:50', name: '3歳以上1勝クラス', grade: '1勝', ageCond: '3歳以上', surface: 'ダ', distance: 1800, fieldSize: 15 },
  { course: '京都', raceNo: 4, startTime: '11:20', name: '3歳以上1勝クラス', grade: '1勝', ageCond: '3歳以上', surface: '芝', distance: 1200, fieldSize: 16 },
  { course: '京都', raceNo: 5, startTime: '12:10', name: '3歳以上1勝クラス', grade: '1勝', ageCond: '3歳以上', surface: '芝', distance: 2200, fieldSize: 13 },
  { course: '京都', raceNo: 6, startTime: '12:40', name: '3歳以上1勝クラス', grade: '1勝', ageCond: '3歳以上', surface: 'ダ', distance: 1400, fieldSize: 16 },
  { course: '京都', raceNo: 7, startTime: '13:10', name: '3歳以上2勝クラス', grade: '2勝', ageCond: '3歳以上', surface: 'ダ', distance: 1900, fieldSize: 14 },
  { course: '京都', raceNo: 8, startTime: '13:40', name: '3歳以上2勝クラス', grade: '2勝', ageCond: '3歳以上', surface: '芝', distance: 1600, fieldSize: 16 },
  { course: '京都', raceNo: 9, startTime: '14:15', name: '月影特別', grade: '2勝', ageCond: '3歳以上', surface: '芝', distance: 2000, fieldSize: 12 },
  { course: '京都', raceNo: 10, startTime: '14:50', name: '翠嵐ステークス', grade: '3勝', ageCond: '3歳以上', surface: '芝', distance: 1400, fieldSize: 16 },
  { course: '京都', raceNo: 11, startTime: '15:35', name: 'KEIBダートカップ', grade: 'G3', ageCond: '3歳以上', surface: 'ダ', distance: 1800, fieldSize: 16 },
  { course: '京都', raceNo: 12, startTime: '16:15', name: '3歳以上2勝クラス', grade: '2勝', ageCond: '3歳以上', surface: 'ダ', distance: 1200, fieldSize: 16 },
];

const DAY_GOING = { 東京: { 芝: '良', ダ: '稍重', weather: '曇' }, 京都: { 芝: '良', ダ: '良', weather: '晴' } };

/** サンプル開催日（24レース） */
export function generateRaceDay(seed = 20261004) {
  const world = createWorld(seed);
  const used = new Set();
  const jockeys = jockeyStats(world);
  const races = DAY_SPECS.map((s) => {
    const spec = {
      ...s,
      id: `${COURSES[s.course].code.toLowerCase()}${s.raceNo}`,
      date: SAMPLE_DATE,
      going: DAY_GOING[s.course][s.surface],
      weather: DAY_GOING[s.course].weather,
    };
    const race = generateRace(world, spec, { used });
    race.jockeys = jockeys;
    return race;
  });
  return { date: SAMPLE_DATE, venues: ['東京', '京都'], races, jockeys };
}

/**
 * バックテスト用の過去レースを1つずつ作るストリーム（UIで少しずつ生成するため）。
 * 同じ seed なら generateBacktestRaces と同じレースが同じ順番で出てくる。
 */
export function backtestRaceStream(seed = 777, { debugTruth = false } = {}) {
  const world = createWorld(seed);
  const rng = world.rng;
  const jockeys = jockeyStats(world);
  let k = 0;
  return {
    next() {
      const course = rng.pick(COURSE_NAMES);
      const surface = rng.chance(0.52) ? '芝' : 'ダ';
      const distance = rng.pick(COURSES[course][surface === '芝' ? 'turf' : 'dirt']);
      const grade = rng.weighted(['新馬', '未勝利', '1勝', '2勝', '3勝', 'OP', 'L', 'G3', 'G2', 'G1'], [3, 20, 30, 20, 11, 6, 3, 4, 2, 1]);
      const ageCond = grade === '新馬' ? '2歳' : grade === '未勝利' ? (rng.chance(0.6) ? '2歳' : '3歳') : '3歳以上';
      const spec = {
        id: `bt${k + 1}`,
        date: addDays('2025-10-04', Math.floor(k / 24) * 7 + (k % 2)),
        course,
        raceNo: (k % 12) + 1,
        name: raceNameFor(rng, grade, ageCond),
        grade,
        surface,
        distance,
        going: rng.weighted(GOINGS, [0.68, 0.17, 0.1, 0.05]),
        weather: '晴',
        ageCond,
        fieldSize: fieldSizeFor(rng, grade),
      };
      const race = generateRace(world, spec, { withResult: true, used: new Set(), debugTruth });
      race.jockeys = jockeys;
      k++;
      return race;
    },
  };
}

/** バックテスト用の過去レース（結果・払戻つき） */
export function generateBacktestRaces(count = 300, seed = 777, opts = {}) {
  const stream = backtestRaceStream(seed, opts);
  return Array.from({ length: count }, () => stream.next());
}

// スピード指数（走破タイムを基準タイムと比べて数値化）
//
//   指数 = 80 + 1000 × (基準タイム − 走破タイム) ÷ 基準タイム + 2 × (斤量 − 55)
//
// 80 が条件戦の平均的な水準。1600mなら0.1秒 ≒ 1ポイント、重賞の勝ち馬は100前後になる。

import { COURSES } from './constants.js';

// 良馬場・平均的なコースでの基準タイム: a × (距離/1200)^b
const BASE = {
  芝: { a: 69.0, b: 1.0765 },
  ダ: { a: 71.8, b: 1.1076 },
};

// 馬場状態の補正（1000mあたりの秒）。芝は渋ると時計がかかり、ダートは脚抜きが良くなって速くなる。
const GOING_ADJ = {
  芝: { 良: 0, 稍重: 0.4, 重: 1.0, 不良: 1.8 },
  ダ: { 良: 0, 稍重: -0.25, 重: -0.5, 不良: -0.6 },
};

export function baseTime(surface, distance, going = '良', course = null) {
  const p = BASE[surface] || BASE['芝'];
  const k = distance / 1000;
  let t = p.a * Math.pow(distance / 1200, p.b);
  t += (GOING_ADJ[surface]?.[going] ?? 0) * k;
  if (course && COURSES[course]) t += COURSES[course].offset * k;
  return t;
}

/** 過去走1走分のスピード指数。タイムがなければ null */
export function speedFigure(run) {
  if (!run || !(run.time > 0) || !(run.distance > 0)) return null;
  const base = baseTime(run.surface, run.distance, run.going, run.course);
  const weight = run.weight > 0 ? run.weight : 55;
  return 80 + (1000 * (base - run.time)) / base + 2 * (weight - 55);
}

/** 斤量補正前の指数からタイムを逆算（シミュレーション用） */
export function timeFromRawSpeed(rawSpeed, base) {
  return base * (1 - (rawSpeed - 80) / 1000);
}

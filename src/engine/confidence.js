// 自信度：◎（勝率が最も高い馬）が勝つ確率と、複勝圏（8頭以上は3着内、5〜7頭は2着内）に来る確率を、
// 学習期間の分割外の予測で校正したモデル（src/engine/confidenceModel.js、scripts/fit-confidence.mjs が作る）で出し、
// 校正した「◎が勝つ確率」で S/A/B/C に分ける。モデルがなければ従来の決め方（◎の勝率と2番手との差）。

import { CONFIDENCE_MODEL } from './confidenceModel.js';
import { FEATURE_INDEX } from './features.js';

const logit = (p) => Math.log(Math.max(p, 1e-4) / Math.max(1 - p, 1e-4));
const sigmoid = (u) => 1 / (1 + Math.exp(-u));

/** 校正モデルの入力に使えるレースの値（confidenceInputs が作る） */
export const CONF_INPUT_NAMES = ['lp', 'lp3', 'lq', 'fav', 'gap', 'logN', 'exo', 'lq2', 'even'];

/**
 * レースの行（pWin・pTop2・pTop3・marketProb・entry.number・features）から、◎ と校正モデルの入力。
 * ◎ は assignMarks と同じく勝率の高い順（同率なら行の順）の先頭。placeCount は複勝の対象（3/2/0）
 */
export function confidenceInputs(rows, placeCount) {
  const n = rows.length;
  const byP = [...rows].sort((a, b) => b.pWin - a.pWin);
  const h = byP[0];
  const second = byP[1]?.pWin ?? 0;
  const qSum = rows.reduce((a, r) => a + (r.marketProb || 0), 0) || 1;
  const fav = [...rows].sort((a, b) => (b.marketProb || 0) - (a.marketProb || 0) || (a.entry?.number ?? 0) - (b.entry?.number ?? 0))[0];
  const pPlace = placeCount === 2 ? h.pTop2 : placeCount === 3 ? h.pTop3 : null;
  const fx = (r, k) => (r.features && FEATURE_INDEX[k] != null ? r.features[FEATURE_INDEX[k]] : 0);
  const exo = fx(h, 'exoticKnown') > 0.5 ? 1 : 0;
  // 馬連の市場から見た ◎ の強さ（別の投票市場がそろっているときだけ。なければ単勝の市場の値）
  let q2 = (h.marketProb || 0) / qSum;
  if (exo) {
    const s = rows.map((r) => Math.exp(fx(r, 'q2Log')));
    const z = s.reduce((a, v) => a + v, 0) || 1;
    q2 = Math.exp(fx(h, 'q2Log')) / z;
  }
  const ent = -rows.reduce((a, r) => a + (r.pWin > 0 ? r.pWin * Math.log(r.pWin) : 0), 0);
  const x = {
    lp: logit(h.pWin),
    lp3: logit(pPlace ?? h.pTop3 ?? h.pWin),
    lq: logit((h.marketProb || 0) / qSum),
    fav: fav === h ? 1 : 0,
    gap: h.pWin - second,
    logN: Math.log(Math.max(n, 2)),
    exo,
    lq2: logit(q2),
    even: n > 1 ? ent / Math.log(n) : 0,
  };
  return { honmei: h, x, pWin: h.pWin, pPlace };
}

/** ロジスティックの校正モデル { inputs, mu, sd, coef } を当てる。raw なら入力の確率をそのまま */
export function applyCalib(spec, x, raw) {
  if (!spec || spec.raw) return raw;
  let u = spec.coef[0];
  spec.inputs.forEach((k, j) => {
    u += spec.coef[j + 1] * Math.max(-5, Math.min(5, (x[k] - spec.mu[j]) / spec.sd[j]));
  });
  return sigmoid(u);
}

/** 従来の決め方（◎の勝率と2番手との差） */
export function legacyGrade(top, second) {
  if (top >= 0.42) return 'S';
  if (top >= 0.3 && top - second >= 0.08) return 'A';
  if (top >= 0.2) return 'B';
  return 'C';
}

/** 校正した ◎ の勝つ確率から S/A/B/C（cuts = [S の下限, A の下限, B の下限]） */
export function gradeOf(p, cuts) {
  if (p >= cuts[0]) return 'S';
  if (p >= cuts[1]) return 'A';
  if (p >= cuts[2]) return 'B';
  return 'C';
}

/**
 * レースの自信度。{ grade, winProb（◎が勝つ確率・校正後）, placeProb（複勝圏・校正後。複勝がなければ null）, calibrated }
 *   ml … 機械学習の予想か（校正モデルは機械学習の予想で作ったので、ほかの重み付けでは確率をそのまま使い、区切りだけ同じにする）
 */
export function honmeiConfidence(rows, { placeCount = 3, ml = true, model = CONFIDENCE_MODEL } = {}) {
  if (!rows.length) return { grade: 'C', winProb: 0, placeProb: null, calibrated: false };
  const { x, pWin, pPlace } = confidenceInputs(rows, placeCount);
  const second = [...rows].sort((a, b) => b.pWin - a.pWin)[1]?.pWin ?? 0;
  if (!model) return { grade: legacyGrade(pWin, second), winProb: pWin, placeProb: pPlace, calibrated: false };
  const useCalib = ml && !model.legacy;
  const winProb = useCalib ? applyCalib(model.win, x, pWin) : pWin;
  const placeProb = pPlace == null ? null : useCalib ? applyCalib(model.place, x, pPlace) : pPlace;
  return { grade: model.legacy ? legacyGrade(pWin, second) : gradeOf(winProb, model.cuts), winProb, placeProb, calibrated: useCalib };
}

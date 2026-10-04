// 勾配ブースティング（決定木の集まり）でレースの各馬のスコアを出す。学習は scripts/train-gbdt.mjs。
// スコア = 市場（単勝オッズの対数確率）＋ 木の合計。1着の確率はレース内のソフトマックス（simulatePL と同じ形）。

import { GBDT_MODEL } from './gbdtModel.js';
import { GBDT_MODEL as GBDT_MODEL_AI } from './gbdtModelAi.js';
import { raceFeatures, FEATURE_NAMES } from './features.js';

const ready = (m) => !!(m?.trees?.length && m.names?.length === FEATURE_NAMES.length && m.names.every((k, i) => k === FEATURE_NAMES[i]));
export const GBDT_READY = ready(GBDT_MODEL);
export const GBDT_INFO = GBDT_MODEL ? { trainedOn: GBDT_MODEL.trainedOn, test: GBDT_MODEL.test, params: GBDT_MODEL.params } : null;
// オッズを使わない機械学習（単勝オッズの発売前の予想。市場・別の投票市場・血統・馬体重の特徴量を使わず、一様な出発点から学ぶ）
export const GBDT_AI_READY = ready(GBDT_MODEL_AI);
export const GBDT_AI_INFO = GBDT_MODEL_AI ? { trainedOn: GBDT_MODEL_AI.trainedOn, test: GBDT_MODEL_AI.test, params: GBDT_MODEL_AI.params } : null;

const iLogq = FEATURE_NAMES.indexOf(GBDT_MODEL?.base && GBDT_MODEL.base !== 'none' ? GBDT_MODEL.base : 'logq');

/** 出発点：倍率つきの log(市場確率) に、市場確率の帯ごとの補正（学習時に推定）を足す */
export function baseOf(logq, model = GBDT_MODEL) {
  if (!model.base || model.base === 'none') return 0;
  let v = (model.baseScale || 1) * logq;
  const c = model.calib;
  if (c?.edges && c.logRatio) {
    const q = Math.exp(logq);
    let k = 0;
    while (k < c.edges.length - 2 && q >= c.edges[k + 1]) k++;
    v += c.logRatio[k] || 0;
  }
  return v;
}

/** 木の合計（市場の分は含まない） */
export function treeSum(x, model = GBDT_MODEL) {
  let s = 0;
  for (const tree of model.trees) {
    let k = 0;
    for (;;) {
      const nd = tree[k];
      if (nd.length === 1) {
        s += nd[0];
        break;
      }
      k = x[nd[0]] <= nd[1] ? nd[2] : nd[3];
    }
  }
  return s;
}

/**
 * レースの各馬のスコア（対数スケール）。rows は raceFeatures の行。
 * opts.ai … オッズを使わない機械学習（gbdtModelAi.js）で出す（単勝オッズの発売前）
 */
export function gbdtScores(race, opts = {}) {
  const model = opts.ai ? GBDT_MODEL_AI : GBDT_MODEL;
  const fx = raceFeatures(race, opts);
  const rows = fx.rows.map((r) => {
    const adj = treeSum(r.x, model);
    return { ...r, adj, score: baseOf(r.x[iLogq], model) + adj };
  });
  return { rows, pace: fx.pace, temps: model.temps || [1, 1, 1] };
}

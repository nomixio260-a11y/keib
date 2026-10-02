// 勾配ブースティング（決定木の集まり）でレースの各馬のスコアを出す。学習は scripts/train-gbdt.mjs。
// スコア = 市場（単勝オッズの対数確率）＋ 木の合計。1着の確率はレース内のソフトマックス（simulatePL と同じ形）。

import { GBDT_MODEL } from './gbdtModel.js';
import { raceFeatures, FEATURE_NAMES } from './features.js';

export const GBDT_READY = !!(GBDT_MODEL?.trees?.length && GBDT_MODEL.names?.length === FEATURE_NAMES.length && GBDT_MODEL.names.every((k, i) => k === FEATURE_NAMES[i]));
export const GBDT_INFO = GBDT_MODEL ? { trainedOn: GBDT_MODEL.trainedOn, test: GBDT_MODEL.test, params: GBDT_MODEL.params } : null;

const iLogq = FEATURE_NAMES.indexOf('logq');

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
 * useMarket=false なら市場を出発点にしない（AI単独の木が必要。今は市場つきのみ）
 */
export function gbdtScores(race, opts = {}) {
  const fx = raceFeatures(race, opts);
  const rows = fx.rows.map((r) => {
    const adj = treeSum(r.x);
    return { ...r, adj, score: (GBDT_MODEL.base === 'logq' ? (GBDT_MODEL.baseScale || 1) * r.x[iLogq] : 0) + adj };
  });
  return { rows, pace: fx.pace, temps: GBDT_MODEL.temps || [1, 1, 1] };
}

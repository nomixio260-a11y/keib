// 予想モデル本体：ファクターを合成して能力スコアを出し、モンテカルロで確率に変換する。

import { computeRaceFactors } from './factors.js';
import { simulatePL, comboProbs } from './simulate.js';
import { harville, estimateOdds } from './market.js';
import { hashString } from './rng.js';
import { clamp, mean } from './util.js';
import { CALIBRATION } from './calibration.js';

/**
 * ファクター定義。
 *   unit    … 生の値をこの幅で割って標準化（全レース共通の物差し）
 *   missing … データがない馬に与える標準化値
 *   coef    … 既定ウェイト(ref)のときの係数（scripts/calibrate.mjs で推定）
 *   ref     … スライダーの既定値。係数 = coef × スライダー値 ÷ ref
 */
const FACTOR_DEFS = [
  { key: 'speed', label: 'スピード指数', unit: 8, missing: -0.6, desc: '前4走の走破タイムを、実際のレース結果から作った基準タイム（馬場差つき）と比べた指数。同じ芝ダでの最高値を今回の斤量に合わせて補正' },
  { key: 'form', label: '近走成績', unit: 0.2, missing: -0.3, desc: '着順・着差と、走ったクラスの格' },
  { key: 'closing', label: '上がり', unit: 0.25, missing: 0, desc: '上がり3ハロンを同じ条件の標準と比べた速さ（末脚の確かさ）' },
  { key: 'jockey', label: '騎手', unit: 0.07, missing: 0, desc: '実際のレース結果から集計した騎手の勝率・複勝率' },
  { key: 'trainer', label: '厩舎', unit: 0.07, missing: 0, desc: '実際のレース結果から集計した調教師（厩舎）の勝率・複勝率' },
  { key: 'aptitude', label: '適性', unit: 0.12, missing: 0, desc: '距離・コース・馬場・芝ダート・回りの実績' },
  { key: 'pace', label: '展開', unit: 0.3, missing: 0, desc: '脚質とペース予想、直線の長さによる前後の有利不利' },
  { key: 'draw', label: '枠順', unit: 0.3, missing: 0, desc: '実際のレース結果から集計した、コースごとの内枠・外枠の有利不利' },
  { key: 'condition', label: '状態', unit: 0.25, missing: 0, desc: '休み明け・連闘・叩き2戦目・斤量増減・馬体重増減・年齢' },
  { key: 'market', label: '人気', unit: 1, missing: 0, desc: '単勝オッズに表れた市場の評価。0にすると純粋なAI評価になる' },
];

export const FACTORS = FACTOR_DEFS.map((f) => ({
  ...f,
  coef: CALIBRATION.coef[f.key] ?? 0.1,
  ref: CALIBRATION.ref[f.key] ?? 10,
}));

export const FACTOR_KEYS = FACTORS.map((f) => f.key);

// AI単独：オッズを見ずに出馬表のデータだけで評価（重みは実データで推定した重要度）
const AI_WEIGHTS = Object.fromEntries(FACTORS.map((f) => [f.key, f.key === 'market' ? 0 : f.ref]));
// 総合：AIの評価と単勝オッズを、実際のレースで最もよく当たるように同時に推定した重み
const TOTAL_WEIGHTS = CALIBRATION.combinedWeights
  ? { ...AI_WEIGHTS, ...CALIBRATION.combinedWeights }
  : { ...Object.fromEntries(FACTORS.map((f) => [f.key, Math.round(f.ref / 2)])), market: 50 };
const scaled = (base, mult) => Object.fromEntries(Object.entries(base).map(([k, v]) => [k, Math.min(100, Math.round(v * (mult[k] ?? 1)))]));

export const PRESETS = {
  balance: {
    label: '総合',
    weights: TOTAL_WEIGHTS,
    noise: 1,
    desc: 'AIの評価と単勝オッズを、実際のレースで最もよく当たる割合で組み合わせます。着順の予想はこれが一番正確です。',
  },
  ai: {
    label: 'AI単独',
    weights: AI_WEIGHTS,
    noise: 1,
    desc: 'オッズを見ずに、出馬表のデータだけで評価します。人気との違いから妙味のある馬を探すのに向きます。',
  },
  speed: { label: 'スピード重視', weights: scaled(AI_WEIGHTS, { speed: 2, form: 0.6, jockey: 0.6 }), noise: 1, desc: '持ち時計（スピード指数）を重く見ます。' },
  pace: { label: '展開重視', weights: scaled(AI_WEIGHTS, { pace: 2.5, draw: 2, closing: 1.5 }), noise: 1, desc: '脚質・ペース・枠順を重く見ます。' },
};

export const DEFAULT_PRESET = PRESETS[CALIBRATION.defaultPreset] ? CALIBRATION.defaultPreset : 'balance';
export const DEFAULT_WEIGHTS = PRESETS[DEFAULT_PRESET].weights;
export const DEFAULT_NOISE = PRESETS[DEFAULT_PRESET].noise;
/** 校正のたびに変わる目印（保存した重みが古い校正のものか見分ける） */
export const CALIBRATION_ID = `${CALIBRATION.source || ''}|${CALIBRATION.trainedOn}|${CALIBRATION.period?.fit || ''}`;

// 着順ごとの温度（1着・2着・3着以下）。重みと一緒に実データで推定（scripts/calibrate.mjs）。
// 総合（人気の重みが大きい）と AI単独では尺度が違うので、人気の重みの割合で間をとる
const TEMPS_AI = CALIBRATION.temps?.ai || [1, 1, 1];
const TEMPS_TOTAL = CALIBRATION.temps?.total || TEMPS_AI;
const MARKET_FULL = Math.max(1, CALIBRATION.combinedWeights?.market || 100);
export function tempsFor(weights = DEFAULT_WEIGHTS, noise = 1) {
  const share = clamp((Number(weights.market) || 0) / MARKET_FULL, 0, 1);
  return TEMPS_AI.map((t, k) => (t + (TEMPS_TOTAL[k] - t) * share) * noise);
}
// AI指数の目盛り
export const INDEX_SCALE = CALIBRATION.indexScale;

export const DEFAULT_SETTINGS = { weights: DEFAULT_WEIGHTS, noise: DEFAULT_NOISE, sims: 20000 };

/** 頭数ごとの複勝の払戻対象（8頭以上:3着まで、5〜7頭:2着まで、4頭以下:発売なし） */
export const placeCountOf = (n) => (n >= 8 ? 3 : n >= 5 ? 2 : 0);

export function coefficients(weights = DEFAULT_WEIGHTS) {
  return Object.fromEntries(FACTORS.map((f) => [f.key, (f.coef * (Number(weights[f.key]) || 0)) / f.ref]));
}

/** レース内で中心化し、共通の物差しで標準化 */
function standardize(rows) {
  for (const f of FACTORS) {
    const vals = rows.map((r) => r.raw[f.key]);
    const known = vals.filter((v) => v != null && Number.isFinite(v));
    const m = known.length ? mean(known) : 0;
    rows.forEach((r, i) => {
      const v = vals[i];
      r.z[f.key] = v != null && Number.isFinite(v) ? clamp((v - m) / f.unit, -3, 3) : f.missing;
    });
  }
}

/**
 * 市場（単勝オッズ）から見た各券種の確率。馬連・三連複などの「推定オッズ」と、期待値に混ぜる確率に使う。
 * 予想と同じプラケット・ルースの形（人気だけで当てはめた係数と着順ごとの温度）でシミュレーションし、
 * 出現の少ない組み合わせは割引ハーヴィル式で補う。形をそろえておかないと、モデルの違いだけで
 * 「期待値が高い」ように見える組み合わせが出てしまう（実データの検証で確認）。
 */
const MARKET_BETA = CALIBRATION.marketBeta ?? 1;
const TEMPS_MARKET = CALIBRATION.temps?.market || [1, 1, 1];
export function marketModel(q, sims = 20000, seed = 7) {
  const n = q.length;
  const h = harville(q);
  if (n < 2) return h;
  const scores = q.map((v) => MARKET_BETA * Math.log(Math.max(v, 1e-6)));
  const sim = simulatePL(scores, { sims, seed: (seed ^ 0x5bd1e995) >>> 0, temps: TEMPS_MARKET });
  const c = comboProbs(sim);
  const enough = 3 / sims;
  const pick = (mc, hv) => mc.map((v, k) => (v >= enough ? v : hv[k]));
  return {
    n,
    win: q.slice(),
    top2: Float64Array.from(sim.top2),
    top3: Float64Array.from(sim.top3),
    exacta: pick(c.exacta, h.exacta),
    quinella: pick(c.quinella, h.quinella),
    wide: pick(c.wide, h.wide),
    trio: pick(c.trio, h.trio),
    trifecta: pick(c.trifecta, h.trifecta),
  };
}

/** 能力スコアまで（シミュレーション前）。校正スクリプトからも使う */
export function scoreRace(race, settings = {}) {
  const weights = settings.weights || DEFAULT_WEIGHTS;
  const fx = computeRaceFactors(race, { sires: settings.sires, jockeys: settings.jockeys, stats: settings.stats });
  const rows = fx.rows;
  rows.forEach((r) => {
    r.z = {};
  });
  standardize(rows);
  const coefs = coefficients(weights);
  for (const r of rows) {
    r.contrib = {};
    let s = 0;
    for (const f of FACTORS) {
      const c = coefs[f.key] * r.z[f.key];
      r.contrib[f.key] = c;
      s += c;
    }
    r.score = s;
  }
  return { ...fx, rows, coefs };
}

export function assignMarks(rows) {
  const sorted = [...rows].sort((a, b) => b.pWin - a.pWin);
  const marks = new Map();
  const base = ['◎', '○', '▲', '△', '△'].slice(0, Math.max(1, Math.min(5, rows.length - 1)));
  base.forEach((m, i) => sorted[i] && marks.set(sorted[i], m));
  // ☆ = 人気薄で期待値が高い穴馬
  const cands = sorted.filter(
    (r) => !marks.has(r) && r.ev != null && r.pWin >= 0.025 && (r.entry.popularity >= 6 || r.entry.odds >= 15),
  );
  cands.sort((a, b) => b.ev - a.ev);
  if (cands[0] && cands[0].ev >= 1.05) marks.set(cands[0], '☆');
  for (const r of rows) r.mark = marks.get(r) || '';
}

/** 自信度（S/A/B/C）と波乱度（1〜5） */
export function confidenceOf(rows) {
  const p = rows.map((r) => r.pWin).sort((a, b) => b - a);
  const top = p[0] ?? 0;
  const second = p[1] ?? 0;
  let grade = 'C';
  if (top >= 0.42) grade = 'S';
  else if (top >= 0.3 && top - second >= 0.08) grade = 'A';
  else if (top >= 0.2) grade = 'B';
  const n = p.length;
  const entropy = -p.reduce((acc, v) => acc + (v > 0 ? v * Math.log(v) : 0), 0);
  const evenness = n > 1 ? entropy / Math.log(n) : 0;
  const upset = clamp(1 + Math.floor((evenness - 0.7) / 0.05), 1, 5);
  return { grade, top, second, evenness, upset };
}

/** レースを予想する */
export function predictRace(race, settings = {}) {
  const sims = settings.sims ?? DEFAULT_SETTINGS.sims;
  if (race.jump || race.surface === '障') return { race, rows: [], n: 0, empty: true, jump: true };
  const scored = scoreRace(race, settings);
  const { rows } = scored;
  const n = rows.length;
  if (n === 0) return { race, rows, n, empty: true, pace: scored.pace };

  // 単勝オッズがまだ出ていない（前日発売の前など）
  const noOdds = !rows.some((r) => r.entry.odds > 1);
  const seed = hashString(`${race.id}|${sims}`);
  const temps = tempsFor(settings.weights || DEFAULT_WEIGHTS, settings.noise ?? 1);
  const sim = simulatePL(
    rows.map((r) => r.score),
    { sims, seed, temps },
  );
  const combos = comboProbs(sim);
  const market = marketModel(rows.map((r) => r.marketProb), sims, seed);
  const placeCount = placeCountOf(n);

  // AI指数：オッズを使わない「AI単独」の重みで見た能力（勝率は今の重み付けで計算）
  const aiCoef = coefficients(PRESETS.ai.weights);
  rows.forEach((r) => {
    r.aiScore = FACTORS.reduce((acc, f) => acc + (f.key === 'market' ? 0 : aiCoef[f.key] * r.z[f.key]), 0);
  });
  const aiMean = mean(rows.map((r) => r.aiScore));
  rows.forEach((r, i) => {
    r.i = i;
    r.pWin = sim.win[i];
    r.pTop2 = sim.top2[i];
    r.pTop3 = sim.top3[i];
    r.posDist = Array.from(sim.posDist.subarray(i * n, i * n + n));
    r.index = 50 + (10 * (r.aiScore - aiMean)) / INDEX_SCALE;
    r.odds = r.entry.odds > 1 ? r.entry.odds : null;
    r.ev = r.odds ? r.pWin * r.odds : null;
    const pPlace = placeCount === 3 ? r.pTop3 : r.pTop2;
    const mPlace = placeCount === 3 ? market.top3[i] : market.top2[i];
    r.pPlace = placeCount ? pPlace : null;
    // 複勝オッズ：実際のオッズ（下限〜上限）があれば下限を使い、なければ単勝オッズから推定
    const realPlace = r.entry.placeMin > 1 ? r.entry.placeMin : null;
    r.placeOdds = placeCount && !noOdds ? realPlace ?? estimateOdds('place', mPlace) : null;
    r.placeOddsEstimated = !realPlace;
    r.evPlace = r.placeOdds ? pPlace * r.placeOdds : null;
  });
  assignMarks(rows);
  const order = [...rows].sort((a, b) => b.pWin - a.pWin);
  order.forEach((r, k) => {
    r.rank = k + 1;
  });
  [...rows]
    .sort((a, b) => b.aiScore - a.aiScore)
    .forEach((r, k) => {
      r.aiRank = k + 1;
    });

  return {
    race,
    rows,
    n,
    order,
    sim,
    combos,
    market,
    placeCount,
    noOdds,
    temps,
    pace: scored.pace,
    straightBias: scored.straightBias,
    drawBias: scored.drawBias,
    nigeCount: scored.nigeCount,
    coefs: scored.coefs,
    confidence: confidenceOf(rows),
  };
}

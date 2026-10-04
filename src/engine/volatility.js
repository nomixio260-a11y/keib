// 荒れ度の要素の分析と、荒れ度に合わせた買い方（自動調整）。
// 荒れ度そのもの（人気3頭以外が勝つ確率）はモデルの勝率から計算する（model.js の confidenceOf）。ここでは、レースの条件ごとに
// 過去のレースで「人気3頭以外が勝った割合」を集計した表（volatilityModel.js、scripts/fit-volatility.mjs が作る）で、
// このレースのどの要素が荒れやすい方向・堅い方向に働いているかを説明する。

import { VOLATILITY_MODEL } from './volatilityModel.js';

const bin = (v, bins) => {
  if (v == null || !Number.isFinite(v)) return null;
  for (const [lo, hi, label] of bins) if (v >= lo && v <= hi) return label;
  return null;
};

/** 要素の定義（区分の名前は画面にもそのまま出す） */
export const ELEMENTS = [
  { key: 'field', label: '頭数', of: (x) => bin(x.n, [[0, 10, '10頭以下'], [11, 13, '11〜13頭'], [14, 16, '14〜16頭'], [17, 99, '17頭以上']]) },
  { key: 'favOdds', label: '1番人気の単勝', of: (x) => bin(x.favOdds, [[0, 1.99, '2.0倍未満'], [2, 2.99, '2.0〜2.9倍'], [3, 4.99, '3.0〜4.9倍'], [5, 9999, '5.0倍以上']]) },
  { key: 'cls', label: 'クラス', of: (x) => ({ 新馬: '新馬', 未勝利: '未勝利', '1勝': '1勝クラス', '2勝': '2勝クラス', '3勝': '3勝クラス', OP: 'オープン', L: 'オープン', G3: '重賞', G2: '重賞', G1: '重賞' })[x.grade] || null },
  { key: 'surface', label: '芝・ダート', of: (x) => ({ 芝: '芝', ダ: 'ダート' })[x.surface] || null },
  { key: 'going', label: '馬場', of: (x) => ({ 良: '良', 稍重: '稍重', 重: '重・不良', 不良: '重・不良' })[x.going] || null },
  { key: 'handicap', label: '負担重量', of: (x) => (x.weightRule ? (x.weightRule === 'ハンデ' ? 'ハンデ戦' : 'ハンデ戦以外') : null) },
  { key: 'newcomers', label: '初出走の馬', of: (x) => bin(x.newcomerShare, [[0, 0, 'いない'], [0.0001, 0.25, '4分の1以下'], [0.2501, 1, '4分の1より多い']]) },
  { key: 'dist', label: '距離', of: (x) => bin(x.distance, [[0, 1400, '1400m以下'], [1401, 1800, '1401〜1800m'], [1801, 2200, '1801〜2200m'], [2201, 9999, '2201m以上']]) },
];

/** レースの各要素の区分 { key: 区分 } */
export function classifyRace(x) {
  return Object.fromEntries(ELEMENTS.map((el) => [el.key, el.of(x)]));
}

/** 予想（predictRace の結果）から要素の入力 */
export function elementInputOf(pred) {
  const rows = pred.rows || [];
  const odds = rows.map((r) => r.entry.odds).filter((v) => v > 1);
  const race = pred.race || {};
  return {
    n: rows.length,
    favOdds: odds.length ? Math.min(...odds) : null,
    grade: race.grade,
    surface: race.surface,
    going: race.going,
    weightRule: race.weightRule,
    newcomerShare: rows.length ? rows.filter((r) => !(r.entry.past?.length > 0)).length / rows.length : null,
    distance: race.distance,
  };
}

/**
 * 荒れ度の要素の分析：このレースの各要素と、その条件のレースで人気3頭以外が勝った割合（全体との差の大きい順）。
 * モデルがなければ空の配列
 */
export function volatilityFactors(pred, model = VOLATILITY_MODEL) {
  if (!model?.elements) return [];
  const cls = classifyRace(elementInputOf(pred));
  const out = [];
  for (const el of ELEMENTS) {
    const v = cls[el.key];
    const s = v && model.elements[el.key]?.[v];
    if (!s || s.n < 100) continue;
    out.push({ key: el.key, label: el.label, value: v, rate: s.rate, n: s.n, delta: s.rate - model.overall });
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

/** 荒れ度の区切り（モデルがあれば学習期間の分割外の3分位で自動で決めた値） */
export const AUTO_VOLATILITY_CUTS = VOLATILITY_MODEL?.cuts || null;

/** 荒れ度に合わせた買い方（自動調整）：荒れ度の区分 → 買い方の名前。モデルがなければ null */
export const AUTO_POLICY = VOLATILITY_MODEL?.policy || null;

/** 買い方の名前 → 買い目（◎○▲△の行番号から）。idx は予想の行番号、stake は1点あたり */
export const POLICY_FORMS = {
  skip: { label: '見送り', build: () => [] },
  win: { label: '単勝◎', build: (m) => [{ type: 'win', idx: [m[0]] }] },
  place: { label: '複勝◎', build: (m, pc) => (pc ? [{ type: 'place', idx: [m[0]] }] : []) },
  winplace: { label: '単勝◎＋複勝◎', build: (m, pc) => [{ type: 'win', idx: [m[0]] }, ...(pc ? [{ type: 'place', idx: [m[0]] }] : [])] },
  quinella: { label: '馬連◎-○', build: (m) => (m[1] != null ? [{ type: 'quinella', idx: [m[0], m[1]] }] : []) },
  wide2: { label: 'ワイド◎-○・◎-▲', build: (m, pc, n) => (n >= 8 ? [m[1], m[2]].filter((v) => v != null).map((o) => ({ type: 'wide', idx: [m[0], o] })) : []) },
  trio6: {
    label: '三連複◎軸・相手4頭',
    build: (m, pc, n) => {
      if (n < 6) return [];
      const o = [m[1], m[2], m[3], m[4]].filter((v) => v != null);
      const out = [];
      for (let i = 0; i < o.length; i++) for (let j = i + 1; j < o.length; j++) out.push({ type: 'trio', idx: [m[0], o[i], o[j]] });
      return out;
    },
  },
};

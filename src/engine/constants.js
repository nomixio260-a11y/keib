// 競馬の基本データ（JRA 10場・クラス・馬場・券種）

export const SURFACES = ['芝', 'ダ'];
export const GOINGS = ['良', '稍重', '重', '不良'];
export const GRADES = ['新馬', '未勝利', '1勝', '2勝', '3勝', 'OP', 'L', 'G3', 'G2', 'G1'];
export const OPEN_GRADES = ['OP', 'L', 'G3', 'G2', 'G1'];

/** クラスの序列（モデルの「格」補正に使う） */
export const CLASS_LEVEL = { 新馬: 0, 未勝利: 0, '1勝': 1, '2勝': 2, '3勝': 3, OP: 4, L: 4.5, G3: 5, G2: 6, G1: 7 };

export const classLevel = (g) => CLASS_LEVEL[g] ?? 2;
export const isOpenClass = (g) => OPEN_GRADES.includes(g);

/** 勝ち上がり後のクラス */
export function nextClass(g) {
  switch (g) {
    case '新馬':
    case '未勝利':
      return '1勝';
    case '1勝':
      return '2勝';
    case '2勝':
      return '3勝';
    case '3勝':
      return 'OP';
    default:
      return g;
  }
}

/** クラス表示（出馬表の見出し用） */
export function gradeLabel(g) {
  if (['1勝', '2勝', '3勝'].includes(g)) return `${g}クラス`;
  if (g === 'OP') return 'オープン';
  if (g === 'L') return 'リステッド';
  return g;
}

/**
 * JRA 10場。直線は芝/ダートのおおよその長さ(m)。
 * offset は基準タイムの場補正（1000mあたり秒、＋で時計がかかる）。
 * drawBias は枠の有利不利（＋で内枠有利、−で外枠有利）。
 */
export const COURSES = {
  札幌: { code: 'SPR', dir: '右', straight: { 芝: 266, ダ: 264 }, offset: 0.45, drawBias: { 芝: 0.35, ダ: 0.1 }, turf: [1200, 1500, 1800, 2000, 2600], dirt: [1000, 1700] },
  函館: { code: 'HKD', dir: '右', straight: { 芝: 262, ダ: 260 }, offset: 0.55, drawBias: { 芝: 0.4, ダ: 0.1 }, turf: [1200, 1800, 2000, 2600], dirt: [1000, 1700] },
  福島: { code: 'FKS', dir: '右', straight: { 芝: 292, ダ: 296 }, offset: 0.3, drawBias: { 芝: 0.5, ダ: 0.1 }, turf: [1200, 1800, 2000, 2600], dirt: [1150, 1700] },
  新潟: { code: 'NGT', dir: '左', straight: { 芝: 659, ダ: 354 }, offset: -0.2, drawBias: { 芝: -0.1, ダ: 0.05 }, turf: [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400], dirt: [1200, 1800] },
  東京: { code: 'TKY', dir: '左', straight: { 芝: 526, ダ: 502 }, offset: 0.0, drawBias: { 芝: 0.15, ダ: -0.2 }, turf: [1400, 1600, 1800, 2000, 2300, 2400], dirt: [1300, 1400, 1600, 2100] },
  中山: { code: 'NKY', dir: '右', straight: { 芝: 310, ダ: 308 }, offset: 0.35, drawBias: { 芝: 0.55, ダ: -0.1 }, turf: [1200, 1600, 1800, 2000, 2200, 2500], dirt: [1200, 1800, 2400] },
  中京: { code: 'CKY', dir: '左', straight: { 芝: 413, ダ: 411 }, offset: 0.25, drawBias: { 芝: 0.1, ダ: 0.0 }, turf: [1200, 1400, 1600, 2000, 2200], dirt: [1200, 1400, 1800, 1900] },
  京都: { code: 'KYO', dir: '右', straight: { 芝: 404, ダ: 329 }, offset: -0.05, drawBias: { 芝: 0.3, ダ: 0.05 }, turf: [1200, 1400, 1600, 1800, 2000, 2200, 2400, 3000], dirt: [1200, 1400, 1800, 1900] },
  阪神: { code: 'HSN', dir: '右', straight: { 芝: 474, ダ: 353 }, offset: 0.1, drawBias: { 芝: 0.2, ダ: 0.0 }, turf: [1200, 1400, 1600, 1800, 2000, 2200, 2400], dirt: [1200, 1400, 1800, 2000] },
  小倉: { code: 'KKR', dir: '右', straight: { 芝: 293, ダ: 291 }, offset: 0.0, drawBias: { 芝: 0.45, ダ: 0.1 }, turf: [1200, 1800, 2000, 2600], dirt: [1000, 1700] },
};

export const COURSE_NAMES = Object.keys(COURSES);

// コース固有の枠順傾向（代表的なもの）
const SPECIAL_DRAW = {
  '新潟|芝|1000': -0.9, // 直線1000mは外ラチ沿いが有利
  '東京|ダ|1600': -0.35, // 芝スタートで外枠が加速しやすい
  '東京|ダ|1300': -0.2,
  '東京|ダ|1400': -0.2,
  '中山|ダ|1200': -0.3,
  '中山|芝|1600': 0.75, // スタート直後にコーナー、外枠不利
  '中山|芝|2000': 0.45,
  '東京|芝|2000': 0.5,
  '京都|芝|1400': 0.35,
  '阪神|ダ|1400': -0.2,
  '中京|ダ|1400': -0.15,
};

export function drawBias(course, surface, distance) {
  const key = `${course}|${surface}|${distance}`;
  if (key in SPECIAL_DRAW) return SPECIAL_DRAW[key];
  return COURSES[course]?.drawBias?.[surface] ?? 0;
}

export function straightLength(course, surface, distance) {
  if (course === '新潟' && surface === '芝' && distance === 1000) return 1000;
  return COURSES[course]?.straight?.[surface] ?? 360;
}

/** 直線の短さ → 先行有利の度合い（＋で前有利、−で差し有利） */
export function straightBias(course, surface, distance) {
  const len = straightLength(course, surface, distance);
  return Math.max(-1, Math.min(1, (380 - len) / 180));
}

/** 馬番 → 枠番（JRA方式：頭数が8を超えると外枠から2頭・3頭入り） */
export function frameOf(number, fieldSize) {
  if (fieldSize <= 8) return number;
  const base = Math.floor(fieldSize / 8);
  const extra = fieldSize % 8;
  let n = 0;
  for (let frame = 1; frame <= 8; frame++) {
    n += base + (frame > 8 - extra ? 1 : 0);
    if (number <= n) return frame;
  }
  return 8;
}

export const BET_TYPES = ['win', 'place', 'quinella', 'wide', 'exacta', 'trio', 'trifecta'];

export const BET_LABEL = {
  win: '単勝',
  place: '複勝',
  quinella: '馬連',
  wide: 'ワイド',
  exacta: '馬単',
  trio: '三連複',
  trifecta: '三連単',
};

/** JRA の払戻率 */
export const PAYOUT_RATE = {
  win: 0.8,
  place: 0.8,
  quinella: 0.775,
  wide: 0.775,
  exacta: 0.75,
  trio: 0.75,
  trifecta: 0.725,
};

/** 騎手データがないときの平均値 */
export const JOCKEY_DEFAULT = { winRate: 0.07, top3Rate: 0.21 };

export const MARKS = ['◎', '○', '▲', '△', '☆'];

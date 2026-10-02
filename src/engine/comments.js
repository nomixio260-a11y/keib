// 予想の根拠をことばにする（各馬の短評・レース展望）

import { FACTORS } from './model.js';

const pct = (v) => `${(v * 100).toFixed(1)}%`;

function finishesText(runs, k = 3) {
  return runs
    .slice(0, k)
    .map((r) => (r.finish > 0 ? r.finish : '中'))
    .join('-');
}

function aptitudeText(row, race, sign) {
  const p = row.apt.parts;
  const surfaceName = race.surface === '芝' ? '芝' : 'ダート';
  const cands = [
    { v: p.dist, pos: '距離実績あり', neg: '距離に不安' },
    { v: p.course, pos: `${race.course}${surfaceName}で好走歴`, neg: `${race.course}${surfaceName}で凡走歴` },
    { v: p.going, pos: '道悪巧者', neg: '道悪は割引' },
    { v: p.surface, pos: `${surfaceName}で良績`, neg: row.apt.sameSurf === 0 && row.stats.runs > 0 ? `初の${surfaceName}` : `${surfaceName}は今ひとつ` },
    { v: p.pedigree, pos: `血統は${surfaceName}${race.distance}m向き`, neg: `血統的に${surfaceName}${race.distance}mは疑問` },
  ];
  cands.sort((a, b) => sign * (b.v - a.v));
  const c = cands[0];
  if (!c || sign * c.v <= 0) return null;
  return sign > 0 ? c.pos : c.neg;
}

function factorText(key, row, pred, sign, jockeys) {
  const { race, pace } = pred;
  const s = row.stats;
  switch (key) {
    case 'speed':
      if (s.bestSi == null) return sign < 0 ? '初出走で時計は未知数' : null;
      return sign > 0 ? `スピード指数${Math.round(s.bestSi)}は上位` : `持ち時計で見劣り（最高${Math.round(s.bestSi)}）`;
    case 'form':
      if (!row.runs.length) return null;
      return sign > 0 ? `近走${finishesText(row.runs)}着と好調` : `近走${finishesText(row.runs)}着と精彩を欠く`;
    case 'closing':
      if (!row.runs.length) return null;
      if (sign > 0) return s.topClosing > 0 ? `上がり最速${s.topClosing}回の末脚` : '末脚は堅実';
      return '決め手に欠ける';
    case 'jockey': {
      const j = jockeys?.[row.entry.jockey];
      if (!j) return null;
      return sign > 0 ? `${row.entry.jockey}騎手（勝率${pct(j.winRate)}）` : `鞍上の勝率は${pct(j.winRate)}`;
    }
    case 'aptitude':
      return aptitudeText(row, race, sign);
    case 'pace': {
      const st = row.style.style;
      if (st === '不明') return null;
      if (sign > 0) {
        if (row.loneLeader) return '単騎逃げが濃厚';
        return `${st}に向く${pace.label === 'H' ? 'ハイ' : pace.label === 'S' ? 'スロー' : 'ミドル'}ペース想定`;
      }
      return `${st}には厳しい流れ`;
    }
    case 'draw':
      return sign > 0 ? `${row.inner > 0 ? '内' : '外'}枠が有利なコース` : `${row.inner > 0 ? '内' : '外'}枠は不利なコース`;
    case 'condition': {
      const notes = row.cond.notes.filter((n) => n.sign === sign).map((n) => n.text);
      return notes.length ? notes.join('・') : null;
    }
    case 'market':
      return sign > 0 ? `${row.entry.popularity}番人気の支持` : `${row.entry.popularity}番人気と評価は低め`;
    default:
      return null;
  }
}

/** 1頭分の短評 { pros, cons } */
export function horseComment(row, pred, jockeys) {
  const items = FACTORS.map((f) => ({ key: f.key, c: row.contrib[f.key] })).filter((x) => Math.abs(x.c) > 0.04);
  const pros = items
    .filter((x) => x.c > 0)
    .sort((a, b) => b.c - a.c)
    .map((x) => factorText(x.key, row, pred, 1, jockeys))
    .filter(Boolean)
    .slice(0, 3);
  const cons = items
    .filter((x) => x.c < 0)
    .sort((a, b) => a.c - b.c)
    .map((x) => factorText(x.key, row, pred, -1, jockeys))
    .filter(Boolean)
    .slice(0, 2);
  return { pros, cons };
}

const PACE_NAME = { H: 'ハイペース', M: 'ミドルペース', S: 'スローペース' };

/** 展開の説明文 */
export function paceComment(pred) {
  const { pace, rows, straightBias } = pred;
  const nige = rows.filter((r) => r.style.style === '逃げ').map((r) => r.entry.number);
  const senko = rows.filter((r) => r.style.style === '先行').map((r) => r.entry.number);
  const parts = [];
  if (nige.length === 0) parts.push('はっきりした逃げ馬が不在');
  else if (nige.length === 1) parts.push(`逃げ候補は${nige[0]}番の1頭だけ`);
  else parts.push(`逃げ候補が${nige.join('・')}番と${nige.length}頭`);
  if (senko.length) parts.push(`先行勢は${senko.length}頭`);
  let tail;
  if (pace.label === 'H') tail = '前半から流れが速くなりそうで、差し・追込に向く展開。';
  else if (pace.label === 'S') tail = '隊列はすんなり決まりそうで、前に行ける馬が有利。';
  else tail = '平均的な流れになりそう。';
  if (straightBias > 0.4) tail += '直線が短く、4コーナーで前にいたい。';
  else if (straightBias < -0.4) tail += '直線が長く、末脚の差が出やすい。';
  return { name: PACE_NAME[pace.label], text: `${parts.join('、')}。${tail}` };
}

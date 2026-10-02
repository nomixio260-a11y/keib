#!/usr/bin/env node
// 開発用：特徴量の組み合わせごとに、テスト期間（学習に使っていないレース）の当てはまりを比べる。
// 新しいファクターを本体に入れる前に、ここで効果があるかを確かめる。
//
//   CAL_START=2026-03-01 TEST_START=2026-07-01 node scripts/experiment.mjs
//   DROP=pace,draw node scripts/experiment.mjs          … ファクターを外して比較
//   EXTRA=jchg,ppop,smax,slast node scripts/experiment.mjs … 候補の特徴量を足して比較
//   --no-variant                                        … 開催日ごとの馬場差なしで比較
//   LAMBDA=100 node scripts/experiment.mjs              … 人気以外の係数を0に寄せる正則化の強さ
//
// 候補の特徴量（このファイルの extras）：
//   jchg  … 騎手の乗り替わり（今回の騎手と前走の騎手の複勝率の差）
//   ppop  … 過去走の人気（市場の過去の評価）
//   smax  … 同じ芝ダでの最高スピード指数、slast … 前走のスピード指数
//   mplace … 複勝オッズ（単勝とは別の投票）から見た評価
//   smean … 以前のスピード指数（平均型）。DROP=speed EXTRA=smean で今の最高値型と比べる
// 出力の winLL は勝ち馬の対数尤度、2-3着LL は2・3着の対数尤度（どちらも大きいほど良い）、top1 は最上位の馬が勝った割合。
import { loadHistory } from '../src/collector/store.js';
import { statsForEngine, usable, PERIODS } from './calibrate.mjs';
import { indexHistory, preRaceCard } from '../src/data/history.js';
import { FACTORS, scoreRace } from '../src/engine/model.js';

const STAGE_W = [1, 0.75, 0.5];
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
function ll(data, keys, beta, stages = 3) {
  let s = 0;
  let s23 = 0;
  let top1 = 0;
  for (const d of data) {
    const sc = d.z.map((z) => keys.reduce((a, k, f) => a + beta[f] * z[k], 0));
    const remain = new Set(sc.map((_, i) => i));
    d.order.slice(0, stages).forEach((w, st) => {
      const ids = [...remain];
      const mx = Math.max(...ids.map((i) => sc[i]));
      const Z = ids.reduce((a, i) => a + Math.exp(sc[i] - mx), 0);
      const lp = sc[w] - mx - Math.log(Z);
      if (st === 0) s += lp;
      else s23 += lp;
      remain.delete(w);
    });
    const best = sc.indexOf(Math.max(...sc));
    if (best === d.order[0]) top1++;
  }
  return { winLL: s / data.length, placeLL: s23 / data.length, top1: top1 / data.length };
}
// 正則化の強さ（人気以外のファクターを0に引き寄せる）。大きいほどオッズ寄りになる
const LAMBDA = Number(process.env.LAMBDA || 1);
function fit(data, keys) {
  const F = keys.length;
  const lam = keys.map((k) => (k === 'market' ? 1 : LAMBDA));
  let beta = new Array(F).fill(0.1);
  for (let it = 0; it < 30; it++) {
    const g = new Array(F).fill(0);
    const H = Array.from({ length: F }, () => new Array(F).fill(0));
    for (const d of data) {
      const x = d.z.map((z) => keys.map((k) => z[k]));
      const s = x.map((row) => row.reduce((acc, v, f) => acc + v * beta[f], 0));
      const remain = new Set(x.map((_, i) => i));
      d.order.slice(0, 3).forEach((winner, stage) => {
        const w = STAGE_W[stage];
        const ids = [...remain];
        const mx = Math.max(...ids.map((i) => s[i]));
        const ex = ids.map((i) => Math.exp(s[i] - mx));
        const Z = ex.reduce((a, b) => a + b, 0);
        const m = new Array(F).fill(0);
        ids.forEach((i, k) => {
          const p = ex[k] / Z;
          for (let f = 0; f < F; f++) m[f] += p * x[i][f];
        });
        for (let f = 0; f < F; f++) g[f] += w * (x[winner][f] - m[f]);
        ids.forEach((i, k) => {
          const p = ex[k] / Z;
          for (let a = 0; a < F; a++) for (let b = 0; b < F; b++) H[a][b] -= w * p * (x[i][a] - m[a]) * (x[i][b] - m[b]);
        });
        remain.delete(winner);
      });
    }
    for (let f = 0; f < F; f++) {
      g[f] -= 2 * lam[f] * beta[f];
      H[f][f] -= 2 * lam[f];
    }
    const step = solve(H.map((row) => row.map((v) => -v)), g);
    beta = beta.map((b, f) => b + step[f]);
    if (Math.max(...step.map(Math.abs)) < 1e-6) break;
  }
  return beta;
}

const all = await loadHistory();
const index = indexHistory(all);
const variants = !process.argv.includes('--no-variant');
const stats = statsForEngine(all.filter((r) => r.date < PERIODS.calStart), variants ? all : []);
const jr = (name) => stats.jockeyRates?.[name]?.top3Rate ?? stats.jockeyAverage.top3Rate;
const RW = [1, 0.8, 0.65, 0.5];
function extras(row) {
  const e = row.entry;
  const runs = row.runs || [];
  const last = runs[0];
  const jchg = last && last.jockey ? jr(e.jockey) - jr(last.jockey) : 0;
  let s = 0;
  let w = 0;
  runs.forEach((r, k) => {
    if (r.popularity > 0 && r.fieldSize > 0) {
      s += RW[k] * Math.log((r.fieldSize + 1) / r.popularity);
      w += RW[k];
    }
  });
  const sis = (row.an || []).filter((a) => a.si != null && a.sameSurface && Math.abs(a.run.distance - 0) >= 0).map((a) => a.si);
  const wadj = e.weight > 0 ? -2 * (e.weight - 55) : 0;
  const smax = sis.length ? Math.max(...sis) + wadj : null;
  const slast = row.an?.[0]?.si != null ? row.an[0].si + wadj : null;
  // 以前のスピード指数（近い条件・直近を重く見た平均、上位3走を重視）
  const it = (row.an || []).filter((a) => a.si != null).map((a) => ({ si: a.si, w: a.recency * (a.sameSurface ? 1 : 0.35) })).sort((x, y) => y.si - x.si);
  let ms = 0;
  let mw = 0;
  it.forEach((x, k) => {
    const ww = x.w * (k < 3 ? 1 : 0.7);
    ms += ww * x.si;
    mw += ww;
  });
  const smean = mw ? ms / mw + wadj : null;
  // 複勝オッズ（別の投票の市場）の評価：中央値の逆数の対数
  const pm = e.placeMin > 0 && e.placeMax > 0 ? (e.placeMin + e.placeMax) / 2 : null;
  const mplace = pm ? -Math.log(pm) : null;
  return { jchg, ppop: w ? s / w : null, smax, slast, mplace, smean };
}
const build = (recs) =>
  recs.map((rec) => {
    const card = preRaceCard(rec, index);
    const s = scoreRace(card, { stats });
    const ex = s.rows.map(extras);
    const UNIT = { jchg: 0.1, ppop: 0.8, smax: 8, slast: 8, mplace: 1, smean: 8 };
    const MISS = { jchg: 0, ppop: -0.5, smax: -0.6, slast: -0.6, mplace: -1, smean: -0.6 };
    for (const key of Object.keys(UNIT)) {
      const vals = ex.map((x) => x[key]).filter((v) => v != null);
      const m = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      s.rows.forEach((r, i) => {
        const v = ex[i][key];
        r.z[key] = v == null ? MISS[key] : Math.max(-3, Math.min(3, (v - m) / UNIT[key]));
      });
    }
    const idxOf = new Map(s.rows.map((r, i) => [r.entry.number, i]));
    return { z: s.rows.map((r) => r.z), order: card.result.map((n) => idxOf.get(n)).filter((v) => v != null), grade: rec.grade };
  });
const fitSet = build(all.filter((r) => r.date >= PERIODS.calStart && r.date < PERIODS.testStart && usable(r)));
const testSet = build(all.filter((r) => r.date >= PERIODS.testStart && usable(r)));
console.log(`fit ${fitSet.length} test ${testSet.length} variants ${variants}`);
const baseKeys = FACTORS.map((f) => f.key).filter((k) => k !== 'market');
const drop = (process.env.DROP || '').split(',').filter(Boolean);
const ai = baseKeys.filter((k) => !drop.includes(k));
const extra = (process.env.EXTRA || '').split(',').filter(Boolean);
const combos = [['market', ['market']], ['AI', [...ai, ...extra]], ['AI+market', [...ai, ...extra, 'market']]];
if (extra.includes('mplace')) combos.push(['market+place', ['market', 'mplace']]);
for (const [name, keys] of combos) {
  const beta = fit(fitSet, keys);
  const r = ll(testSet, keys, beta);
  const rf = ll(fitSet, keys, beta);
  console.log(name.padEnd(10), 'test winLL', r.winLL.toFixed(4), '2-3着LL', r.placeLL.toFixed(4), 'top1', (r.top1 * 100).toFixed(1) + '%', '| fit winLL', rf.winLL.toFixed(4), '|', keys.map((k, i) => `${k}:${beta[i].toFixed(2)}`).join(' '));
}

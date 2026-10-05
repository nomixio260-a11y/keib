// 記録したオッズの推移（data/odds/{年}/{レースID}.json。Race day が data ブランチの odds/ に貯める）から、
// 「発走 minutes 分前 → 確定」のずれの標本を作る（src/engine/oddsDrift.js）
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { DATA_DIR } from '../../src/collector/store.js';
import { preRaceCard } from '../../src/data/history.js';
import { driftSamples } from '../../src/engine/oddsDrift.js';

export async function loadSnapshots(dir = process.env.KEIB_ODDS_DIR || path.join(DATA_DIR, 'odds')) {
  const docs = [];
  for (const y of (await readdir(dir).catch(() => [])).sort()) {
    for (const f of await readdir(path.join(dir, y)).catch(() => [])) {
      if (!f.endsWith('.json')) continue;
      try {
        docs.push(JSON.parse(await readFile(path.join(dir, y, f), 'utf8')));
      } catch {
        // 壊れた記録は飛ばす
      }
    }
  }
  return docs;
}

/** 標本（結果の記録 records と、その索引 index が必要。確定オッズは結果の記録から） */
export async function loadDrift(records, index, minutes = 10, dir) {
  const docs = await loadSnapshots(dir);
  const byId = new Map(records.map((r) => [r.id, r]));
  const samples = driftSamples(docs, (id) => (byId.has(id) ? preRaceCard(byId.get(id), index) : null), minutes);
  const used = docs.filter((d) => byId.has(d.id));
  const races = new Set(used.map((d) => d.id)).size;
  const days = new Set(used.map((d) => d.date)).size;
  // 発走 minutes 分前より前、30分以内の記録があるレース（取り込みが止まっていた日の記録だけだと、前日のオッズを「発走前」と取り違える）
  const near = used.filter((d) => {
    const lim = Date.parse(`${d.date}T${d.startTime}:00+09:00`) - minutes * 60000;
    return (d.snapshots || []).some((s) => Date.parse(s.at) <= lim && Date.parse(s.at) > lim - 30 * 60000);
  }).length;
  return { samples, races, days, near };
}

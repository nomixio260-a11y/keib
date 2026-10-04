#!/usr/bin/env node
// claude.ai の Artifact を、data ブランチの最新のデータ（Race day ワークフローが更新する data.json と days/）で作り直す準備。
// Artifact のページは外部からデータを読めない（CSP）ので、出馬表が出たら公開し直すしかない。定期実行のルーティンがこれを動かし、
// 出力の SIGNATURE を公開中の version.json と比べて、変わっていれば dist/artifact.html と FILES を公開し直す。
//
//   node scripts/artifact-refresh.mjs
//     1) git fetch origin data → data/bundle.json（data.json）と dist/days/（過去の開催日のアーカイブ）を最新に
//     2) dist/version.json（データの生成時刻とコードのコミット）を書く
//     3) npm run build（dist/artifact.html にデータを埋め込む）
//   出力：SIGNATURE=…（公開中の version.json の signature と同じなら公開し直す必要なし）
//         FILES=…（Artifact の publish に渡す files の JSON。version.json・days/index.json・直近の開催日）

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
const RECENT_DAYS = Number(process.env.RECENT_DAYS || 21);

// 1) data ブランチの最新
git('fetch', '-q', 'origin', 'data');
const dataJson = git('show', 'origin/data:data.json');
mkdirSync(path.join(ROOT, 'data'), { recursive: true });
writeFileSync(path.join(ROOT, 'data/bundle.json'), dataJson);
const bundle = JSON.parse(dataJson.toString('utf8'));
const distDays = path.join(ROOT, 'dist/days');
rmSync(distDays, { recursive: true, force: true });
mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const tar = git('archive', '--format=tar', 'origin/data', 'days');
execFileSync('tar', ['-x', '-C', path.join(ROOT, 'dist')], { input: tar });

// 2) 公開の目印：データが変わったとき（generatedAt）かコードが変わったとき（コミット）に変わる
const commit = git('rev-parse', '--short', 'HEAD').toString().trim();
const dayFiles = readdirSync(distDays).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const signature = `${bundle.generatedAt}|${commit}|${dayFiles.length}`;
const version = {
  signature,
  generatedAt: bundle.generatedAt,
  checkedAt: bundle.checkedAt || null,
  commit,
  days: (bundle.days || []).map((d) => `${d.date}:${d.races.length}${d.races.some((r) => r.provisional) ? 'p' : ''}`),
  builtAt: new Date().toISOString(),
};
writeFileSync(path.join(ROOT, 'dist/version.json'), JSON.stringify(version, null, 1));

// 3) ビルド（data/bundle.json を dist/artifact.html に埋め込む）
execFileSync('node', ['scripts/build.mjs'], { cwd: ROOT, stdio: 'inherit' });

// publish に渡すファイル：version.json・アーカイブの一覧・直近の開催日（古い日はすでに公開済みで、公開し直しても残る）
const files = { 'version.json': 'dist/version.json', 'days/index.json': 'dist/days/index.json' };
for (const f of dayFiles.slice(-RECENT_DAYS)) files[`days/${f}`] = `dist/days/${f}`;
const size = (p) => readFileSync(path.join(ROOT, p)).length;
console.log(`データ ${bundle.generatedAt}（確認 ${bundle.checkedAt || '—'}）・${(bundle.days || []).length}日・artifact.html ${(size('dist/artifact.html') / 1e6).toFixed(1)}MB`);
console.log(`SIGNATURE=${signature}`);
console.log(`FILES=${JSON.stringify(files)}`);

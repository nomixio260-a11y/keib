#!/usr/bin/env node
// claude.ai の Artifact を、data ブランチの最新のデータ（Race day ワークフローが更新する data.json と days/）で作り直す準備。
// Artifact のページは外部からデータを読めない（CSP）ので、出馬表・オッズ・結果が変わったら公開し直すしかない。定期実行の
// ルーティンが、公開中の version.json を読んでこれに渡し、変わっていれば出力の FILE_PATH と FILES で公開し直す。
//
//   node scripts/artifact-refresh.mjs [--published <公開中の version.json を保存したファイル>]
//     1) git fetch origin data → data/bundle.json（data.json）と dist/days/（過去の開催日のアーカイブ）を最新に
//     2) npm run build（dist/artifact.html にデータを埋め込み、dist/data.json にコピー）
//     3) 公開中の version.json と比べる：ページ（埋め込みのデータを除く）・data.json・アーカイブの各ファイルの sha256 が
//        同じなら UNCHANGED。data.json と一覧は毎時の確認で時刻だけ変わるので、時刻を除いた中身で比べる
//   出力：UNCHANGED（公開し直す必要なし）か、FILE_PATH=…（publish の file_path）と FILES=…（publish の files の JSON）
//
// ページは同じ場所の data.json を先に読む（埋め込みは読めないときの予備）ので、data.json も一緒に公開する。
// アーカイブは変わった日だけ送る（publish は1回 64MB まで。送りきれない日は version.json に前の値を残し、次の回に送る）。

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
const abs = (p) => path.join(ROOT, p);
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
// 1回の公開で送るアーカイブの上限（ページ約5MB と data.json 約5MB を足して 64MB に収まるように）
const DAYS_BUDGET = Number(process.env.DAYS_BUDGET || 40e6);
const sha = (data) => createHash('sha256').update(data).digest('hex').slice(0, 16);
const contentSha = (buf) => sha(JSON.stringify({ ...JSON.parse(buf.toString('utf8')), generatedAt: undefined, checkedAt: undefined }));

// 1) data ブランチの最新（クローンのしかたによらず origin/data を更新する）
git('fetch', '-q', 'origin', '+refs/heads/data:refs/remotes/origin/data');
const dataJson = git('show', 'origin/data:data.json');
const bundle = JSON.parse(dataJson.toString('utf8'));
mkdirSync(abs('data'), { recursive: true });
writeFileSync(abs('data/bundle.json'), dataJson);
const distDays = abs('dist/days');
rmSync(distDays, { recursive: true, force: true });
mkdirSync(abs('dist'), { recursive: true });
execFileSync('tar', ['-x', '-C', abs('dist')], { input: git('archive', '--format=tar', 'origin/data', 'days') });
const dayFiles = readdirSync(distDays)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort();

// 2) ビルド
execFileSync('node', ['scripts/build.mjs'], { cwd: ROOT, stdio: 'inherit' });

// 3) 公開中のものと比べる
const commit = git('rev-parse', 'HEAD').toString().trim().slice(0, 12);
const page = readFileSync(abs('dist/artifact.html'), 'utf8').replace(/<script type="application\/json" id="keib-data">[\s\S]*?<\/script>/, '');
const current = {
  page: sha(page),
  'data.json': contentSha(dataJson),
  'days/index.json': contentSha(readFileSync(path.join(distDays, 'index.json'))),
};
for (const f of dayFiles) current[`days/${f}`] = sha(readFileSync(path.join(distDays, f)));
let published = null;
const publishedFile = argOf('--published');
if (publishedFile) {
  try {
    published = JSON.parse(readFileSync(publishedFile, 'utf8'));
  } catch (e) {
    console.log(`公開中の version.json を読めません（${e.message}）。すべて公開し直します`);
  }
}
const known = published?.files || {};
const changed = Object.keys(current).filter((k) => known[k] !== current[k]);
const summary = `データ ${bundle.generatedAt}（確認 ${bundle.checkedAt || '—'}）・${(bundle.days || []).length}日・アーカイブ ${dayFiles.length}日・コミット ${commit}`;
if (published && !changed.length) {
  console.log(`変化なし：${summary}`);
  console.log('UNCHANGED');
  process.exit(0);
}

// 4) 送るファイル：ページ（file_path）・data.json・アーカイブの一覧・変わった日（新しい日から上限まで）・version.json
const files = {};
const send = (key, file) => (files[key] = abs(file));
if (changed.includes('data.json')) send('data.json', 'dist/data.json');
if (changed.includes('days/index.json')) send('days/index.json', 'dist/days/index.json');
let budget = DAYS_BUDGET;
let deferred = 0;
for (const f of [...dayFiles].reverse()) {
  const key = `days/${f}`;
  if (!changed.includes(key)) continue;
  const size = readFileSync(path.join(distDays, f)).length;
  if (size > budget) {
    deferred++;
    continue;
  }
  budget -= size;
  send(key, `dist/days/${f}`);
}
// version.json の files は公開したあとの Artifact の中身：送らなかったファイルは前の値のまま（次の回に違いとして送る）
const filesAfter = { page: current.page };
for (const k of Object.keys(current)) {
  if (files[k]) filesAfter[k] = current[k];
  else if (known[k] && k !== 'page') filesAfter[k] = known[k];
}
const version = {
  signature: `${bundle.generatedAt}|${commit}|${dayFiles.length}`,
  generatedAt: bundle.generatedAt,
  checkedAt: bundle.checkedAt || null,
  commit,
  days: (bundle.days || []).map((d) => `${d.date}:${d.races.length}${d.races.some((r) => r.provisional) ? 'p' : ''}`),
  archive: dayFiles.length,
  files: filesAfter,
  builtAt: new Date().toISOString(),
};
writeFileSync(abs('dist/version.json'), JSON.stringify(version, null, 1));
send('version.json', 'dist/version.json');

const isDay = (k) => /^days\/\d{4}-\d{2}-\d{2}\.json$/.test(k);
const sentDays = Object.keys(files).filter(isDay).length;
const named = ['ページ', ...Object.keys(files).filter((k) => !isDay(k))];
if (sentDays) named.push(`アーカイブ ${sentDays}日`);
const changedDays = changed.filter(isDay).length;
console.log(summary);
const label = (k) => (k === 'page' ? 'ページ' : k);
console.log(`変わったもの：${[...changed.filter((k) => !isDay(k)).map(label), ...(changedDays ? [`アーカイブ ${changedDays}日`] : [])].join('・')}`);
console.log(`公開するファイル：${named.join('・')}${deferred ? `（ほかに変わった ${deferred}日は次の回）` : ''}`);
console.log(`SIGNATURE=${version.signature}`);
console.log(`FILE_PATH=${abs('dist/artifact.html')}`);
console.log(`FILES=${JSON.stringify(files)}`);

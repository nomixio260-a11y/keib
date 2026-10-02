#!/usr/bin/env node
// 1ファイルで動く HTML を作る。
//   dist/index.html    … そのまま開ける完全な HTML（ローカル・Cloudflare Tunnel 用）
//   dist/artifact.html … <html>/<head>/<body> を省いた断片（claude.ai の Artifact 公開用）
//   dist/data.json     … 実データ（data/bundle.json があるときだけコピー。npm run build-data で作る）
//
//   npm run build          … ビルド
//   npm run dev            … 変更を監視して自動でビルド

import { build, transform } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => path.join(root, p);

const TITLE = 'KEIB 競馬予想';
const DESCRIPTION = 'JRAの実際の出馬表・オッズ・結果から、スピード指数・展開・適性を数値化し、モンテカルロ・シミュレーションで勝率と期待値を出す競馬予想ソフト';
const FONTS = [
  '<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@500;600;700&family=Dela+Gothic+One&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap">',
].join('\n');

async function buildOnce() {
  const t0 = Date.now();
  const js = await build({
    entryPoints: [r('src/main.js')],
    bundle: true,
    format: 'iife',
    minify: true,
    write: false,
    target: ['es2020'],
    charset: 'utf8',
    legalComments: 'none',
  });
  const script = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = await transform(await readFile(r('src/styles.css'), 'utf8'), { loader: 'css', minify: true, charset: 'utf8' });
  const body = (await readFile(r('src/app.html'), 'utf8')).trim();
  const head = [`<title>${TITLE}</title>`, `<meta name="description" content="${DESCRIPTION}">`, FONTS, `<style>${css.code.trim()}</style>`].join('\n');

  const fragment = `${head}\n${body}\n<script>${script}</script>\n`;
  const full = [
    '<!doctype html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="color-scheme" content="light dark">',
    head,
    '</head>',
    '<body>',
    body,
    `<script>${script}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');

  await mkdir(r('dist'), { recursive: true });
  await writeFile(r('dist/index.html'), full);
  await writeFile(r('dist/artifact.html'), fragment);
  // 実データ（data/bundle.json）があれば一緒に置く。公開リポジトリ・GitHub Pages には含めない
  const bundle = process.env.KEIB_BUNDLE || r('data/bundle.json');
  if (existsSync(bundle)) await copyFile(bundle, r('dist/data.json'));
  const kb = (Buffer.byteLength(full) / 1024).toFixed(0);
  console.log(`ビルド完了 dist/index.html（${kb} KB）・dist/artifact.html  ${Date.now() - t0}ms`);
}

await buildOnce();

if (process.argv.includes('--watch')) {
  let timer = null;
  console.log('src/ を監視しています（Ctrl+C で終了）');
  watch(r('src'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => buildOnce().catch((e) => console.error(e.message)), 120);
  });
}

// JRA公式サイトへの通信。1リクエストずつ間隔をあけ、失敗時は待って再試行する。
// 結果や過去の開催など変わらないページはディスクにキャッシュして、同じページを二度取りにいかない。

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';

const BASE = 'https://www.jra.go.jp';
export const USER_AGENT = 'KEIB/1.0 (+https://github.com/nomixio260-a11y/keib; personal race analysis)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dispatcherPromise = null;
/** HTTPS_PROXY などが設定されていればプロキシ経由にする */
function getDispatcher() {
  if (!dispatcherPromise) {
    const hasProxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((k) => process.env[k]);
    dispatcherPromise = hasProxy ? import('undici').then((m) => new m.EnvHttpProxyAgent()) : Promise.resolve(undefined);
  }
  return dispatcherPromise;
}

/** JRADB のページ種別ごとの URL */
export function pathForCname(cname) {
  const c = String(cname);
  if (/^pw01d/.test(c)) return '/JRADB/accessD.html';
  if (/^pw15/.test(c)) return '/JRADB/accessO.html';
  if (/^pw01s/.test(c)) return '/JRADB/accessS.html';
  if (/^pw01h/.test(c)) return '/JRADB/accessH.html';
  return '/JRADB/accessD.html';
}

export function createJraClient({ minIntervalMs = 1200, cacheDir = null, log = () => {}, fetchImpl = null } = {}) {
  let last = 0;
  let chain = Promise.resolve();
  let requests = 0;
  let cacheHits = 0;

  const enqueue = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  async function post(cname) {
    const url = BASE + pathForCname(cname);
    const dispatcher = await getDispatcher();
    const doFetch = fetchImpl || globalThis.fetch;
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(0, last + minIntervalMs - Date.now());
      if (wait) await sleep(wait);
      last = Date.now();
      requests++;
      try {
        const res = await doFetch(url, {
          method: 'POST',
          body: `cname=${cname}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, 'Accept-Language': 'ja' },
          redirect: 'manual',
          signal: AbortSignal.timeout(30000),
          ...(dispatcher ? { dispatcher } : {}),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (res.status !== 200) {
          const err = new Error(`HTTP ${res.status} (${cname})`);
          err.fatal = true;
          throw err;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        return new TextDecoder('shift_jis').decode(buf);
      } catch (e) {
        if (e.fatal || attempt >= 3) throw e;
        log(`再試行 ${attempt + 1}: ${e.message}`);
        await sleep(3000 * 2 ** attempt);
      }
    }
  }

  const cacheFile = (cname) => (cacheDir ? path.join(cacheDir, `${createHash('sha1').update(cname).digest('hex')}.html.gz`) : null);

  // 変わるページ（TTLつき）とディスクキャッシュがないときのページはメモリにも持つ
  const memory = new Map();
  const remember = (cname, html, at) => {
    memory.delete(cname);
    memory.set(cname, { html, at });
    if (memory.size > 400) memory.delete(memory.keys().next().value);
  };

  /**
   * ページを取得する。
   *   cache: 'forever' … 一度取ったら再取得しない（結果・過去開催）
   *   ttlMs: キャッシュの有効期間（出馬表・オッズなど変わるページ）
   */
  async function page(cname, { cache = 'none', ttlMs = 0 } = {}) {
    const fresh = (at) => cache === 'forever' || Date.now() - at < ttlMs;
    if (cache !== 'none') {
      const m = memory.get(cname);
      if (m && fresh(m.at)) {
        cacheHits++;
        return m.html;
      }
      const file = cacheFile(cname);
      if (file) {
        try {
          const st = await stat(file);
          if (fresh(st.mtimeMs)) {
            cacheHits++;
            const html = gunzipSync(await readFile(file)).toString('utf8');
            if (cache !== 'forever') remember(cname, html, st.mtimeMs);
            return html;
          }
        } catch {
          // キャッシュなし
        }
      }
    }
    const html = await enqueue(() => post(cname));
    if (cache !== 'none') {
      const file = cacheFile(cname);
      if (cache !== 'forever' || !file) remember(cname, html, Date.now());
      if (file) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, gzipSync(html));
      }
    }
    return html;
  }

  /** そのページを最後に取得した時刻（ms）。メモリにないときは null */
  const fetchedAt = (cname) => memory.get(cname)?.at ?? null;

  return { page, fetchedAt, stats: () => ({ requests, cacheHits }) };
}

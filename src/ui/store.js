// localStorage の安全なラッパー（使えない環境でもアプリは動く）

const KEY = 'keib:v1';

export function loadState() {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

let timer = null;
export function saveState(state) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // 保存できなくても動作には影響しない
    }
  }, 250);
}

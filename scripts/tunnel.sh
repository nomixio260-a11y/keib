#!/usr/bin/env bash
# Cloudflare Tunnel（Quick Tunnel）で、手元の PC で動かしたリアルタイム版 KEIB を一時的に外から見られるようにする。
#   npm run tunnel
# 表示される https://xxxx.trycloudflare.com を自分のスマホなどで開けます。Ctrl+C で終了。
# URL を知っている人は誰でも見られます。JRA のデータを表示するので、URL は自分だけで使ってください。
#
# 事前に cloudflared をインストールしてください:
#   macOS:   brew install cloudflared
#   Windows: winget install --id Cloudflare.cloudflared
#   Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8080}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared が見つかりません。上のコメントの手順でインストールしてから、もう一度実行してください。" >&2
  exit 1
fi

npm run build
PORT="$PORT" node scripts/server.mjs &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

sleep 1
echo "Cloudflare Tunnel を起動します。表示された https://...trycloudflare.com の URL を開いてください。"
cloudflared tunnel --url "http://localhost:${PORT}"

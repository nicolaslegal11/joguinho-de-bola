#!/usr/bin/env bash
# Sobe o servidor do jogo e um túnel público do Cloudflare.
# Uso: ./start-online.sh
set -euo pipefail

cd "$(dirname "$0")"

PORT="${QUADRA_PORT:-8083}"
RUN_DIR="${QUADRA_RUN_DIR:-/tmp/opencode}"
SERVER_LOG="$RUN_DIR/quadra-server.log"
TUNNEL_LOG="$RUN_DIR/quadra-tunnel.log"
PID_FILE="$RUN_DIR/quadra-tunnel.pid"
URL_FILE="$RUN_DIR/quadra-url.txt"

mkdir -p "$RUN_DIR"

if ! curl -sf --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null; then
    echo "Iniciando servidor na porta $PORT..."
    PORT="$PORT" nohup node server.js >"$SERVER_LOG" 2>&1 < /dev/null &
    for _ in $(seq 1 20); do
        if curl -sf --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null; then
            break
        fi
        sleep 0.25
    done
fi

if ! curl -sf --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null; then
    echo "O servidor não respondeu na porta $PORT. Veja $SERVER_LOG"
    exit 1
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null && [ -f "$URL_FILE" ]; then
    echo "Túnel já está ativo: $(cat "$URL_FILE")"
    exit 0
fi

echo "Abrindo túnel Cloudflare..."
: >"$TUNNEL_LOG"
nohup cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate >"$TUNNEL_LOG" 2>&1 < /dev/null &
echo $! >"$PID_FILE"

URL=""
for _ in $(seq 1 60); do
    URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n 1 || true)
    if [ -n "$URL" ]; then
        break
    fi
    sleep 0.5
done

if [ -z "$URL" ]; then
    echo "Não consegui criar o túnel. Últimas linhas do log:"
    tail -n 25 "$TUNNEL_LOG"
    exit 1
fi

echo "$URL" >"$URL_FILE"
echo
echo "============================================"
echo "  Jogo online: $URL"
echo "============================================"
echo
echo "Abra o link, digite seu nome, crie uma sala e"
echo "compartilhe o código (ou o link ?sala=XXXX)."
echo
echo "Para parar o túnel: kill \$(cat $PID_FILE)"
echo "Para parar o servidor: pkill -f 'node server.js'"

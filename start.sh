#!/bin/bash

# Railway healthcheck 통과를 위해 앱 포트를 먼저 연다.
export WEBHOOK_PORT="${PORT:-${WEBHOOK_PORT:-8787}}"

# Litecoin Core 시작
echo "Litecoin Core 시작..."
litecoind -conf=/root/.litecoin/litecoin.conf -daemon || true

# 지갑 준비는 백그라운드에서 재시도 (앱 기동 지연 방지)
(
  WALLET_NAME="${LITECOIN_RPC_WALLET:-default}"
  echo "지갑 로드 시도: ${WALLET_NAME}"

  if [ "${WALLET_NAME}" != "default" ]; then
    mkdir -p "/root/.litecoin/wallets/${WALLET_NAME}"
    if [ ! -f "/root/.litecoin/wallets/${WALLET_NAME}/wallet.dat" ] && [ -f "/root/.litecoin/wallets/default/wallet.dat" ]; then
      cp "/root/.litecoin/wallets/default/wallet.dat" "/root/.litecoin/wallets/${WALLET_NAME}/wallet.dat"
      chmod 600 "/root/.litecoin/wallets/${WALLET_NAME}/wallet.dat" || true
    fi
  fi

  i=0
  until litecoin-cli -conf=/root/.litecoin/litecoin.conf loadwallet "${WALLET_NAME}" >/dev/null 2>&1; do
    i=$((i+1))
    if [ $i -ge 30 ]; then
      echo "지갑 로드 실패(30회 재시도). 이후 RPC 미연동으로 동작할 수 있습니다."
      break
    fi
    sleep 2
  done

  if [ -n "$WALLET_PASSWORD" ]; then
    litecoin-cli -conf=/root/.litecoin/litecoin.conf walletpassphrase "$WALLET_PASSWORD" 60 >/dev/null 2>&1 || true
  fi

  echo "지갑 상태 확인..."
  litecoin-cli -conf=/root/.litecoin/litecoin.conf getwalletinfo || true
) &

# Discord 봇 시작 (health endpoint 포함)
echo "Discord 봇 시작..."
cd /app
node index.js

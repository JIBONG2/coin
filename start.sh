#!/bin/bash

# Litecoin Core 시작
echo "Litecoin Core 시작..."
litecoind -conf=/root/.litecoin/litecoin.conf -daemon

# 블록체인 동기화 대기
echo "블록체인 동기화 대기..."
sleep 60

# 지갑 로드 (Litecoin Core 0.21+는 기본 지갑 자동 로드 안 됨)
WALLET_NAME="${LITECOIN_RPC_WALLET:-default}"
echo "지갑 로드 시도: ${WALLET_NAME}"

# 이미지에는 wallet.dat를 default 경로로 복사해 두므로,
# 런타임 지갑명이 다르면(default -> juju 등) 대상 폴더로 1회 복사
if [ "${WALLET_NAME}" != "default" ]; then
    mkdir -p "/root/.litecoin/wallets/${WALLET_NAME}"
    if [ ! -f "/root/.litecoin/wallets/${WALLET_NAME}/wallet.dat" ] && [ -f "/root/.litecoin/wallets/default/wallet.dat" ]; then
        cp "/root/.litecoin/wallets/default/wallet.dat" "/root/.litecoin/wallets/${WALLET_NAME}/wallet.dat"
        chmod 600 "/root/.litecoin/wallets/${WALLET_NAME}/wallet.dat" || true
    fi
fi

litecoin-cli -conf=/root/.litecoin/litecoin.conf loadwallet "${WALLET_NAME}" >/dev/null 2>&1 || true

# 지갑 잠금 해제 (비밀번호가 있는 경우)
if [ -n "$WALLET_PASSWORD" ]; then
    echo "지갑 잠금 해제..."
    litecoin-cli -conf=/root/.litecoin/litecoin.conf walletpassphrase "$WALLET_PASSWORD" 60
fi

# 지갑 상태 확인
echo "지갑 상태 확인..."
litecoin-cli -conf=/root/.litecoin/litecoin.conf getwalletinfo

# Discord 봇 시작
echo "Discord 봇 시작..."
cd /app
node index.js

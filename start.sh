#!/bin/bash

# 건강검사 서버 시작
echo "건강검사 서버 시작..."
cd /app
node health-server.js &
HEALTH_PID=$!

# Litecoin Core 시작
echo "Litecoin Core 시작..."
litecoind -conf=/root/.litecoin/litecoin.conf -daemon

# 블록체인 동기화 대기
echo "블록체인 동기화 대기..."
sleep 60

# 지갋 잠금 해제 (비밀번호가 있는 경우)
if [ -n "$WALLET_PASSWORD" ]; then
    echo "지갋 잠금 해제..."
    litecoin-cli -conf=/root/.litecoin/litecoin.conf walletpassphrase "$WALLET_PASSWORD" 60
fi

# 지갋 상태 확인
echo "지갋 상태 확인..."
litecoin-cli -conf=/root/.litecoin/litecoin.conf getwalletinfo

# Discord 봇 시작
echo "Discord 봇 시작..."
cd /app
node index.js

echo "모든 서비스 실행 완료!"

# 프로세스 유지
wait $HEALTH_PID

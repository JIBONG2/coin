# Railway LTC 봇 프로젝트

## 구조
- `bot/` - Discord 봇 코드
- `litecoin-node/` - LTC 노드 설정
- `wallet.dat` - 지갋 파일 (직접 추가 필요)

## 배포 순서
1. wallet.dat 파일을 litecoin-node/ 폴더에 추가
2. GitHub에 푸시
3. Railway에서 프로젝트 연결
4. 환경 변수 설정

## 환경 변수
- `DISCORD_TOKEN` - Discord 봇 토큰
- `WALLET_PASSWORD` - 지갋 비밀번호 (있는 경우)
- `WEBHOOK_SECRET` - 웹훅 비밀키
- `WEBHOOK_PORT` - 8787

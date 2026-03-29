FROM ubuntu:22.04

# Litecoin Core 설치
RUN apt-get update && apt-get install -y wget ca-certificates curl gnupg

# Litecoin Core 다운로드 및 설치
RUN wget https://download.litecoin.org/litecoin-0.21.2.1/linux/litecoin-0.21.2.1-x86_64-linux-gnu.tar.gz
RUN tar xzf litecoin-*.tar.gz
RUN install -m 0755 litecoin-0.21.2.1/bin/* /usr/local/bin/

# 설정 파일 디렉토리 생성
RUN mkdir -p /root/.litecoin/wallets/default

# 설정 파일 복사
COPY litecoin.conf /root/.litecoin/
COPY wallet.dat /root/.litecoin/wallets/default/wallet.dat

# 권한 설정
RUN chmod 600 /root/.litecoin/wallets/default/wallet.dat
RUN chmod 600 /root/.litecoin/litecoin.conf

# 포트 노출
EXPOSE 9332 9333

# Litecoin Core 시작
CMD ["litecoind", "-conf=/root/.litecoin/litecoin.conf"]

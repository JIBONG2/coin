const http = require('http');
const https = require('https');
const { URL } = require('url');

function getFeeRate() {
  const n = Number(process.env.LTC_PLATFORM_FEE_RATE);
  if (Number.isFinite(n) && n >= 0 && n < 1) return n;
  return 0.03;
}

function roundLtc8(amount) {
  const x = Number(amount);
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.round(x * 1e8) / 1e8;
}

/** 총 LTC에서 플랫폼 수수료를 뺀 전송 수량 */
function netLtcAfterPlatformFee(grossLtc) {
  const r = getFeeRate();
  return roundLtc8(Number(grossLtc) * (1 - r));
}

/** 등급별 수수료율(0~1) 적용 */
function netLtcAfterFee(grossLtc, feeRate) {
  const r = Number(feeRate);
  const eff = Number.isFinite(r) && r >= 0 && r < 1 ? r : 0.06;
  return roundLtc8(Number(grossLtc) * (1 - eff));
}

function isDryRun() {
  const v = String(process.env.LTC_DRY_RUN || '').trim();
  return v === '1' || v.toLowerCase() === 'true';
}

/** 메인넷 LTC 주소 단순 검증(오타 방지용, 완전 검증은 아님) */
function validateLtcAddress(addr) {
  const a = String(addr || '').trim();
  if (a.length < 26 || a.length > 95) return false;
  if (/^ltc1[a-z0-9]{39,87}$/i.test(a)) return true;
  if (/^[LM3][a-km-zA-HJ-NP-Z1-9]{25,94}$/.test(a)) return true;
  return false;
}

/** 멀티월렛 시 `juju` 등 — URL에 `/wallet/이름` 자동 부착 */
function getEffectiveLtcRpcUrl() {
  const raw = process.env.LITECOIN_RPC_URL || '';
  if (!raw) return '';
  const w = process.env.LITECOIN_RPC_WALLET && String(process.env.LITECOIN_RPC_WALLET).trim();
  if (!w) return raw;
  try {
    const u = new URL(raw);
    let path = (u.pathname || '/').replace(/\/+$/, '');
    if (/\/wallet\//i.test(path)) return raw;
    if (path === '/') path = '';
    u.pathname = `${path ? path + '/' : ''}wallet/${encodeURIComponent(w)}`.replace(/\/+/g, '/');
    if (!u.pathname.startsWith('/')) u.pathname = `/${u.pathname}`;
    return u.toString();
  } catch {
    return raw;
  }
}

function rpcCall(method, params) {
  const urlStr = getEffectiveLtcRpcUrl();
  if (!urlStr) return Promise.reject(new Error('LITECOIN_RPC_URL 미설정'));
  const url = new URL(urlStr);
  const user = process.env.LITECOIN_RPC_USER || '';
  const pass = process.env.LITECOIN_RPC_PASSWORD || '';
  const body = JSON.stringify({
    jsonrpc: '1.0',
    id: 'ltc-vending',
    method,
    params: params || [],
  });
  const lib = url.protocol === 'https:' ? https : http;
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const opts = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname || '/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Authorization: `Basic ${auth}`,
    },
  };

  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) reject(new Error(j.error.message || String(j.error)));
          else resolve(j.result);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * @returns {Promise<string>} txid
 */
let _balanceErrorLoggedAt = 0;

/**
 * RPC 연동 시 핫월렛 LTC 잔액. 미설정/실패 시 null
 * - 미확인(mempool) 입금까지 반영: getbalances 우선, 이어 getbalance(..., 0)
 * - 예전 코드는 getbalance()만 먼저 써서 minconf 기본값 때문에 입금 직후 잔액이 안 올라가는 것처럼 보였음
 */
async function getWalletBalanceLtc() {
  const urlStr = getEffectiveLtcRpcUrl();
  if (!urlStr) return null;
  const tries = [
    async () => {
      const j = await rpcCall('getbalances', []);
      if (!j || typeof j !== 'object' || !j.mine || typeof j.mine !== 'object') {
        throw new Error('getbalances 형식 아님');
      }
      const m = j.mine;
      const trusted = Number(m.trusted);
      const pending = Number(m.untrusted_pending);
      const immature = Number(m.immature);
      const t = Number.isFinite(trusted) ? trusted : 0;
      const p = Number.isFinite(pending) ? pending : 0;
      const i = Number.isFinite(immature) ? immature : 0;
      return t + p + i;
    },
    () => rpcCall('getbalance', ['*', 0, true]),
    () => rpcCall('getbalance', ['*', 0]),
    () => rpcCall('getbalance', []),
  ];
  for (const fn of tries) {
    try {
      const bal = await fn();
      const n = Number(bal);
      if (Number.isFinite(n) && n >= 0) return n;
    } catch (e) {
      const now = Date.now();
      if (now - _balanceErrorLoggedAt > 60_000) {
        _balanceErrorLoggedAt = now;
        console.warn('[LTC RPC] 잔액 조회 실패 (getbalances·getbalance 순차 시도):', e.message || e);
      }
    }
  }
  return null;
}

/**
 * sendtoaddress 1건 기준 추정 온체인 수수료(LTC). estimatesmartfee 실패 시 env 폴백.
 * 대행 수수료 0%인 송금에서 수령액에서 빼 노드가 부담할 네트워크 비용을 상쇄.
 */
async function getEstimatedOnChainSendFeeLtc() {
  const fbRaw = Number(process.env.LTC_ONCHAIN_FEE_FALLBACK_LTC);
  const fallback = Number.isFinite(fbRaw) && fbRaw > 0 ? fbRaw : 0.0001;
  if (isDryRun()) return roundLtc8(fallback);
  const kb = Number(process.env.LTC_EST_TX_SIZE_KB);
  const txKb = Number.isFinite(kb) && kb > 0 ? kb : 0.28;
  try {
    const res = await rpcCall('estimatesmartfee', [6]);
    if (!res || (Array.isArray(res.errors) && res.errors.length)) {
      throw new Error(res?.errors?.join?.() || 'estimatesmartfee');
    }
    const feerate = Number(res.feerate);
    if (!Number.isFinite(feerate) || feerate < 0) throw new Error('feerate');
    const fee = feerate * txKb;
    return roundLtc8(Math.max(fallback, fee));
  } catch {
    return roundLtc8(fallback);
  }
}

async function sendLtcToAddress(address, amountLtc) {
  if (isDryRun()) {
    const fake = `dryrun_${Date.now().toString(36)}`;
    console.log('[LTC DRY_RUN] sendtoaddress', address, amountLtc, '→', fake);
    return fake;
  }
  const amt = roundLtc8(amountLtc);
  if (amt <= 0) throw new Error('전송 수량이 0 이하입니다.');
  const txid = await rpcCall('sendtoaddress', [address, amt]);
  return String(txid);
}

module.exports = {
  getFeeRate,
  roundLtc8,
  netLtcAfterPlatformFee,
  netLtcAfterFee,
  validateLtcAddress,
  getWalletBalanceLtc,
  getEstimatedOnChainSendFeeLtc,
  sendLtcToAddress,
  isDryRun,
};

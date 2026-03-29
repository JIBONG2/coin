const http = require('http');
const https = require('https');
const { URL } = require('url');

function getFeeRate() {
  const n = Number(process.env.LTC_PLATFORM_FEE_RATE);
  if (Number.isFinite(n) && n >= 0 && n < 1) return n;
  return 0.03;
}

function roundBtc8(amount) {
  const x = Number(amount);
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.round(x * 1e8) / 1e8;
}

function netBtcAfterPlatformFee(grossBtc) {
  return roundBtc8(Number(grossBtc) * (1 - getFeeRate()));
}

function netBtcAfterFee(grossBtc, feeRate) {
  const r = Number(feeRate);
  const eff = Number.isFinite(r) && r >= 0 && r < 1 ? r : 0.06;
  return roundBtc8(Number(grossBtc) * (1 - eff));
}

function isDryRun() {
  const v = String(process.env.LTC_DRY_RUN || '').trim();
  return v === '1' || v.toLowerCase() === 'true';
}

function validateBtcAddress(addr) {
  const a = String(addr || '').trim();
  if (a.length < 26 || a.length > 90) return false;
  if (/^bc1[a-z0-9]{25,87}$/i.test(a)) return true;
  if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,50}$/.test(a)) return true;
  return false;
}

function rpcCall(method, params) {
  const urlStr = process.env.BITCOIN_RPC_URL || '';
  if (!urlStr) return Promise.reject(new Error('BITCOIN_RPC_URL 미설정'));
  const url = new URL(urlStr);
  const user = process.env.BITCOIN_RPC_USER || '';
  const pass = process.env.BITCOIN_RPC_PASSWORD || '';
  const body = JSON.stringify({
    jsonrpc: '1.0',
    id: 'btc-vending',
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

async function getWalletBalanceBtc() {
  const urlStr = process.env.BITCOIN_RPC_URL || '';
  if (!urlStr) return null;
  try {
    const bal = await rpcCall('getbalance', ['*']);
    const n = Number(bal);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** BTC sendtoaddress 1건 추정 네트워크 수수료 */
async function getEstimatedOnChainSendFeeBtc() {
  const fbRaw = Number(process.env.BTC_ONCHAIN_FEE_FALLBACK_BTC);
  const fallback = Number.isFinite(fbRaw) && fbRaw > 0 ? fbRaw : 0.00005;
  if (isDryRun()) return roundBtc8(fallback);
  const kb = Number(process.env.BTC_EST_TX_SIZE_KB);
  const txKb = Number.isFinite(kb) && kb > 0 ? kb : 0.28;
  try {
    const res = await rpcCall('estimatesmartfee', [6]);
    if (!res || (Array.isArray(res.errors) && res.errors.length)) {
      throw new Error(res?.errors?.join?.() || 'estimatesmartfee');
    }
    const feerate = Number(res.feerate);
    if (!Number.isFinite(feerate) || feerate < 0) throw new Error('feerate');
    const fee = feerate * txKb;
    return roundBtc8(Math.max(fallback, fee));
  } catch {
    return roundBtc8(fallback);
  }
}

async function sendBtcToAddress(address, amountBtc) {
  if (isDryRun()) {
    const fake = `dryrun_btc_${Date.now().toString(36)}`;
    console.log('[BTC DRY_RUN] sendtoaddress', address, amountBtc, '→', fake);
    return fake;
  }
  const amt = roundBtc8(amountBtc);
  if (amt <= 0) throw new Error('전송 수량이 0 이하입니다.');
  const txid = await rpcCall('sendtoaddress', [address, amt]);
  return String(txid);
}

module.exports = {
  getFeeRate,
  roundBtc8,
  netBtcAfterPlatformFee,
  netBtcAfterFee,
  validateBtcAddress,
  getWalletBalanceBtc,
  getEstimatedOnChainSendFeeBtc,
  sendBtcToAddress,
  isDryRun,
};

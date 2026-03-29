/**
 * 빗썸·CoinGecko·업비트 직접 LTC/KRW + 실패 시 LTC/USDT×USDT/KRW 간접 시세
 */

const REQ_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (compatible; LTC-VendingBot/1.0)',
};

const FETCH_TIMEOUT_MS = 20000;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: REQ_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`http ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('invalid json');
  }
}

async function withRetry(fn, attempts = RETRY_ATTEMPTS) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await sleep(RETRY_BASE_MS * (i + 1));
    }
  }
  throw last;
}

async function safePrice(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function fetchBithumbLtcKrw() {
  return withRetry(async () => {
    const j = await fetchJson('https://api.bithumb.com/public/ticker/LTC_KRW');
    if (j.status !== '0000') throw new Error(String(j.message || 'bithumb'));
    const n = Number(j.data?.closing_price);
    if (!Number.isFinite(n) || n <= 0) throw new Error('bithumb price');
    return n;
  });
}

async function fetchCoingeckoLtcKrw() {
  return withRetry(async () => {
    const j = await fetchJson(
      'https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=krw'
    );
    if (j.status?.error_code === 429) throw new Error('coingecko rate limit');
    const n = Number(j.litecoin?.krw);
    if (!Number.isFinite(n) || n <= 0) throw new Error('coingecko');
    return n;
  });
}

async function fetchCryptoCompareLtcKrw() {
  return withRetry(async () => {
    const j = await fetchJson('https://min-api.cryptocompare.com/data/price?fsym=LTC&tsyms=KRW');
    const n = Number(j.KRW);
    if (!Number.isFinite(n) || n <= 0) throw new Error('cryptocompare ltc krw');
    return n;
  });
}

async function fetchUpbitLtcKrw() {
  return withRetry(async () => {
    const j = await fetchJson('https://api.upbit.com/v1/ticker?markets=KRW-LTC');
    if (!Array.isArray(j) || !j[0]) throw new Error('upbit shape');
    const n = Number(j[0].trade_price);
    if (!Number.isFinite(n) || n <= 0) throw new Error('upbit price');
    return n;
  });
}

async function fetchBinanceLtcUsdt() {
  return withRetry(async () => {
    const j = await fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=LTCUSDT');
    const n = Number(j.price);
    if (!Number.isFinite(n) || n <= 0) throw new Error('binance ltc');
    return n;
  });
}

async function fetchBybitLtcUsdt() {
  return withRetry(async () => {
    const j = await fetchJson('https://api.bybit.com/v5/market/tickers?category=spot&symbol=LTCUSDT');
    const row = j.result?.list?.[0];
    const n = Number(row?.lastPrice);
    if (!Number.isFinite(n) || n <= 0) throw new Error('bybit ltc');
    return n;
  });
}

async function fetchSpotLtcUsdt() {
  try {
    const price = await fetchBinanceLtcUsdt();
    return { price, venue: 'binance' };
  } catch {
    const price = await fetchBybitLtcUsdt();
    return { price, venue: 'bybit' };
  }
}

async function fetchBithumbUsdtKrw() {
  return withRetry(async () => {
    const j = await fetchJson('https://api.bithumb.com/public/ticker/USDT_KRW');
    if (j.status !== '0000') throw new Error(String(j.message || 'bithumb usdt'));
    const n = Number(j.data?.closing_price);
    if (!Number.isFinite(n) || n <= 0) throw new Error('bithumb usdt');
    return n;
  });
}

async function fetchUpbitUsdtKrw() {
  return withRetry(async () => {
    const j = await fetchJson('https://api.upbit.com/v1/ticker?markets=KRW-USDT');
    if (!Array.isArray(j) || !j[0]) throw new Error('upbit usdt shape');
    const n = Number(j[0].trade_price);
    if (!Number.isFinite(n) || n <= 0) throw new Error('upbit usdt');
    return n;
  });
}

async function fetchSpotUsdtKrw() {
  try {
    const price = await fetchBithumbUsdtKrw();
    return { price, venue: 'bithumb' };
  } catch {
    const price = await fetchUpbitUsdtKrw();
    return { price, venue: 'upbit' };
  }
}

/**
 * LTC/USDT(바이낸스→바이빗) × USDT/KRW(빗썸→업비트)
 * @returns {{ ltcKrw: number, ltcUsdt: number, usdtKrw: number, ltcVenue: string, usdtVenue: string }}
 */
async function fetchIndirectLtcKrwDetail() {
  const { price: ltcUsdt, venue: ltcVenue } = await fetchSpotLtcUsdt();
  const { price: usdtKrw, venue: usdtVenue } = await fetchSpotUsdtKrw();
  const ltcKrw = ltcUsdt * usdtKrw;
  if (!Number.isFinite(ltcKrw) || ltcKrw <= 0) throw new Error('indirect ltc/krw');
  return { ltcKrw, ltcUsdt, usdtKrw, ltcVenue, usdtVenue };
}

async function fetchIndirectLtcKrw() {
  const d = await fetchIndirectLtcKrwDetail();
  return d.ltcKrw;
}

/**
 * @returns {{
 *   bithumbKrw: number|null,
 *   coingeckoKrw: number|null,
 *   upbitKrw: number|null,
 *   refKrw: number|null,
 *   kimchiPremiumPercent: number|null,
 *   kimchiCompareNote: string|null,
 *   cryptoCompareKrw: number|null,
 *   indirect: { ltcKrw: number, ltcUsdt: number, usdtKrw: number, ltcVenue: string, usdtVenue: string }|null,
 *   fetchedAt: number
 * }}
 */
async function getMarketSnapshot() {
  const fetchedAt = Date.now();

  const [bithumbKrw, coingeckoKrw, upbitKrw, cryptoCompareKrw] = await Promise.all([
    safePrice(() => fetchBithumbLtcKrw()),
    safePrice(() => fetchCoingeckoLtcKrw()),
    safePrice(() => fetchUpbitLtcKrw()),
    safePrice(() => fetchCryptoCompareLtcKrw()),
  ]);

  let refKrw = Number.isFinite(bithumbKrw)
    ? bithumbKrw
    : Number.isFinite(coingeckoKrw)
      ? coingeckoKrw
      : Number.isFinite(upbitKrw)
        ? upbitKrw
        : Number.isFinite(cryptoCompareKrw)
          ? cryptoCompareKrw
          : null;

  let indirect = null;
  if (refKrw == null) {
    try {
      const d = await fetchIndirectLtcKrwDetail();
      indirect = {
        ltcKrw: d.ltcKrw,
        ltcUsdt: d.ltcUsdt,
        usdtKrw: d.usdtKrw,
        ltcVenue: d.ltcVenue,
        usdtVenue: d.usdtVenue,
      };
      refKrw = d.ltcKrw;
    } catch {
      indirect = null;
    }
  }

  const globalRefKrw =
    Number.isFinite(coingeckoKrw) && coingeckoKrw > 0
      ? coingeckoKrw
      : Number.isFinite(cryptoCompareKrw) && cryptoCompareKrw > 0
        ? cryptoCompareKrw
        : null;
  const globalRefLabel =
    Number.isFinite(coingeckoKrw) && coingeckoKrw > 0
      ? 'CoinGecko'
      : Number.isFinite(cryptoCompareKrw) && cryptoCompareKrw > 0
        ? 'CryptoCompare'
        : null;

  let kimchiPremiumPercent = null;
  let kimchiCompareNote = null;

  if (globalRefKrw != null && globalRefLabel != null) {
    const domesticSpot =
      Number.isFinite(bithumbKrw) && bithumbKrw > 0
        ? bithumbKrw
        : Number.isFinite(upbitKrw) && upbitKrw > 0
          ? upbitKrw
          : null;

    if (domesticSpot != null) {
      kimchiPremiumPercent = ((domesticSpot - globalRefKrw) / globalRefKrw) * 100;
      const domLabel = Number.isFinite(bithumbKrw) && bithumbKrw > 0 ? '빗썸' : '업비트';
      kimchiCompareNote = `(${domLabel} vs ${globalRefLabel} KRW)`;
    } else {
      let impliedKrw = indirect?.ltcKrw;
      if (impliedKrw == null) {
        try {
          const d = await fetchIndirectLtcKrwDetail();
          impliedKrw = d.ltcKrw;
        } catch {
          impliedKrw = null;
        }
      }
      if (impliedKrw != null && globalRefKrw > 0) {
        kimchiPremiumPercent = ((impliedKrw - globalRefKrw) / globalRefKrw) * 100;
        kimchiCompareNote = `(국내 USDT 반영 간접가 vs ${globalRefLabel} KRW)`;
      }
    }
  }

  return {
    bithumbKrw: Number.isFinite(bithumbKrw) ? bithumbKrw : null,
    coingeckoKrw: Number.isFinite(coingeckoKrw) ? coingeckoKrw : null,
    upbitKrw: Number.isFinite(upbitKrw) ? upbitKrw : null,
    cryptoCompareKrw: Number.isFinite(cryptoCompareKrw) ? cryptoCompareKrw : null,
    refKrw: Number.isFinite(refKrw) ? refKrw : null,
    kimchiPremiumPercent,
    kimchiCompareNote,
    indirect,
    fetchedAt,
  };
}

async function fetchBithumbBtcKrw() {
  return withRetry(async () => {
    const j = await fetchJson('https://api.bithumb.com/public/ticker/BTC_KRW');
    if (j.status !== '0000') throw new Error(String(j.message || 'bithumb btc'));
    const n = Number(j.data?.closing_price);
    if (!Number.isFinite(n) || n <= 0) throw new Error('bithumb btc price');
    return n;
  });
}

/** @param {'ltc'|'btc'} coin */
async function fetchBithumbCoinKrw(coin) {
  if (coin === 'btc') return fetchBithumbBtcKrw();
  return fetchBithumbLtcKrw();
}

module.exports = {
  getMarketSnapshot,
  fetchBithumbLtcKrw,
  fetchBithumbBtcKrw,
  fetchBithumbCoinKrw,
  fetchCoingeckoLtcKrw,
  fetchCryptoCompareLtcKrw,
  fetchUpbitLtcKrw,
  fetchIndirectLtcKrw,
  fetchIndirectLtcKrwDetail,
};

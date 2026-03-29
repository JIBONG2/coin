const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tiers = require('./lib/tiers');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BALANCES_FILE = path.join(DATA_DIR, 'balances.json');
const PENDING_FILE = path.join(DATA_DIR, 'pending.json');
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.json');
const VOLUME_FILE = path.join(DATA_DIR, 'cumulativeVolume.json');
const ADMINS_FILE = path.join(DATA_DIR, 'botAdmins.json');
const USER_SECURITY_FILE = path.join(DATA_DIR, 'userSecurity.json');
const SEND_DAILY_FILE = path.join(DATA_DIR, 'sendDailyByUser.json');

/** 1회 송금 원화 상한 (고정). 1일 한도와 별도로 항상 적용 */
const PER_TX_SEND_MAX_KRW = 500_000;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, def) {
  ensureDir();
  if (!fs.existsSync(file)) return def;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return def;
  }
}

function writeJson(file, data) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ——— 잔액 ———
function readBalances() {
  const j = readJson(BALANCES_FILE, {});
  return j && typeof j === 'object' ? j : {};
}

function writeBalances(data) {
  writeJson(BALANCES_FILE, data);
}

function getBalance(guildId, userId) {
  const g = String(guildId);
  const u = String(userId);
  const all = readBalances();
  const row = all[g];
  if (!row || typeof row !== 'object') return 0;
  const n = Number(row[u]);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function addBalance(guildId, userId, amountKrw) {
  const add = Math.floor(Number(amountKrw) || 0);
  if (add <= 0) return getBalance(guildId, userId);
  const g = String(guildId);
  const u = String(userId);
  const all = readBalances();
  if (!all[g]) all[g] = {};
  const cur = Number(all[g][u]) || 0;
  all[g][u] = cur + add;
  writeBalances(all);
  return all[g][u];
}

function tryDeduct(guildId, userId, amountKrw) {
  const need = Math.floor(Number(amountKrw) || 0);
  if (need <= 0) return true;
  const g = String(guildId);
  const u = String(userId);
  const all = readBalances();
  if (!all[g]) all[g] = {};
  const cur = Number(all[g][u]) || 0;
  if (cur < need) return false;
  all[g][u] = cur - need;
  writeBalances(all);
  return true;
}

// ——— 장부(내정보·구매·송금 내역) ———
function appendLedger(entry) {
  const list = readJson(LEDGER_FILE, []);
  if (!Array.isArray(list)) return;
  list.push({
    id: crypto.randomBytes(8).toString('hex'),
    guildId: String(entry.guildId),
    userId: String(entry.userId),
    type: String(entry.type || 'misc'),
    text: String(entry.text || ''),
    at: entry.at || new Date().toISOString(),
    meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : undefined,
  });
  if (list.length > 5000) list.splice(0, list.length - 5000);
  writeJson(LEDGER_FILE, list);
}

function getLedgerForUser(guildId, userId, limit = 20) {
  const list = readJson(LEDGER_FILE, []);
  if (!Array.isArray(list)) return [];
  const gid = String(guildId);
  const uid = String(userId);
  return list
    .filter((e) => e && e.guildId === gid && e.userId === uid)
    .slice(-limit)
    .reverse();
}

// ——— 충전 대기 (입금자명+금액 SMS 매칭) ———
function getPendingExpireMs() {
  const m = Number(process.env.PENDING_EXPIRE_MINUTES);
  const min = Number.isFinite(m) && m > 0 ? Math.min(120, m) : 10;
  return min * 60 * 1000;
}

function getPending() {
  const raw = readJson(PENDING_FILE, []);
  return Array.isArray(raw) ? raw : [];
}

function setPending(list) {
  writeJson(PENDING_FILE, Array.isArray(list) ? list : []);
}

function findActivePendingByUser(guildId, userId) {
  const list = getPending();
  const gid = String(guildId);
  const uid = String(userId);
  return list.find((p) => p.guildId === gid && p.userId === uid && !isPendingExpired(p)) || null;
}

function isPendingExpired(pending) {
  const requested = new Date(pending.requestedAt).getTime();
  return Date.now() - requested > getPendingExpireMs();
}

function addPending(guildId, userId, depositorName, amount) {
  const list = getPending();
  const existing = findActivePendingByUser(guildId, userId);
  if (existing) return { ok: false, reason: 'already_pending', id: existing.id };
  const id = crypto.randomBytes(6).toString('hex');
  list.push({
    id,
    guildId: String(guildId),
    userId: String(userId),
    depositorName: String(depositorName).trim(),
    amount: Math.floor(Number(amount)),
    requestedAt: new Date().toISOString(),
  });
  setPending(list);
  return { ok: true, id };
}

function removePendingById(pendingId) {
  const list = getPending().filter((p) => p.id !== pendingId);
  setPending(list);
}

function getPendingById(pendingId) {
  return getPending().find((p) => p.id === pendingId) || null;
}

/** 관리자 패널「수락」— pending 제거 후 잔액 반영 */
function tryApprovePendingCharge(pendingId, approverUserId) {
  const list = getPending();
  const p = list.find((x) => x.id === pendingId);
  if (!p) return { ok: false, reason: 'not_found' };
  if (isPendingExpired(p)) {
    removePendingById(pendingId);
    return { ok: false, reason: 'expired' };
  }
  removePendingById(pendingId);
  addBalance(p.guildId, p.userId, p.amount);
  appendLedger({
    guildId: p.guildId,
    userId: p.userId,
    type: 'charge',
    text: `충전 완료 +${p.amount.toLocaleString('ko-KR')}원 (관리자 수동 승인)`,
    at: new Date().toISOString(),
    meta: {
      depositorName: p.depositorName,
      amount: p.amount,
      approverUserId: String(approverUserId),
      manualApproval: true,
    },
  });
  return {
    ok: true,
    userId: p.userId,
    guildId: p.guildId,
    amount: p.amount,
  };
}

/** 관리자 패널「거절」— pending 만 제거 */
function tryRejectPendingCharge(pendingId, rejectorUserId) {
  const list = getPending();
  const p = list.find((x) => x.id === pendingId);
  if (!p) return { ok: false, reason: 'not_found' };
  removePendingById(pendingId);
  return {
    ok: true,
    userId: p.userId,
    guildId: p.guildId,
    amount: p.amount,
    depositorName: p.depositorName,
    rejectorUserId: String(rejectorUserId),
  };
}

function depositorNamesMatch(notificationName, pendingName) {
  if (notificationName === pendingName) return true;
  if (!notificationName.includes('*')) return false;
  const escaped = notificationName.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.');
  try {
    return new RegExp('^' + escaped + '$').test(pendingName);
  } catch (_) {
    return false;
  }
}

function parseDepositMessage(message) {
  if (!message || typeof message !== 'string') return null;
  const text = message.trim();
  
  // '입금' 키워드가 없으면 무시
  if (!text.includes('입금')) return null;
  
  const amountMatch = text.match(/(\d{1,3}(?:,\d{3})*|\d+)\s*원/);
  if (!amountMatch) return null;
  const amount = parseInt(amountMatch[1].replace(/,/g, ''), 10);
  if (!(amount > 0)) return null;
  if (/토스\s*머니|토스머니/.test(text) && /님이\s*돈을\s*보냈어요/.test(text)) {
    const tossName = text.match(/([가-힣*]{2,15})님이\s*돈을\s*보냈어요/);
    if (tossName) {
      const depositorName = tossName[1].replace(/\s+/g, '').trim();
      if (depositorName) return { depositorName, amount };
    }
  }
  if (text.includes('케이뱅크') && text.includes('입금')) {
    const inlineName = text.match(/입금\s*(\d{1,3}(?:,\d{3})*|\d+)\s*원\s*([가-힣]{2,20})\s*\|/);
    if (inlineName) {
      const depositorName = inlineName[2].trim();
      if (depositorName) return { depositorName, amount };
    }
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const nameLine = lines.find((l) => /^[가-힣]+\s*\|/.test(l));
    const depositorName = nameLine ? nameLine.split(/\s*\|\s*/)[0].trim() : null;
    if (depositorName) return { depositorName, amount };
  }
  if (text.includes('카카오뱅크') && text.includes('입금')) {
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const depositLineIdx = lines.findIndex((l) => /입금\s*(\d{1,3}(?:,\d{3})*|\d+)\s*원/.test(l));
    if (depositLineIdx >= 0) {
      const afterDepositLine = lines.slice(depositLineIdx + 1).find((l) => /^[가-힣]{2,20}$/.test(l));
      if (afterDepositLine) return { depositorName: afterDepositLine, amount };
    }
    const masked = text.match(/([가-힣]\*[가-힣])\s*\(\d+\)/);
    if (masked) return { depositorName: masked[1].trim(), amount };
    const unmasked = text.match(/([가-힣]{2,4})\s*\(\d{4}\)/);
    if (unmasked) return { depositorName: unmasked[1].trim(), amount };
  }
  /** 농협 입금 예: 농협 입금1,000원 / 03/28 16:33 302-****-8626-91 이승찬 잔액1,000원 */
  if (/농협/.test(text) && /입금/.test(text)) {
    const dep = text.match(/입금\s*(\d{1,3}(?:,\d{3})*|\d+)\s*원/);
    if (dep) {
      const nhAmount = parseInt(dep[1].replace(/,/g, ''), 10);
      if (nhAmount > 0) {
        const nhLine = text.match(
          /\d{2}\/\d{2}\s+\d{2}:\d{2}\s+\S+\s+([가-힣*]{2,20})\s+잔액/
        );
        if (nhLine) {
          const depositorName = nhLine[1].replace(/\s+/g, '').trim();
          if (depositorName) return { depositorName, amount: nhAmount };
        }
        const nhName2 = text.match(/([가-힣*]{2,20})\s+잔액\s*[\d,]+\s*원/);
        if (nhName2) {
          const depositorName = nhName2[1].trim();
          if (depositorName && !/^(농협|NH|웹발신)$/.test(depositorName)) {
            return { depositorName, amount: nhAmount };
          }
        }
      }
    }
  }
  const beforeBalance = text.match(/([가-힣]{2,10})\s*잔액\s*\d/);
  if (beforeBalance) {
    const depositorName = beforeBalance[1].trim();
    if (depositorName && !/^(농협|국민|신한|우리|입금|웹발신)$/.test(depositorName))
      return { depositorName, amount };
  }
  const withoutAmount = text
    .replace(amountMatch[0], '')
    .replace(/입금|잔액|\.|\[.*?\]/g, '')
    .trim();
  const nameMatch = withoutAmount.match(/([가-힣]{2,20})/);
  const depositorName = nameMatch ? nameMatch[1].trim() : withoutAmount.trim();
  if (!depositorName) return null;
  return { depositorName, amount };
}

/**
 * 입금 매칭 후 잔액 반영
 * @param {string} depositorName
 * @param {number} amount
 * @param {{ guildId?: string|null }} [opts] — 있으면 해당 길드의 충전 신청만 매칭 (다른 서버·오매칭 방지)
 */
function matchAndCompleteDeposit(depositorName, amount, opts = {}) {
  const name = String(depositorName).trim();
  const amt = Number(amount);
  if (!name || !(amt > 0)) return { ok: false, reason: 'invalid' };
  const guildIdOpt =
    opts.guildId != null && String(opts.guildId).trim() !== '' ? String(opts.guildId).trim() : null;
  const allList = getPending();
  const pool = guildIdOpt ? allList.filter((p) => p.guildId === guildIdOpt) : allList;
  const matches = pool.filter((p) => depositorNamesMatch(name, p.depositorName) && p.amount === amt);
  if (matches.length === 0) return { ok: false, reason: 'no_match' };
  if (matches.length > 1) return { ok: false, reason: 'duplicate_name' };
  const pending = matches[0];
  const fresh = getPending();
  const idx = fresh.findIndex((p) => p.id === pending.id);
  if (idx < 0) return { ok: false, reason: 'no_match' };
  fresh.splice(idx, 1);
  setPending(fresh);
  if (isPendingExpired(pending)) {
    return { ok: false, reason: 'expired', userId: pending.userId };
  }
  addBalance(pending.guildId, pending.userId, pending.amount);
  appendLedger({
    guildId: pending.guildId,
    userId: pending.userId,
    type: 'charge',
    text: `충전 완료 +${pending.amount.toLocaleString('ko-KR')}원 (입금자명 매칭)`,
    at: new Date().toISOString(),
    meta: { depositorName: pending.depositorName, amount: pending.amount },
  });
  return {
    ok: true,
    userId: pending.userId,
    guildId: pending.guildId,
    amount: pending.amount,
  };
}

// ——— 누적 송금 원화 (등급·수수료) ———
function readVolumeMap() {
  const j = readJson(VOLUME_FILE, {});
  return j && typeof j === 'object' ? j : {};
}

function writeVolumeMap(data) {
  writeJson(VOLUME_FILE, data);
}

function getCumulativeVolume(guildId, userId) {
  const g = String(guildId);
  const u = String(userId);
  const m = readVolumeMap();
  const n = Number(m[g]?.[u]);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** 코인 송금 확정 시 누적액에 차감 원화 합산 */
function addCumulativeSendVolume(guildId, userId, krw) {
  const add = Math.floor(Number(krw) || 0);
  if (add <= 0) return getCumulativeVolume(guildId, userId);
  const g = String(guildId);
  const u = String(userId);
  const m = readVolumeMap();
  if (!m[g]) m[g] = {};
  m[g][u] = (Number(m[g][u]) || 0) + add;
  writeVolumeMap(m);
  return m[g][u];
}

// ——— 최고 관리자·운영자 (파일 목록; 패널 설치는 서버 관리·최고 관리자만 index.js에서 처리) ———
function getSuperOwnerId() {
  const s = process.env.BOT_SUPER_OWNER_ID && String(process.env.BOT_SUPER_OWNER_ID).trim();
  return s || '657129096622506024';
}

function parseEnvAdminIds() {
  const raw = process.env.ADMIN_USER_IDS && String(process.env.ADMIN_USER_IDS).trim();
  if (!raw) return [];
  return [...new Set(raw.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean))];
}

function readBotAdminsFile() {
  const j = readJson(ADMINS_FILE, { extraAdminIds: [] });
  const arr = Array.isArray(j.extraAdminIds) ? j.extraAdminIds.map(String) : [];
  return { extraAdminIds: [...new Set(arr)] };
}

function writeBotAdminsFile(obj) {
  writeJson(ADMINS_FILE, { extraAdminIds: obj.extraAdminIds || [] });
}

function isSuperOwner(userId) {
  return String(userId) === getSuperOwnerId();
}

function getTierAndFeeForUser(guildId, userId) {
  const t = tiers.getTierForVolume(getCumulativeVolume(guildId, userId));
  if (isSuperOwner(userId) || isBotAdmin(userId)) {
    return { ...t, feeRate: 0 };
  }
  return t;
}

function getFeeRateForUser(guildId, userId) {
  return getTierAndFeeForUser(guildId, userId).feeRate;
}

function isBotAdmin(userId) {
  const uid = String(userId);
  if (isSuperOwner(uid)) return true;
  if (parseEnvAdminIds().includes(uid)) return true;
  return readBotAdminsFile().extraAdminIds.includes(uid);
}

function normalizeDiscordSnowflake(raw) {
  const tid = String(raw || '').replace(/\D/g, '');
  if (tid.length < 17 || tid.length > 20) return null;
  return tid;
}

function addExtraAdmin(superUserId, targetRaw) {
  if (!isSuperOwner(String(superUserId))) return { ok: false, reason: 'forbidden' };
  const tid = normalizeDiscordSnowflake(targetRaw);
  if (!tid) return { ok: false, reason: 'invalid_id' };
  if (isSuperOwner(tid)) return { ok: false, reason: 'already_super' };
  const f = readBotAdminsFile();
  if (f.extraAdminIds.includes(tid)) return { ok: false, reason: 'already_admin' };
  f.extraAdminIds.push(tid);
  writeBotAdminsFile(f);
  return { ok: true, targetId: tid };
}

function removeExtraAdmin(superUserId, targetRaw) {
  if (!isSuperOwner(String(superUserId))) return { ok: false, reason: 'forbidden' };
  const tid = normalizeDiscordSnowflake(targetRaw);
  if (!tid) return { ok: false, reason: 'invalid_id' };
  if (isSuperOwner(tid)) return { ok: false, reason: 'cannot_remove_super' };
  const f = readBotAdminsFile();
  const next = f.extraAdminIds.filter((x) => x !== tid);
  if (next.length === f.extraAdminIds.length) return { ok: false, reason: 'not_in_list' };
  writeBotAdminsFile({ extraAdminIds: next });
  return { ok: true, targetId: tid };
}

function listExtraAdminIds() {
  return readBotAdminsFile().extraAdminIds;
}

// ——— 본인 인증(Discord OAuth + 휴대폰) · 송금 한도 ———
function readUserSecurity() {
  const j = readJson(USER_SECURITY_FILE, { verification: {}, limits: {} });
  const v = j.verification && typeof j.verification === 'object' ? j.verification : {};
  const l = j.limits && typeof j.limits === 'object' ? j.limits : {};
  return { verification: { ...v }, limits: { ...l } };
}

function writeUserSecurity(data) {
  writeJson(USER_SECURITY_FILE, {
    verification: data.verification || {},
    limits: data.limits || {},
  });
}

function userSecurityKey(guildId, userId) {
  return `${String(guildId)}:${String(userId)}`;
}

function getKstDateKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function readSendDailyMap() {
  const j = readJson(SEND_DAILY_FILE, {});
  return j && typeof j === 'object' ? j : {};
}

function writeSendDailyMap(data) {
  writeJson(SEND_DAILY_FILE, data);
}

function getDefaultSendLimitKrw() {
  const n = Number(process.env.DEFAULT_SEND_LIMIT_KRW);
  if (Number.isFinite(n) && n >= 1000) return Math.min(100_000_000, Math.floor(n));
  return 50_000;
}

function getPerTxSendMaxKrw() {
  return PER_TX_SEND_MAX_KRW;
}

/**
 * 당일(한국 시간 자정 기준) 송금 확정 누적 원화
 */
function getDailySendUsedKrw(guildId, userId) {
  const key = userSecurityKey(guildId, userId);
  const today = getKstDateKey();
  const row = readSendDailyMap()[key];
  if (!row || row.date !== today) return 0;
  return Math.max(0, Math.floor(Number(row.totalKrw) || 0));
}

/** 송금 확정 직후 호출 — 당일 누적에 원화 합산 */
function addDailySendVolume(guildId, userId, krw) {
  const add = Math.floor(Number(krw) || 0);
  if (add <= 0) return getDailySendUsedKrw(guildId, userId);
  const key = userSecurityKey(guildId, userId);
  const today = getKstDateKey();
  const m = readSendDailyMap();
  const row = m[key];
  if (!row || row.date !== today) {
    m[key] = { date: today, totalKrw: add };
  } else {
    m[key] = { date: today, totalKrw: (Number(row.totalKrw) || 0) + add };
  }
  writeSendDailyMap(m);
  return m[key].totalKrw;
}

/**
 * 1일 송금 한도(원) — 관리자가 사용자별로 상향. 미설정 시 DEFAULT_SEND_LIMIT_KRW (기본 5만)
 */
function getSendLimitKrw(guildId, userId) {
  const key = userSecurityKey(guildId, userId);
  const row = readUserSecurity().limits[key];
  const n = row && Number(row.limitKrw);
  if (Number.isFinite(n) && n >= 1000) return Math.min(100_000_000, Math.floor(n));
  return getDefaultSendLimitKrw();
}

/**
 * 송금 신청 금액 검증: 1회 상한(50만) + 당일 누적 대비 1일 한도
 */
function checkSendKrwAllowed(guildId, userId, krw) {
  const k = Math.floor(Number(krw) || 0);
  if (k <= 0) return { ok: false, reason: 'invalid' };
  const maxTx = getPerTxSendMaxKrw();
  if (k > maxTx) {
    return { ok: false, reason: 'per_tx', max: maxTx };
  }
  const dailyLim = getSendLimitKrw(guildId, userId);
  const used = getDailySendUsedKrw(guildId, userId);
  const remaining = Math.max(0, dailyLim - used);
  if (k > remaining) {
    return { ok: false, reason: 'daily', dailyLim, used, remaining };
  }
  return { ok: true };
}

/** Discord OAuth + 휴대폰 OTP까지 완료된 사용자만 true */
function isUserVerified(guildId, userId) {
  const row = readUserSecurity().verification[userSecurityKey(guildId, userId)];
  return !!(row && row.verifiedAt && row.oauthAt && row.phoneAt);
}

function setSendLimitKrw(guildId, userId, limitKrw, setByUserId) {
  const lim = Math.floor(Number(limitKrw) || 0);
  if (lim < 1000 || lim > 100_000_000) return { ok: false, reason: 'invalid_limit' };
  const data = readUserSecurity();
  const key = userSecurityKey(guildId, userId);
  data.limits[key] = {
    limitKrw: lim,
    setByUserId: String(setByUserId),
    setAt: new Date().toISOString(),
  };
  writeUserSecurity(data);
  return { ok: true, limitKrw: lim };
}

function markUserVerified(guildId, userId, meta) {
  const data = readUserSecurity();
  const key = userSecurityKey(guildId, userId);
  const now = new Date().toISOString();
  data.verification[key] = {
    verifiedAt: now,
    oauthAt: meta.oauthAt || now,
    phoneAt: meta.phoneAt || now,
    phoneLast4: meta.phoneLast4 ? String(meta.phoneLast4).slice(-4) : undefined,
    phoneHash: meta.phoneHash,
  };
  writeUserSecurity(data);
}

module.exports = {
  getBalance,
  addBalance,
  tryDeduct,
  appendLedger,
  getLedgerForUser,
  getPendingExpireMs,
  addPending,
  findActivePendingByUser,
  parseDepositMessage,
  matchAndCompleteDeposit,
  getPendingById,
  tryApprovePendingCharge,
  tryRejectPendingCharge,
  getCumulativeVolume,
  addCumulativeSendVolume,
  getTierAndFeeForUser,
  getFeeRateForUser,
  getSuperOwnerId,
  isSuperOwner,
  isBotAdmin,
  addExtraAdmin,
  removeExtraAdmin,
  listExtraAdminIds,
  isUserVerified,
  getSendLimitKrw,
  getDefaultSendLimitKrw,
  getPerTxSendMaxKrw,
  getDailySendUsedKrw,
  addDailySendVolume,
  checkSendKrwAllowed,
  setSendLimitKrw,
  markUserVerified,
};

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} = require('discord.js');
const { buildSlashCommandBodies } = require('./slashCommands');
const cv2 = require('./lib/components-v2');
const store = require('./store');
const ltc = require('./lib/ltc-rpc');
const btc = require('./lib/btc-rpc');
const prices = require('./lib/prices');
const tiers = require('./lib/tiers');
const tierRoles = require('./lib/tier-roles');
const { createDepositServer } = require('./deposit-server');
const { signUserAuthStartToken } = require('./lib/auth-tokens');
const { mountUserAuth } = require('./lib/user-auth-http');

const EPHEMERAL_V2 = MessageFlags.Ephemeral | cv2.IS_COMPONENTS_V2;

function formatFeePctDisplay(feeRate) {
  const p = Number(feeRate) * 100;
  if (!Number.isFinite(p)) return '6%';
  const r = Math.round(p * 100) / 100;
  if (Math.abs(r - Math.round(r)) < 1e-6) return `${Math.round(r)}%`;
  return `${r}%`;
}

function chainFeeNoticeForEmbed(payload) {
  const sym = payload.coin === 'btc' ? 'BTC' : 'LTC';
  if (payload.chainFeeCrypto > 0) {
    return `수령액에서 **${payload.chainFeeCrypto}** ${sym} 제외(추정 온체인)`;
  }
  return '**변동** · 체인';
}

function cryptoSendProgressBar(pct) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const total = 10;
  const filled = Math.round((p / 100) * total);
  return `\`${'█'.repeat(filled)}${'░'.repeat(Math.max(0, total - filled))}\` **${p}%**`;
}

/** elapsed 기준 가짜 진행률(RPC는 중간 콜백 없음) — 완료 시 100% 임베드로 교체 */
function buildCryptoSendProgressEmbed(payload, elapsedMs) {
  const sym = payload.coin === 'btc' ? 'BTC' : 'LTC';
  const estimateMs = payload.coin === 'btc' ? 55_000 : 40_000;
  const pct = Math.min(95, Math.floor((elapsedMs / estimateMs) * 100));
  const feeLbl = payload.feeLabel || formatFeePctDisplay(payload.feeRate ?? 0.06);
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📤 전송 중')
    .setDescription(
      `${cryptoSendProgressBar(pct)}\n노드에 **${sym}** 전송을 요청하고 있어요. 완료되면 아래 내용이 **전송 완료** 안내로 바뀝니다.`
    )
    .addFields(
      { name: '차감 원화', value: `**${payload.krw.toLocaleString('ko-KR')}** 원`, inline: true },
      { name: '시세', value: `**${Math.round(payload.priceKrw).toLocaleString('ko-KR')}** 원/${sym}`, inline: true },
      { name: '대행 수수료', value: `**${feeLbl}**`, inline: true },
      { name: '네트워크 송금', value: chainFeeNoticeForEmbed(payload), inline: true },
      { name: `${feeLbl} 반영 전`, value: `**${payload.grossCrypto}** ${sym}`, inline: true },
      ...(Number(payload.chainFeeCrypto) > 0 && payload.tierNetCrypto != null
        ? [{ name: '대행 반영 후', value: `**${payload.tierNetCrypto}** ${sym}`, inline: true }]
        : []),
      { name: '전송 예정', value: `**${payload.netCrypto}** ${sym}`, inline: true },
      { name: '수령 주소', value: `\`${payload.address}\``, inline: false }
    )
    .setFooter({ text: '진행률은 예상 시간 기준이며, 네트워크 상황에 따라 달라질 수 있어요.' })
    .setTimestamp();
}

function buildCryptoSendDoneEmbed(payload, txid) {
  const sym = payload.coin === 'btc' ? 'BTC' : 'LTC';
  const feeLbl = payload.feeLabel || formatFeePctDisplay(payload.feeRate ?? 0.06);
  const dry =
    (payload.coin === 'btc' && btc.isDryRun()) || (payload.coin !== 'btc' && ltc.isDryRun());
  const e = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('✅ 전송이 완료되었습니다')
    .setDescription(`${cryptoSendProgressBar(100)}\n온체인 전송이 처리되었습니다.`)
    .addFields(
      { name: '차감 원화', value: `**${payload.krw.toLocaleString('ko-KR')}** 원`, inline: true },
      { name: '시세', value: `**${Math.round(payload.priceKrw).toLocaleString('ko-KR')}** 원/${sym}`, inline: true },
      { name: '대행 수수료', value: `**${feeLbl}**`, inline: true },
      { name: '네트워크 송금', value: chainFeeNoticeForEmbed(payload), inline: true },
      { name: `${feeLbl} 반영 전`, value: `**${payload.grossCrypto}** ${sym}`, inline: true },
      ...(Number(payload.chainFeeCrypto) > 0 && payload.tierNetCrypto != null
        ? [{ name: '대행 반영 후', value: `**${payload.tierNetCrypto}** ${sym}`, inline: true }]
        : []),
      { name: '실제 전송', value: `**${payload.netCrypto}** ${sym}`, inline: true },
      { name: '수령 주소', value: `\`${payload.address}\``, inline: false },
      { name: 'TXID', value: `\`${txid}\``, inline: false }
    );
  if (dry) e.setFooter({ text: 'DRY_RUN — 실제 온체인 전송 없음' });
  return e;
}

function buildCryptoSendFailEmbed(payload, errMsg) {
  const sym = payload.coin === 'btc' ? 'BTC' : 'LTC';
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('❌ 전송 실패')
    .setDescription(`원화 **${payload.krw.toLocaleString('ko-KR')}** 원은 잔액에 되돌려 두었어요.`)
    .addFields(
      { name: '전송 예정', value: `**${payload.netCrypto}** ${sym}`, inline: true },
      { name: '수령 주소', value: `\`${payload.address}\``, inline: false },
      { name: '오류', value: `\`${String(errMsg || '').slice(0, 900)}\``, inline: false }
    );
}

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DATA_DIR_BOT = path.join(__dirname, 'data');
const OTC_PANEL_FILE = path.join(DATA_DIR_BOT, 'otcPanelByGuild.json');

function ensureDataDirBot() {
  if (!fs.existsSync(DATA_DIR_BOT)) fs.mkdirSync(DATA_DIR_BOT, { recursive: true });
}

/** 완전 끔: PANEL_AUTO_REFRESH=0 / false / off */
function isPanelAutoRefreshDisabled() {
  const v = String(process.env.PANEL_AUTO_REFRESH ?? '1').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

/**
 * 패널 자동 갱신 주기(초).
 * - PANEL_AUTO_REFRESH 가 꺼져 있으면 0 (갱신 안 함)
 * - PANEL_REFRESH_SECONDS 가 0·비어 있으면 기본 5초 (시세·재고 계속 반영)
 * - 1~2초는 디스코드 429 위험이 있어 최소 3초로 올림
 */
function getPanelRefreshIntervalSeconds() {
  if (isPanelAutoRefreshDisabled()) return 0;
  const rawSec = process.env.PANEL_REFRESH_SECONDS;
  const DEFAULT_SEC = 5;
  let refreshSec = DEFAULT_SEC;
  if (rawSec !== undefined && String(rawSec).trim() !== '') {
    const n = Number(rawSec);
    if (n === 0 || !Number.isFinite(n)) refreshSec = DEFAULT_SEC;
    else if (n > 0) refreshSec = Math.min(3600, Math.max(3, n));
  }
  return refreshSec;
}

function getMaxPanelRefsPerGuild() {
  const n = Number(process.env.PANEL_MAX_TRACKED_MESSAGES);
  if (Number.isFinite(n) && n >= 1) return Math.min(50, n);
  return 25;
}

/** 파일에 저장된 값 → { channelId, messageId }[] (구버전 단일 객체 호환) */
function panelRefsForGuild(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .filter((r) => r && r.channelId && r.messageId)
      .map((r) => ({ channelId: String(r.channelId), messageId: String(r.messageId) }));
  }
  if (typeof raw === 'object' && raw.channelId && raw.messageId) {
    return [{ channelId: String(raw.channelId), messageId: String(raw.messageId) }];
  }
  return [];
}

function writeOtcPanelMap(map) {
  ensureDataDirBot();
  fs.writeFileSync(OTC_PANEL_FILE, JSON.stringify(map, null, 2), 'utf8');
}

/** /자판기패널 마다 추적 — 길드당 최대 N개까지 자동 갱신 (이전 패널도 유지) */
function saveOtcPanelMessageRef(guildId, channelId, messageId) {
  let map = {};
  try {
    if (fs.existsSync(OTC_PANEL_FILE)) map = JSON.parse(fs.readFileSync(OTC_PANEL_FILE, 'utf8'));
  } catch {
    map = {};
  }
  if (!map || typeof map !== 'object') map = {};
  const gid = String(guildId);
  const cid = String(channelId);
  const mid = String(messageId);
  const cap = getMaxPanelRefsPerGuild();
  let list = panelRefsForGuild(map[gid]).filter((r) => r.messageId !== mid);
  list.push({ channelId: cid, messageId: mid });
  while (list.length > cap) list.shift();
  map[gid] = list;
  writeOtcPanelMap(map);
}

/** 삭제된 메시지 등으로 갱신 불가 시 목록에서 제거 */
function removeOtcPanelMessageRef(guildId, messageId) {
  let map = {};
  try {
    if (fs.existsSync(OTC_PANEL_FILE)) map = JSON.parse(fs.readFileSync(OTC_PANEL_FILE, 'utf8'));
  } catch {
    return;
  }
  if (!map || typeof map !== 'object') return;
  const gid = String(guildId);
  const mid = String(messageId);
  const list = panelRefsForGuild(map[gid]).filter((r) => r.messageId !== mid);
  if (list.length === 0) delete map[gid];
  else map[gid] = list;
  writeOtcPanelMap(map);
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 디스코드 메시지 수정 429 시 재시도 (짧은 주기 갱신 시 필요) */
async function editOtcPanelMessage(ch, messageId, payload) {
  const max = 5;
  for (let i = 0; i < max; i++) {
    try {
      await ch.messages.edit(messageId, payload);
      return;
    } catch (e) {
      const status = e.status ?? e.statusCode;
      const retryAfterSec = Number(e.data?.retry_after ?? e.rawError?.retry_after);
      const is429 =
        status === 429 ||
        e.code === 429 ||
        (typeof e.message === 'string' && e.message.includes('429'));
      if (is429 && i < max - 1) {
        const wait = Math.min(20_000, Math.max(1500, (Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 3500) + 300));
        console.warn(`[패널] 메시지 수정 rate limit — ${Math.round(wait)}ms 후 재시도 (${i + 1}/${max})`);
        await sleepMs(wait);
        continue;
      }
      throw e;
    }
  }
}

async function refreshOtcPanelMessages() {
  let map = {};
  try {
    if (fs.existsSync(OTC_PANEL_FILE)) map = JSON.parse(fs.readFileSync(OTC_PANEL_FILE, 'utf8'));
  } catch {
    return;
  }
  if (Object.keys(map).length === 0) return;
  let payload;
  try {
    payload = await buildOtcPanel();
  } catch (e) {
    console.warn('[패널] 빌드 실패:', e.message || e);
    return;
  }
  await applyOtcPanelPayloadToTrackedMessages(payload);
}

/** 전송 확인 대기 (버튼 15분) */
const pendingCryptoSends = new Map();
const PENDING_SEND_TTL_MS = 15 * 60 * 1000;

function prunePendingSends() {
  const now = Date.now();
  for (const [k, v] of pendingCryptoSends) {
    if (now - v.createdAt > PENDING_SEND_TTL_MS) pendingCryptoSends.delete(k);
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('config.json 이 없습니다. config.example.json 을 복사하세요.');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const products = Array.isArray(raw.products) ? raw.products : [];
  const panel = raw.panel && typeof raw.panel === 'object' ? raw.panel : {};
  const bank = raw.bank && typeof raw.bank === 'object' ? raw.bank : {};
  return { products, panel, bank, raw };
}

let config = loadConfig();

function reloadConfig() {
  config = loadConfig();
}

function panelText(key, fallback) {
  const v = config.panel[key];
  return v != null && String(v).trim() ? String(v).trim() : fallback;
}

/** 입금 문자 자동 매칭과 별도로, 관리자 채널에 수락/거절 패널을 올림 (config / env) */
function getChargeApprovalChannelId() {
  const envC = process.env.CHARGE_APPROVAL_CHANNEL_ID && String(process.env.CHARGE_APPROVAL_CHANNEL_ID).trim();
  if (envC) return envC;
  const raw = config.raw && typeof config.raw === 'object' ? config.raw : {};
  const c = raw.chargeApprovalChannelId;
  return c != null && String(c).trim() ? String(c).trim() : '';
}

/** LTC 재고 입고 알림용 텍스트 채널 (env 우선) */
function getInventoryInflowChannelId() {
  const envC = process.env.INVENTORY_INFLOW_CHANNEL_ID && String(process.env.INVENTORY_INFLOW_CHANNEL_ID).trim();
  if (envC && /^\d{17,20}$/.test(envC)) return envC;
  const raw = config.raw && typeof config.raw === 'object' ? config.raw : {};
  const c = raw.inventoryInflowChannelId;
  return c != null && String(c).trim() && /^\d{17,20}$/.test(String(c).trim()) ? String(c).trim() : '';
}

function getInventoryInflowMinKrw() {
  const n = Number(process.env.INVENTORY_INFLOW_MIN_KRW);
  if (Number.isFinite(n) && n >= 1000) return Math.floor(n);
  return 50_000;
}

/** 재고 입고 알림 시 멘션할 역할 (env 우선, 없으면 content 없이 임베드만) */
function getInventoryInflowPingRoleId() {
  const envR = process.env.INVENTORY_INFLOW_PING_ROLE_ID && String(process.env.INVENTORY_INFLOW_PING_ROLE_ID).trim();
  if (envR && /^\d{17,20}$/.test(envR)) return envR;
  const raw = config.raw && typeof config.raw === 'object' ? config.raw : {};
  const r = raw.inventoryInflowPingRoleId;
  return r != null && String(r).trim() && /^\d{17,20}$/.test(String(r).trim()) ? String(r).trim() : '';
}

function canApproveCharges(interaction) {
  return (
    !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    store.isSuperOwner(interaction.user.id) ||
    store.isBotAdmin(interaction.user.id)
  );
}

function formatBankLines() {
  const b = config.bank || {};
  const lines = [];
  lines.push(`🏦 은행: **${b.bankName || 'NH농협은행'}**`);
  if (b.accountNumber) lines.push(`📋 계좌번호: **${b.accountNumber}**`);
  if (b.accountHolder) lines.push(`👤 예금주: **${b.accountHolder}**`);
  if (b.notice) lines.push(String(b.notice));
  if (!b.accountNumber && !b.accountHolder) {
    lines.push('`config.json`의 **bank** 항목에 계좌 정보를 넣어 주세요.');
  }
  return lines.join('\n');
}

function formatPendingRemainMs(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m <= 0) return `${s}초`;
  if (s === 0) return `${m}분`;
  return `${m}분 ${s}초`;
}

function buildChargeSubmitConfirmText(depositorName, amount, pendingId, approvalOn, panelRes, remainMs) {
  const expireMin = Math.round(store.getPendingExpireMs() / 60000);
  const timeLine =
    remainMs > 0
      ? `⏱ 남은 유효 시간: **${formatPendingRemainMs(remainMs)}** (최대 약 ${expireMin}분) · 완료 시 DM으로 알려 드릴게요 (DM 허용 권장)`
      : '⏱ 신청 유효 시간이 **만료**되었어요. 처리되지 않았다면 다시 **잔액충전**으로 신청해 주세요.';
  return [
    '### ✅ 충전 신청 접수',
    `• 입금자명: **${depositorName}**`,
    `• 금액: **${amount.toLocaleString('ko-KR')}** 원`,
    `• 신청 ID: \`${pendingId}\``,
    '',
    '아래 계좌로 **위 금액·이름 그대로** 입금해 주세요.',
    '',
    '',
    formatBankLines(),
    '',
    '',
    timeLine,
  ]
    .filter((x) => x != null && x !== '')
    .join('\n');
}

function buildChargeSubmitConfirmPayload(depositorName, amount, pendingId, approvalOn, panelRes, remainMs) {
  const body = buildChargeSubmitConfirmText(depositorName, amount, pendingId, approvalOn, panelRes, remainMs);
  return {
    ...cv2.v2Payload([cv2.container([cv2.textDisplay(body)])]),
    flags: EPHEMERAL_V2,
  };
}

/** 패널 재고용 LTC→원 단가 (스냅샷 실패 시 출처별 재시도) */
async function resolvePanelLtcPriceKrw(market) {
  if (Number.isFinite(market.refKrw) && market.refKrw > 0) return market.refKrw;
  try {
    const n = await prices.fetchBithumbLtcKrw();
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) {}
  try {
    const n = await prices.fetchCoingeckoLtcKrw();
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) {}
  try {
    const n = await prices.fetchUpbitLtcKrw();
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) {}
  try {
    const n = await prices.fetchIndirectLtcKrw();
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) {}
  return null;
}

/** 마지막 시세·재고 스냅샷 시각(ms) — 'N초 전' 카운트용 */
let otcPanelDataFetchedAtMs = 0;
/** 스냅샷 직후 조립된 UI 조각 (헤더 나이 문구만 1초마다 바꿈) */
let otcPanelUiCache = null;
/** 직전 패널 갱신 시점 LTC 재고(입고 알림 비교용). RPC 실패 시 갱신 안 함 */
let prevLtcInventoryForInflowAlert = null;

/**
 * LTC 지갑 잔고가 늘어난 분을 시세로 환산했을 때 임계 이상이면 알림 채널에 임베드 전송
 */
async function maybeNotifyLtcInventoryInflow(balLtc, priceKrwLtc) {
  const chId = getInventoryInflowChannelId();
  if (!chId || !client?.isReady?.()) return;
  if (balLtc == null || priceKrwLtc == null || !Number.isFinite(priceKrwLtc) || priceKrwLtc <= 0) return;

  const cur = ltc.roundLtc8(balLtc);
  const minKrw = getInventoryInflowMinKrw();

  if (prevLtcInventoryForInflowAlert == null) {
    prevLtcInventoryForInflowAlert = cur;
    return;
  }

  const prev = prevLtcInventoryForInflowAlert;
  const deltaRaw = cur - prev;
  if (deltaRaw <= 0) {
    prevLtcInventoryForInflowAlert = cur;
    return;
  }

  const deltaLtc = ltc.roundLtc8(deltaRaw);
  const deltaKrw = Math.round(deltaLtc * priceKrwLtc);
  prevLtcInventoryForInflowAlert = cur;

  if (deltaKrw < minKrw) return;

  try {
    const ch = await client.channels.fetch(chId);
    if (!ch || !ch.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('재고 입고완료')
      .setDescription(
        `**LTC**가 **${deltaLtc}** LTC 유입되었습니다. (당시 시세 기준 약 **${deltaKrw.toLocaleString('ko-KR')}** 원 상당)`
      )
      .addFields(
        { name: '코인', value: '**LTC** (라이트코인)', inline: true },
        { name: '입고 수량', value: `**${deltaLtc}** LTC`, inline: true },
        { name: '환산 금액', value: `약 **${deltaKrw.toLocaleString('ko-KR')}** 원`, inline: true },
        { name: '갱신 후 재고', value: `**${cur}** LTC`, inline: false }
      )
      .setTimestamp();
    const pingRoleId = getInventoryInflowPingRoleId();
    const payload = { embeds: [embed] };
    if (pingRoleId) {
      payload.content = `<@&${pingRoleId}>`;
      payload.allowedMentions = { roles: [pingRoleId] };
    }
    await ch.send(payload);
  } catch (e) {
    console.warn('[재고 입고 알림]', e.message || e);
  }
}

async function refreshOtcPanelDataAndCache() {
  reloadConfig();
  const title = panelText('title', '24시간 자동 코인 송금 시스템');
  const subtitle = panelText('subtitle', '💎 쥬코인대행 OTC 💎');
  const desc = panelText(
    'description',
    '실시간 시세와 김프를 반영한 안전한 송금 서비스입니다.'
  );
  const footer = panelText('footer', '쥬코인대행 OTC · 봇 오류 시 관리자에게 문의 바랍니다.');
  const imageUrl =
    (config.panel.imageUrl && String(config.panel.imageUrl).trim()) ||
    (process.env.PANEL_IMAGE_URL && String(process.env.PANEL_IMAGE_URL).trim()) ||
    '';

  const [market, balLtc] = await Promise.all([prices.getMarketSnapshot(), ltc.getWalletBalanceLtc()]);

  const ltcWalletStr = balLtc != null ? String(ltc.roundLtc8(balLtc)) : '';
  const walletZero = balLtc != null && ltc.roundLtc8(balLtc) <= 0;

  let panelPriceKrw = null;
  let inventoryLine = '**—** (LTC 재고 RPC 미연동)';
  if (balLtc != null) {
    const priceKrw = await resolvePanelLtcPriceKrw(market);
    panelPriceKrw = priceKrw;
    if (priceKrw != null) {
      const invKrw = Math.round(balLtc * priceKrw);
      inventoryLine = `**${invKrw.toLocaleString('ko-KR')}** 원 (LTC 재고 **${ltcWalletStr}** LTC)`;
    } else if (walletZero) {
      inventoryLine = `**0** 원 (LTC 재고 **${ltcWalletStr}** LTC)`;
    } else {
      inventoryLine = `LTC 재고 **${ltcWalletStr}** LTC (원화 시세 조회 실패)`;
    }
  }

  await maybeNotifyLtcInventoryInflow(balLtc, panelPriceKrw);

  let kimchiLine = '**—**';
  if (market.kimchiPremiumPercent != null && Number.isFinite(market.kimchiPremiumPercent)) {
    kimchiLine = `**${market.kimchiPremiumPercent.toFixed(2)}%**`;
  }

  otcPanelUiCache = { title, subtitle, desc, footer, imageUrl, inventoryLine, kimchiLine };
  otcPanelDataFetchedAtMs = Date.now();
}

function buildOtcPanelPayloadFromCache(ageSec) {
  const u = otcPanelUiCache;
  if (!u) return null;
  const age = Math.max(0, Math.floor(Number(ageSec) || 0));
  const updateLabel = `(최근 업데이트: ${age}초 전)`;
  const header = cv2.section([`## ${u.title}`, `### ${u.subtitle}`, u.desc, '', updateLabel].join('\n'));

  const stats = cv2.textDisplay(
    ['### 📊 실시간 재고', u.inventoryLine, '', '### 📈 실시간 김프', u.kimchiLine].join('\n')
  );

  const blocks = [header, stats];
  if (u.imageUrl && /^https?:\/\//i.test(u.imageUrl)) {
    blocks.push(cv2.mediaGallery(u.imageUrl));
  }

  const menu = cv2.stringSelectRow('otc_main_select', '메뉴 선택', [
    { label: '내정보', value: 'myinfo' },
    { label: '잔액충전', value: 'charge_request' },
    { label: '송금', value: 'transfer' },
    { label: '본인인증', value: 'verify_link' },
    { label: '이용방법', value: 'info' },
    { label: '계산기', value: 'calculator' },
  ]);
  blocks.push(menu);
  blocks.push(cv2.textDisplay(`-# ${u.footer}`));

  return cv2.v2Payload([cv2.container(blocks, 0x232428)]);
}

async function buildOtcPanel() {
  await refreshOtcPanelDataAndCache();
  return buildOtcPanelPayloadFromCache(0);
}

async function applyOtcPanelPayloadToTrackedMessages(payload) {
  if (!payload || !client || !client.isReady()) return;
  let map = {};
  try {
    if (!fs.existsSync(OTC_PANEL_FILE)) {
      writeOtcPanelMap({});
      return;
    }
    map = JSON.parse(fs.readFileSync(OTC_PANEL_FILE, 'utf8'));
  } catch {
    return;
  }
  const gids = Object.keys(map);
  for (const gid of gids) {
    const refs = panelRefsForGuild(map[gid]);
    for (const ref of refs) {
      if (!ref.channelId || !ref.messageId) continue;
      try {
        const ch = await client.channels.fetch(ref.channelId, { force: true });
        if (!ch || !ch.isTextBased()) continue;
        await editOtcPanelMessage(ch, ref.messageId, payload);
      } catch (e) {
        if (e.code === 10008 || e.code === 10003) {
          removeOtcPanelMessageRef(gid, ref.messageId);
          console.warn(`[패널] 메시지 또는 채널 삭제됨 — 추적 목록에서 제거 (${ref.messageId})`);
        } else {
          console.warn(`[패널 자동갱신] 실패 (guild ${gid} msg ${ref.messageId}):`, e.message || e);
        }
      }
    }
  }
}

/** 시세·재고는 그대로 두고, 경과 초만 1,2,3… 으로 표시 */
async function tickOtcPanelAgeLabel() {
  if (!client || !client.isReady()) return;
  if (getPanelRefreshIntervalSeconds() <= 0) return;
  if (!otcPanelUiCache || !otcPanelDataFetchedAtMs) return;
  const age = Math.max(0, Math.floor((Date.now() - otcPanelDataFetchedAtMs) / 1000));
  const payload = buildOtcPanelPayloadFromCache(age);
  if (payload) await applyOtcPanelPayloadToTrackedMessages(payload);
}

function buildChargeRequestModal() {
  return new ModalBuilder()
    .setCustomId('charge_bank_modal')
    .setTitle('잔액 충전 신청')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('depositor_name')
          .setLabel('입금자명 (계좌에 표시되는 이름과 동일)')
          .setPlaceholder('홍길동')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(2)
          .setMaxLength(20)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('amount_won')
          .setLabel('입금할 금액 (원)')
          .setPlaceholder('50000')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(12)
      )
    );
}

function buildTransferFiatModal(coin) {
  const c = coin === 'btc' ? 'btc' : 'ltc';
  const label = c === 'btc' ? '비트코인' : 'LTC';
  return new ModalBuilder()
    .setCustomId(`transfer_fiat_modal:${c}`)
    .setTitle(`${label} 송금 (원화 차감)`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('krw_amount')
          .setLabel('차감할 원화 금액 (일반 최소 3천 · 1회 최대 50만)')
          .setPlaceholder('예: 30000')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(12)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('withdraw_address')
          .setLabel(`${label} 수령 주소`)
          .setPlaceholder(c === 'btc' ? 'bc1... 또는 1...' : 'ltc1... 또는 L...')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(14)
          .setMaxLength(95)
      )
    );
}

function buildTransferCoinSelectMessage() {
  const perTxMax = store.getPerTxSendMaxKrw();
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📤 송금 — 코인 선택')
    .setDescription('보낼 코인을 아래 메뉴에서 선택하세요.')
    .addFields({
      name: '1회 송금 최대 한도',
      value: `**${perTxMax.toLocaleString('ko-KR')}** 원까지 송금할 수 있습니다.`,
      inline: false,
    });
  return {
    embeds: [embed],
    components: [
      cv2.stringSelectRow('transfer_pick_coin', '코인', [
        { label: 'LTC (라이트코인)', value: 'ltc' },
        { label: 'BTC (비트코인)', value: 'btc' },
      ]),
    ],
    flags: MessageFlags.Ephemeral,
  };
}

function buildCalculatorModal() {
  return new ModalBuilder()
    .setCustomId('krw_ltc_calc_modal')
    .setTitle('원화 → LTC 계산')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('calc_krw_amount')
          .setLabel('확인할 원화 금액 (KRW)')
          .setPlaceholder('예: 50000')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(14)
      )
    );
}

function buildAdminManageModal(mode) {
  const add = mode === 'add';
  return new ModalBuilder()
    .setCustomId(`admin_manage_modal:${mode}`)
    .setTitle(add ? '운영자 Discord ID 추가' : '운영자 Discord ID 제거')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('admin_target_user_id')
          .setLabel('Discord 사용자 ID (숫자만)')
          .setPlaceholder('657129096622506024')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(17)
          .setMaxLength(22)
      )
    );
}

function buildSendLimitModal() {
  return new ModalBuilder()
    .setCustomId('admin_send_limit_modal')
    .setTitle('1일 송금 한도 설정 (관리자 상향)')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('limit_target_user_id')
          .setLabel('대상 Discord 사용자 ID')
          .setPlaceholder('657129096622506024')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(17)
          .setMaxLength(22)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('limit_krw')
          .setLabel('1일 송금 한도 (원) — 당일 누적 상한')
          .setPlaceholder('50000')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(4)
          .setMaxLength(12)
      )
    );
}

function isAuthEnforced() {
  const v = String(process.env.REQUIRE_USER_VERIFICATION ?? '1').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  if (!String(process.env.AUTH_PUBLIC_BASE_URL || '').trim()) return false;
  if (!String(process.env.AUTH_STATE_SECRET || '').trim()) return false;
  if (!String(process.env.DISCORD_CLIENT_SECRET || '').trim()) return false;
  if (!String(process.env.OAUTH_REDIRECT_URI || '').trim()) return false;
  if (!String(process.env.DISCORD_CLIENT_ID || '').trim()) return false;
  return true;
}

function buildUserAuthLinkContent(guildId, userId) {
  const base = String(process.env.AUTH_PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const secret = String(process.env.AUTH_STATE_SECRET || '').trim();
  const tok = signUserAuthStartToken(guildId, userId, secret);
  if (!tok) return '본인 인증 설정 오류: `AUTH_STATE_SECRET` 을 확인하세요.';
  const url = `${base}/auth/start?token=${encodeURIComponent(tok)}`;
  return [
    '이 기능을 쓰려면 **본인 인증**이 필요합니다.',
    '**1단계** Discord 로그인 → **2단계** 휴대폰 문자 인증',
    '',
    `아래 링크를 **본인 브라우저**에서 여세요. (약 25분 유효)\n${url}`,
  ].join('\n');
}

/** @returns {string|null} 에피메랄 안내 문구 또는 null(통과) */
function gateVerifiedOrExplain(interaction) {
  if (!isAuthEnforced()) return null;
  const gid = interaction.guildId;
  const uid = interaction.user?.id;
  if (!gid || !uid) return null;
  if (store.isUserVerified(gid, uid)) return null;
  return buildUserAuthLinkContent(gid, uid);
}

/** @param {{ ok: boolean, reason?: string, max?: number, dailyLim?: number, used?: number, remaining?: number }} check */
function formatSendLimitViolationMessage(check) {
  if (check.ok) return '';
  if (check.reason === 'per_tx') {
    return `1회 송금은 최대 **${check.max.toLocaleString('ko-KR')}** 원까지 가능해요.`;
  }
  if (check.reason === 'daily') {
    return (
      `오늘 **1일 송금 한도**를 넘을 수 없어요. (하루 한도 **${check.dailyLim.toLocaleString('ko-KR')}** 원 · 오늘 사용 **${check.used.toLocaleString('ko-KR')}** 원 · **남음 ${check.remaining.toLocaleString('ko-KR')}** 원) ` +
      '관리자에게 **1일 한도** 상향을 요청해 주세요.'
    );
  }
  return '송금 금액이 올바르지 않아요.';
}

function canManageSendLimit(interaction) {
  return (
    !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    store.isSuperOwner(interaction.user.id)
  );
}

/** 일반 3,000원 · 서버 관리 또는 봇 운영자 1,000원 · 최고 관리자 사실상 제한 없음(1원) */
function getMinSendKrwForInteraction(interaction) {
  const uid = interaction.user?.id;
  if (!uid) return 3000;
  if (store.isSuperOwner(uid)) return 1;
  if (
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    store.isBotAdmin(uid)
  ) {
    return 1000;
  }
  return 3000;
}

function formatMinSendKrwReply(minKrw) {
  if (minKrw <= 1) {
    return '송금 금액은 **1원 이상**으로 입력해 주세요.';
  }
  return `원화 금액은 **${minKrw.toLocaleString('ko-KR')}원 이상**으로 입력해 주세요.`;
}

/** @returns {Promise<string|null>} 차단 시 안내 문구, 통과 시 null */
async function gateVendingMemberOrExplain(interaction) {
  reloadConfig();
  const raw = config.raw && typeof config.raw === 'object' ? config.raw : {};
  const roleId = tierRoles.getVendingMemberRoleIdFromRaw(raw);
  if (!roleId) return null;
  if (!interaction.guild) return '서버에서만 사용할 수 있어요.';
  let mem = interaction.member;
  if (!mem) {
    try {
      mem = await interaction.guild.members.fetch(interaction.user.id);
    } catch {
      return '멤버 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.';
    }
  }
  if (store.isSuperOwner(interaction.user.id)) return null;
  if (mem.roles.cache.has(roleId)) return null;
  return '코인 자판기는 지정된 **회원** 역할이 있는 분만 이용할 수 있어요. 관리자에게 문의해 주세요.';
}

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('DISCORD_BOT_TOKEN 이 필요합니다.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

async function notifyChargeComplete(userId, amount) {
  try {
    const u = await client.users.fetch(userId);
    await u.send(`✅ **충전 완료** — **${Number(amount).toLocaleString('ko-KR')}원**이 잔액에 반영되었어요.`);
  } catch (e) {
    console.warn('[충전 DM 실패]', userId, e.message);
  }
}

async function notifyChargeRejected(userId) {
  try {
    const u = await client.users.fetch(userId);
    await u.send(
      '❌ **충전 신청이 거절되었어요.**\n내용을 확인한 뒤 필요하면 다시 **잔액충전**으로 신청해 주세요. (DM을 막아 두면 알림을 못 받을 수 있어요.)'
    );
  } catch (e) {
    console.warn('[충전 거절 DM 실패]', userId, e.message);
  }
}

/** @returns {Promise<{ ok: boolean, reason?: string }>} */
async function postChargeApprovalRequest(interaction, pendingId, depositorName, amount) {
  const cid = getChargeApprovalChannelId();
  if (!cid) return { ok: true };
  const guild = interaction.guild;
  if (!guild) return { ok: false, reason: 'no_guild' };
  try {
    const ch = await guild.channels.fetch(cid);
    if (!ch || !ch.isTextBased()) {
      console.warn('[충전 승인 패널] 채널을 찾을 수 없거나 텍스트 채널이 아님:', cid);
      return { ok: false, reason: 'bad_channel' };
    }
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('💰 원화 충전 — 승인 대기')
      .setDescription(
        '입금을 확인하셨다면 **수락**을, 잘못된 신청이면 **거절**을 눌러 주세요.\n_(입금 문자 자동 매칭이 켜져 있으면, 자동 반영 시 이 신청은 소진됩니다.)_'
      )
      .addFields(
        { name: '신청자', value: `<@${interaction.user.id}> · \`${interaction.user.id}\``, inline: false },
        { name: '입금자명', value: `**${depositorName}**`, inline: true },
        { name: '금액', value: `**${amount.toLocaleString('ko-KR')}** 원`, inline: true },
        { name: '신청 ID', value: `\`${pendingId}\``, inline: true }
      )
      .setFooter({ text: '서버 관리·운영자·최고 관리자만 버튼을 누를 수 있어요.' })
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`charge_ok:${pendingId}`)
        .setLabel('수락')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`charge_no:${pendingId}`)
        .setLabel('거절')
        .setStyle(ButtonStyle.Danger)
    );
    await ch.send({ embeds: [embed], components: [row] });
    return { ok: true };
  } catch (e) {
    console.warn('[충전 승인 패널 전송 실패]', e.message || e);
    return { ok: false, reason: 'send_failed' };
  }
}

const depositApp = createDepositServer((result) => {
  notifyChargeComplete(result.userId, result.amount).catch(() => {});
  refreshOtcPanelMessages().catch((e) => console.warn('[자동충전 후 패널 갱신]', e.message || e));
});
mountUserAuth(depositApp);

const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT || 8787);
if (WEBHOOK_PORT > 0) {
  depositApp.listen(WEBHOOK_PORT, () => {
    console.log(
      `[HTTP] :${WEBHOOK_PORT} — 입금: POST /webhook/deposit, /api/deposit/sms | 본인인증: /auth/start, /auth/discord/callback, /auth/phone`
    );
  });
}

const DEPOSIT_CHANNEL_ID = process.env.DEPOSIT_CHANNEL_ID && String(process.env.DEPOSIT_CHANNEL_ID).trim();
const SMS_MATCH_ONLY =
  String(process.env.SMS_MATCH_ONLY || '').trim() === '1' ||
  String(process.env.SMS_MATCH_ONLY || '').trim().toLowerCase() === 'true';
const DEPOSIT_ALLOW_NON_WEBHOOK =
  String(process.env.DEPOSIT_ALLOW_NON_WEBHOOK || '').trim() === '1' ||
  String(process.env.DEPOSIT_ALLOW_NON_WEBHOOK || '').trim().toLowerCase() === 'true';

client.on('messageCreate', async (message) => {
  try {
    if (SMS_MATCH_ONLY) return;
    if (!DEPOSIT_CHANNEL_ID || message.channelId !== DEPOSIT_CHANNEL_ID) return;
    if (message.channel?.type !== ChannelType.GuildText) return;
    if (message.author?.id && message.author.id === client.user?.id) return;
    if (!DEPOSIT_ALLOW_NON_WEBHOOK && !message.webhookId) return;
    const content = (message.content || '').trim();
    if (!content) return;
    const parsed = store.parseDepositMessage(content);
    if (!parsed) {
      console.log('[SMS채널] 파싱 실패:', content.slice(0, 100));
      return;
    }
    const result = store.matchAndCompleteDeposit(parsed.depositorName, parsed.amount, {
      guildId: message.guildId,
    });
    if (!result.ok) {
      console.log('[SMS채널] 매칭 실패:', result.reason, parsed.depositorName, parsed.amount);
      return;
    }
    await notifyChargeComplete(result.userId, result.amount);
    refreshOtcPanelMessages().catch((e) => console.warn('[SMS채널 충전 후 패널 갱신]', e.message || e));
    console.log(`[SMS채널] 자동충전 user=${result.userId} amount=${result.amount}`);
  } catch (e) {
    console.error('[messageCreate]', e);
  }
});

client.once(Events.ClientReady, async (c) => {
  console.log(`로그인: ${c.user.tag}`);
  reloadConfig();
  const memberR = tierRoles.getVendingMemberRoleIdFromRaw(config.raw);
  const tierMap = tierRoles.getTierRoleIdMapFromRaw(config.raw);
  if (memberR || Object.keys(tierMap).length > 0) {
    console.log(
      `[자판기 역할] 회원 역할: ${memberR || '(미설정 — 누구나 이용 가능)'} · 등급 역할 매핑: ${Object.keys(tierMap).length}단계`
    );
    console.log('[자판기 역할] 역할 검사·자동 부여를 위해 봇에 **역할 관리** 권한과, 개발자 포털 **Privileged Gateway Intent → Server Members Intent** 가 필요합니다.');
  }
  let applicationId = c.application?.id || null;
  try {
    if (c.application && !applicationId) {
      const app = await c.application.fetch();
      applicationId = app?.id || null;
    }
  } catch (_) {}
  if (!applicationId) {
    applicationId = process.env.DISCORD_CLIENT_ID && String(process.env.DISCORD_CLIENT_ID).trim();
  }
  const guildId = process.env.GUILD_ID && String(process.env.GUILD_ID).trim();
  const clearGlobal = String(process.env.CLEAR_GLOBAL_SLASH || '').trim() === '1';
  const slashBody = buildSlashCommandBodies();
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    if (clearGlobal && applicationId) {
      await rest.put(Routes.applicationCommands(applicationId), { body: [] });
      console.log('[슬래시] 글로벌 명령 비움');
    }
    if (guildId && applicationId) {
      await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: slashBody });
      console.log(`[슬래시] 길드 등록: ${slashBody.map((x) => x.name).join(', ')}`);
    } else if (applicationId) {
      await rest.put(Routes.applicationCommands(applicationId), { body: slashBody });
      console.log('[슬래시] 글로벌 등록');
    }
  } catch (e) {
    console.error('[슬래시 등록 실패]', e.message || e);
  }

  const refreshSec = getPanelRefreshIntervalSeconds();
  if (refreshSec > 0) {
    const ms = refreshSec * 1000;
    setInterval(() => {
      refreshOtcPanelMessages().catch((err) => console.warn('[패널 갱신]', err.message || err));
    }, ms);
    setInterval(() => {
      tickOtcPanelAgeLabel().catch((err) => console.warn('[패널 초 표시]', err.message || err));
    }, 1000);
    refreshOtcPanelMessages().catch(() => {});
    console.log(
      `[패널] 시세·재고 ${refreshSec}초마다 갱신, '(최근 업데이트: N초 전)' 은 1초마다 카운트`
    );
  } else {
    console.log('[패널] 자동 갱신 끔 (PANEL_AUTO_REFRESH=0). 패널 올릴 때만 API 호출');
  }

  const reqV = String(process.env.REQUIRE_USER_VERIFICATION ?? '1').trim().toLowerCase();
  const wantsAuth = !['0', 'false', 'off', 'no'].includes(reqV);
  if (wantsAuth && !isAuthEnforced()) {
    console.warn(
      '[본인인증] REQUIRE_USER_VERIFICATION 은 켜져 있으나 AUTH_PUBLIC_BASE_URL·AUTH_STATE_SECRET·DISCORD_CLIENT_SECRET·OAUTH_REDIRECT_URI·DISCORD_CLIENT_ID 가 불충분합니다. 인증 요구가 꺼진 것처럼 동작합니다.'
    );
  } else if (isAuthEnforced()) {
    console.log('[본인인증] 활성: 내정보·충전·송금 전 Discord OAuth + 휴대폰 인증 필요');
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === '자판기패널') {
        const canPost =
          interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
          store.isSuperOwner(interaction.user.id);
        if (!canPost) {
          return interaction.reply({
            content: 'Discord **서버 관리** 권한이 있는 멤버 또는 **최고 관리자**만 패널을 올릴 수 있어요.',
            flags: MessageFlags.Ephemeral,
          });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        reloadConfig();
        const payload = await buildOtcPanel();
        const msg = await interaction.channel.send(payload);
        if (interaction.guildId) {
          saveOtcPanelMessageRef(interaction.guildId, msg.channel.id, msg.id);
        }
        const ri = getPanelRefreshIntervalSeconds();
        return interaction.editReply({
          content:
            ri > 0
              ? `OTC 패널을 채널에 올렸습니다. (이 길드에서 올린 패널은 최대 ${getMaxPanelRefsPerGuild()}개까지 ${ri}초마다 함께 갱신됩니다)`
              : 'OTC 패널을 채널에 올렸습니다. (자동 갱신은 꺼져 있어, 올릴 때만 시세를 불러옵니다)',
        });
      }

      if (interaction.commandName === '관리자명령어') {
        const sub = interaction.options.getString('명령', true);
        if (sub === '운영자추가' || sub === '운영자제거') {
          if (!store.isSuperOwner(interaction.user.id)) {
            return interaction.reply({
              content: '**최고 관리자**만 운영자를 추가·제거할 수 있어요.',
              flags: MessageFlags.Ephemeral,
            });
          }
          return interaction.showModal(buildAdminManageModal(sub === '운영자추가' ? 'add' : 'remove'));
        }
        if (sub === '송금한도') {
          if (!canManageSendLimit(interaction)) {
            return interaction.reply({
              content: '**서버 관리** 권한이 있는 멤버 또는 **최고 관리자**만 송금 한도를 바꿀 수 있어요.',
              flags: MessageFlags.Ephemeral,
            });
          }
          return interaction.showModal(buildSendLimitModal());
        }
      }
    }

    if (interaction.isButton() && interaction.customId.startsWith('csend:')) {
      const sendToken = interaction.customId.slice('csend:'.length);
      prunePendingSends();
      const payload = pendingCryptoSends.get(sendToken);
      if (!payload) {
        return interaction.reply({
          content: '유효 시간이 지났거나 이미 처리된 요청이에요. 송금 메뉴에서 다시 진행해 주세요.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (payload.userId !== interaction.user.id) {
        return interaction.reply({ content: '본인이 신청한 송금만 확정할 수 있어요.', flags: MessageFlags.Ephemeral });
      }
      if (Date.now() - payload.createdAt > PENDING_SEND_TTL_MS) {
        pendingCryptoSends.delete(sendToken);
        return interaction.reply({ content: '시간 초과. 다시 신청해 주세요.', flags: MessageFlags.Ephemeral });
      }

      if (isAuthEnforced() && !store.isUserVerified(payload.guildId, payload.userId)) {
        return interaction.reply({
          content: '본인 인증이 완료되지 않았어요. 패널에서 **본인인증**으로 다시 진행해 주세요.',
          flags: MessageFlags.Ephemeral,
        });
      }
      {
        const block = await gateVendingMemberOrExplain(interaction);
        if (block) {
          return interaction.reply({ content: block, flags: MessageFlags.Ephemeral });
        }
      }
      {
        const chk = store.checkSendKrwAllowed(payload.guildId, payload.userId, payload.krw);
        if (!chk.ok) {
          return interaction.reply({
            content: formatSendLimitViolationMessage(chk),
            flags: MessageFlags.Ephemeral,
          });
        }
      }
      {
        const minK = getMinSendKrwForInteraction(interaction);
        if (payload.krw < minK) {
          return interaction.reply({
            content: formatMinSendKrwReply(minK),
            flags: MessageFlags.Ephemeral,
          });
        }
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const ok = store.tryDeduct(payload.guildId, payload.userId, payload.krw);
      if (!ok) {
        pendingCryptoSends.delete(sendToken);
        return interaction.editReply({ content: '잔액이 부족해요. 다시 시도해 주세요.' });
      }

      const sendStartedAt = Date.now();
      let progressIv = null;
      const tickProgress = async () => {
        try {
          await interaction.editReply({
            embeds: [buildCryptoSendProgressEmbed(payload, Date.now() - sendStartedAt)],
            components: [],
          });
        } catch {
          if (progressIv) clearInterval(progressIv);
        }
      };
      await tickProgress();
      progressIv = setInterval(tickProgress, 1100);

      try {
        let txid;
        if (payload.coin === 'btc') {
          txid = await btc.sendBtcToAddress(payload.address, payload.netCrypto);
        } else {
          txid = await ltc.sendLtcToAddress(payload.address, payload.netCrypto);
        }
        if (progressIv) {
          clearInterval(progressIv);
          progressIv = null;
        }
        pendingCryptoSends.delete(sendToken);
        const sym = payload.coin === 'btc' ? 'BTC' : 'LTC';
        store.appendLedger({
          guildId: payload.guildId,
          userId: payload.userId,
          type: 'send_crypto',
          text: `${sym} 전송 −${payload.krw.toLocaleString('ko-KR')}원 → **${payload.netCrypto}** ${sym}`,
          meta: { coin: payload.coin, krw: payload.krw, txid, address: payload.address },
        });
        store.addCumulativeSendVolume(payload.guildId, payload.userId, payload.krw);
        store.addDailySendVolume(payload.guildId, payload.userId, payload.krw);
        reloadConfig();
        tierRoles.syncTierRolesForUser(client, payload.guildId, payload.userId, config.raw).catch((e) =>
          console.warn('[송금 후 등급 역할 동기화]', e.message || e)
        );
        refreshOtcPanelMessages().catch((e) => console.warn('[송금 후 패널 갱신]', e.message || e));
        return interaction.editReply({
          embeds: [buildCryptoSendDoneEmbed(payload, txid)],
          components: [],
        });
      } catch (e) {
        if (progressIv) {
          clearInterval(progressIv);
          progressIv = null;
        }
        store.addBalance(payload.guildId, payload.userId, payload.krw);
        pendingCryptoSends.delete(sendToken);
        console.error('[코인 전송 실패]', e);
        return interaction.editReply({
          embeds: [buildCryptoSendFailEmbed(payload, e.message || e)],
          components: [],
        });
      }
    }

    if (interaction.isButton() && (interaction.customId.startsWith('charge_ok:') || interaction.customId.startsWith('charge_no:'))) {
      const approve = interaction.customId.startsWith('charge_ok:');
      const pendingId = interaction.customId.split(':')[1];
      if (!pendingId) {
        return interaction.reply({ content: '잘못된 요청이에요.', flags: MessageFlags.Ephemeral });
      }
      if (!canApproveCharges(interaction)) {
        return interaction.reply({
          content: '**서버 관리** 권한, 등록 **운영자**, 또는 **최고 관리자**만 수락·거절할 수 있어요.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (approve) {
        const res = store.tryApprovePendingCharge(pendingId, interaction.user.id);
        if (!res.ok) {
          const ko = {
            not_found: '이미 처리되었거나 없는 신청이에요.',
            expired: '신청 유효 시간이 지났어요. 사용자에게 다시 신청하도록 안내해 주세요.',
          };
          return interaction.reply({
            content: ko[res.reason] || `처리 실패: ${res.reason}`,
            flags: MessageFlags.Ephemeral,
          });
        }
        notifyChargeComplete(res.userId, res.amount).catch(() => {});
        refreshOtcPanelMessages().catch((e) => console.warn('[충전승인 후 패널 갱신]', e.message || e));
        const done = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle('✅ 충전 수락 완료')
          .setDescription(
            `<@${res.userId}> 님에게 **${res.amount.toLocaleString('ko-KR')}** 원이 반영되었습니다.`
          )
          .addFields(
            { name: '처리자', value: `${interaction.user.tag} (\`${interaction.user.id}\`)`, inline: false }
          )
          .setTimestamp();
        try {
          await interaction.update({ embeds: [done], components: [] });
        } catch {
          await interaction.reply({ content: '메시지를 갱신하지 못했지만 잔액 반영은 완료되었어요.', flags: MessageFlags.Ephemeral });
        }
        return;
      }
      const rej = store.tryRejectPendingCharge(pendingId, interaction.user.id);
      if (!rej.ok) {
        const ko = { not_found: '이미 처리되었거나 없는 신청이에요.' };
        return interaction.reply({
          content: ko[rej.reason] || `처리 실패: ${rej.reason}`,
          flags: MessageFlags.Ephemeral,
        });
      }
      notifyChargeRejected(rej.userId).catch(() => {});
      const done = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('❌ 충전 거절됨')
        .setDescription(`신청자 <@${rej.userId}> — 잔액은 **변경되지 않았습니다.**`)
        .addFields({ name: '처리자', value: `${interaction.user.tag} (\`${interaction.user.id}\`)`, inline: false })
        .setTimestamp();
      try {
        await interaction.update({ embeds: [done], components: [] });
      } catch {
        await interaction.reply({ content: '메시지 갱신 실패(이미 처리됨일 수 있음).', flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'otc_main_select') {
      const gid = interaction.guildId;
      const uid = interaction.user.id;
      if (!gid) {
        return interaction.reply({ content: '서버에서만 사용하세요.', flags: MessageFlags.Ephemeral });
      }
      {
        const block = await gateVendingMemberOrExplain(interaction);
        if (block) {
          return interaction.reply({ content: block, flags: MessageFlags.Ephemeral });
        }
      }
      const choice = interaction.values[0];

      if (choice === 'myinfo') {
        const authMsg = gateVerifiedOrExplain(interaction);
        if (authMsg) {
          return interaction.reply({ content: authMsg, flags: MessageFlags.Ephemeral });
        }
        reloadConfig();
        const bal = store.getBalance(gid, uid);
        const tier = store.getTierAndFeeForUser(gid, uid);
        const dailyLim = store.getSendLimitKrw(gid, uid);
        const usedToday = store.getDailySendUsedKrw(gid, uid);
        const remainToday = Math.max(0, dailyLim - usedToday);
        const hist = store.getLedgerForUser(gid, uid, 15);
        const lines = hist.length
          ? hist.map((h) => `• ${h.at ? new Date(h.at).toLocaleString('ko-KR') : ''} — ${h.text}`).join('\n')
          : '아직 내역이 없어요.';
        const limitLines = [
          `• 오늘 **1일** 송금 한도: **${dailyLim.toLocaleString('ko-KR')}** 원  **(사용 ${usedToday.toLocaleString('ko-KR')} · 남음 ${remainToday.toLocaleString('ko-KR')})**`,
          '　※관리자에게 1일한도해제 요청 부탁해주세요',
        ];
        const authBlock = isAuthEnforced()
          ? ['### 본인 인증 · 송금 한도', '• 본인 인증: **완료**', ...limitLines, '']
          : ['### 송금 한도', ...limitLines, ''];
        const body = [
          '### 👤 내정보',
          `**원화 잔액:** **${bal.toLocaleString('ko-KR')}** 원`,
          '',
          ...authBlock,
          '### 등급 · 누적 송금액',
          `• 누적: **${tier.cumulativeKrw.toLocaleString('ko-KR')}** 원 (송금 확정 기준)`,
          `• 등급: **${tier.key}**`,
          `• 현재 **대행** 수수료: **${formatFeePctDisplay(tier.feeRate)}** (+ **네트워크 송금** 수수료는 전송마다 **변동**)`,
          '',
          '### 📜 최근 내역',
          lines.slice(0, 3500),
        ].join('\n');
        const box = cv2.container([cv2.textDisplay(body)]);
        tierRoles.syncTierRolesForUser(client, gid, uid, config.raw).catch((e) =>
          console.warn('[내정보 후 등급 역할 동기화]', e.message || e)
        );
        return interaction.reply({ ...cv2.v2Payload([box]), flags: EPHEMERAL_V2 });
      }

      if (choice === 'charge_request') {
        const authMsg = gateVerifiedOrExplain(interaction);
        if (authMsg) {
          return interaction.reply({ content: authMsg, flags: MessageFlags.Ephemeral });
        }
        return interaction.showModal(buildChargeRequestModal());
      }

      if (choice === 'transfer') {
        const authMsg = gateVerifiedOrExplain(interaction);
        if (authMsg) {
          return interaction.reply({ content: authMsg, flags: MessageFlags.Ephemeral });
        }
        return interaction.reply(buildTransferCoinSelectMessage());
      }

      if (choice === 'verify_link') {
        if (!isAuthEnforced()) {
          return interaction.reply({
            content: '이 서버에서는 본인 인증 연동이 꺼져 있거나 설정이 완료되지 않았어요.',
            flags: MessageFlags.Ephemeral,
          });
        }
        if (store.isUserVerified(gid, uid)) {
          return interaction.reply({
            content: '이미 본인 인증이 완료된 계정이에요. (필요 시 관리자에게 문의)',
            flags: MessageFlags.Ephemeral,
          });
        }
        return interaction.reply({ content: buildUserAuthLinkContent(gid, uid), flags: MessageFlags.Ephemeral });
      }

      if (choice === 'info') {
        reloadConfig();
        const lines = [
          '### 📖 이용 방법',
          '',
          '**잔액충전** — 패널 메뉴에서 신청할 수 있습니다.',
          '',
          '**본인 인증** — 서버 설정 시 **내정보·잔액충전·송금** 전에 Discord 로그인과 휴대폰 문자 인증이 필요합니다. (메뉴 **본인인증**)',
          '',
          '**송금** — 원화 잔액에서 차감한 뒤 **LTC** 또는 **BTC**를 입력한 주소로 보냅니다. **1회**당 최대 **500,000원**(고정)이며, **1일** 누적 송금 한도는 기본 **50,000원**입니다.',
          '',
          '**수수료** — **대행 수수료**는 누적 송금액·**등급**에 따라 **코인 수량에서 차감**됩니다. **블록체인 송금(네트워크) 수수료**는 등급 %와 별개로 **전송마다 변동**하며, 송금 확인·진행 화면에서도 함께 안내됩니다.',
          '',
          tiers.buildTierInfoLines(),
        ];
        const box = cv2.container([cv2.textDisplay(lines.join('\n'))]);
        return interaction.reply({ ...cv2.v2Payload([box]), flags: EPHEMERAL_V2 });
      }

      if (choice === 'calculator') {
        return interaction.showModal(buildCalculatorModal());
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'transfer_pick_coin') {
      const block = await gateVendingMemberOrExplain(interaction);
      if (block) {
        return interaction.reply({ content: block, flags: MessageFlags.Ephemeral });
      }
      const coin = interaction.values[0] === 'btc' ? 'btc' : 'ltc';
      return interaction.showModal(buildTransferFiatModal(coin));
    }

    if (interaction.isModalSubmit() && interaction.customId === 'charge_bank_modal') {
      const gid = interaction.guildId;
      const uid = interaction.user.id;
      if (!gid) {
        return interaction.reply({ content: '서버에서만 사용하세요.', flags: MessageFlags.Ephemeral });
      }
      {
        const block = await gateVendingMemberOrExplain(interaction);
        if (block) {
          return interaction.reply({ content: block, flags: MessageFlags.Ephemeral });
        }
      }
      const authMsg = gateVerifiedOrExplain(interaction);
      if (authMsg) {
        return interaction.reply({ content: authMsg, flags: MessageFlags.Ephemeral });
      }
      reloadConfig();
      const depositorName = (interaction.fields.getTextInputValue('depositor_name') || '').trim();
      const amountRaw = (interaction.fields.getTextInputValue('amount_won') || '').trim().replace(/,/g, '');
      const amount = Math.floor(Number(amountRaw));
      if (!depositorName || depositorName.length < 2) {
        return interaction.reply({ content: '입금자명을 정확히 입력해 주세요.', flags: MessageFlags.Ephemeral });
      }
      if (!Number.isFinite(amount) || amount < 1 || amount > 100_000_000) {
        return interaction.reply({ content: '금액은 1원 ~ 1억 원 사이로 입력해 주세요.', flags: MessageFlags.Ephemeral });
      }
      const res = store.addPending(gid, uid, depositorName, amount);
      if (!res.ok) {
        return interaction.reply({
          content: '이미 처리 중인 충전 신청이 있어요. 입금·자동 충전이 끝난 뒤 다시 신청해 주세요.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const panelRes = await postChargeApprovalRequest(interaction, res.id, depositorName, amount);
      const approvalOn = !!getChargeApprovalChannelId();
      const expireMsTotal = store.getPendingExpireMs();
      const chargeTickStartedAt = Date.now();
      await interaction.reply(
        buildChargeSubmitConfirmPayload(depositorName, amount, res.id, approvalOn, panelRes, expireMsTotal)
      );
      const chargeRemainIv = setInterval(async () => {
        const remain = Math.max(0, expireMsTotal - (Date.now() - chargeTickStartedAt));
        try {
          await interaction.editReply(
            buildChargeSubmitConfirmPayload(depositorName, amount, res.id, approvalOn, panelRes, remain)
          );
        } catch {
          clearInterval(chargeRemainIv);
          return;
        }
        if (remain <= 0) clearInterval(chargeRemainIv);
      }, 1000);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('admin_manage_modal:')) {
      const mode = interaction.customId.split(':')[1];
      if (!store.isSuperOwner(interaction.user.id)) {
        return interaction.reply({ content: '최고 관리자만 이 모달을 쓸 수 있어요.', flags: MessageFlags.Ephemeral });
      }
      const raw = (interaction.fields.getTextInputValue('admin_target_user_id') || '').trim();
      const res =
        mode === 'add'
          ? store.addExtraAdmin(interaction.user.id, raw)
          : store.removeExtraAdmin(interaction.user.id, raw);
      const reasonKo = {
        forbidden: '권한 없음',
        invalid_id: '사용자 ID 형식이 올바르지 않아요 (17~20자리 숫자).',
        already_super: '이미 최고 관리자입니다.',
        already_admin: '이미 운영자 목록에 있습니다.',
        cannot_remove_super: '최고 관리자는 제거할 수 없어요.',
        not_in_list: '운영자 목록에 없는 ID예요.',
      };
      if (!res.ok) {
        return interaction.reply({
          content: reasonKo[res.reason] || `처리 실패: ${res.reason}`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.reply({
        content:
          mode === 'add'
            ? `✅ 운영자 목록에 추가했어요: \`${res.targetId}\``
            : `✅ 운영자에서 제거했어요: \`${res.targetId}\``,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.isModalSubmit() && interaction.customId === 'admin_send_limit_modal') {
      if (!interaction.guildId) {
        return interaction.reply({ content: '서버에서만 사용하세요.', flags: MessageFlags.Ephemeral });
      }
      if (!canManageSendLimit(interaction)) {
        return interaction.reply({
          content: '**서버 관리** 권한 또는 **최고 관리자**만 송금 한도를 바꿀 수 있어요.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const gid = interaction.guildId;
      const rawId = (interaction.fields.getTextInputValue('limit_target_user_id') || '').trim();
      const tid = String(rawId).replace(/\D/g, '');
      if (tid.length < 17 || tid.length > 20) {
        return interaction.reply({ content: '대상 사용자 ID 형식이 올바르지 않아요.', flags: MessageFlags.Ephemeral });
      }
      const limRaw = (interaction.fields.getTextInputValue('limit_krw') || '').trim().replace(/,/g, '');
      const lim = Math.floor(Number(limRaw));
      if (!Number.isFinite(lim) || lim < 1000) {
        return interaction.reply({ content: '한도는 **1,000원 이상**으로 입력해 주세요.', flags: MessageFlags.Ephemeral });
      }
      const res = store.setSendLimitKrw(gid, tid, lim, interaction.user.id);
      if (!res.ok) {
        return interaction.reply({ content: '한도 값이 허용 범위를 벗어났어요. (최대 1억 원)', flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({
        content: `✅ 사용자 \`${tid}\` 의 **1일** 송금 한도를 **${res.limitKrw.toLocaleString('ko-KR')}** 원으로 설정했어요. (1회 상한 **500,000** 원은 고정)`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('transfer_fiat_modal:')) {
      const coin = interaction.customId.replace('transfer_fiat_modal:', '') === 'btc' ? 'btc' : 'ltc';
      const gid = interaction.guildId;
      const uid = interaction.user.id;
      if (!gid) {
        return interaction.reply({ content: '서버에서만 사용하세요.', flags: MessageFlags.Ephemeral });
      }
      {
        const block = await gateVendingMemberOrExplain(interaction);
        if (block) {
          return interaction.reply({ content: block, flags: MessageFlags.Ephemeral });
        }
      }
      const authMsg = gateVerifiedOrExplain(interaction);
      if (authMsg) {
        return interaction.reply({ content: authMsg, flags: MessageFlags.Ephemeral });
      }

      const krwRaw = (interaction.fields.getTextInputValue('krw_amount') || '').trim().replace(/,/g, '');
      const krw = Math.floor(Number(krwRaw));
      const address = (interaction.fields.getTextInputValue('withdraw_address') || '').trim();

      const minSend = getMinSendKrwForInteraction(interaction);
      if (!Number.isFinite(krw) || krw < minSend) {
        return interaction.reply({ content: formatMinSendKrwReply(minSend), flags: MessageFlags.Ephemeral });
      }
      const perTxMax = store.getPerTxSendMaxKrw();
      if (krw > perTxMax) {
        return interaction.reply({
          content: `1회 송금은 최대 **${perTxMax.toLocaleString('ko-KR')}** 원까지 가능해요.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (coin === 'btc') {
        if (!btc.validateBtcAddress(address)) {
          return interaction.reply({ content: '비트코인 주소 형식이 올바르지 않아요.', flags: MessageFlags.Ephemeral });
        }
      } else if (!ltc.validateLtcAddress(address)) {
        return interaction.reply({ content: 'Litecoin 주소 형식이 올바르지 않아요.', flags: MessageFlags.Ephemeral });
      }

      const bal = store.getBalance(gid, uid);
      if (bal < krw) {
        return interaction.reply({
          content: `잔액이 부족해요. (보유 **${bal.toLocaleString('ko-KR')}** 원 / 필요 **${krw.toLocaleString('ko-KR')}** 원)`,
          flags: MessageFlags.Ephemeral,
        });
      }

      {
        const chk = store.checkSendKrwAllowed(gid, uid, krw);
        if (!chk.ok) {
          return interaction.reply({
            content: formatSendLimitViolationMessage(chk),
            flags: MessageFlags.Ephemeral,
          });
        }
      }

      let priceKrw;
      let priceFieldName = '빗썸 시세';
      try {
        priceKrw = await prices.fetchBithumbCoinKrw(coin);
      } catch (e) {
        if (coin === 'ltc') {
          try {
            priceKrw = await prices.fetchIndirectLtcKrw();
            priceFieldName = '간접 시세 (USDT 경유)';
          } catch {
            return interaction.reply({
              content: `시세 조회에 실패했어요. 잠시 후 다시 시도해 주세요.\n\`${e.message || e}\``,
              flags: MessageFlags.Ephemeral,
            });
          }
        } else {
          return interaction.reply({
            content: `시세 조회에 실패했어요. 잠시 후 다시 시도해 주세요.\n\`${e.message || e}\``,
            flags: MessageFlags.Ephemeral,
          });
        }
      }
      if (!Number.isFinite(priceKrw) || priceKrw <= 0) {
        return interaction.reply({ content: '시세가 올바르지 않아요.', flags: MessageFlags.Ephemeral });
      }

      const feeRate = store.getFeeRateForUser(gid, uid);
      const feeLabel = formatFeePctDisplay(feeRate);
      const grossCrypto =
        coin === 'btc'
          ? btc.roundBtc8(krw / priceKrw)
          : ltc.roundLtc8(krw / priceKrw);
      const tierNetCrypto =
        coin === 'btc' ? btc.netBtcAfterFee(grossCrypto, feeRate) : ltc.netLtcAfterFee(grossCrypto, feeRate);

      if (tierNetCrypto <= 0 || grossCrypto <= 0) {
        return interaction.reply({ content: '계산된 코인 수량이 너무 작아요. 금액을 늘려 주세요.', flags: MessageFlags.Ephemeral });
      }

      let chainFeeCrypto = 0;
      try {
        chainFeeCrypto =
          coin === 'btc' ? await btc.getEstimatedOnChainSendFeeBtc() : await ltc.getEstimatedOnChainSendFeeLtc();
      } catch {
        chainFeeCrypto = coin === 'btc' ? btc.roundBtc8(0.00005) : ltc.roundLtc8(0.0001);
      }
      const netCrypto =
        coin === 'btc'
          ? btc.roundBtc8(tierNetCrypto - chainFeeCrypto)
          : ltc.roundLtc8(tierNetCrypto - chainFeeCrypto);
      if (netCrypto <= 0) {
        const sym0 = coin === 'btc' ? 'BTC' : 'LTC';
        return interaction.reply({
          content: `추정 온체인 수수료(**${chainFeeCrypto}** ${sym0})를 제외하면 전송 수량이 0 이하가 됩니다. 금액을 늘려 주세요.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      prunePendingSends();
      const sendToken = crypto.randomBytes(12).toString('hex');
      pendingCryptoSends.set(sendToken, {
        guildId: gid,
        userId: uid,
        coin,
        krw,
        address,
        grossCrypto,
        tierNetCrypto,
        chainFeeCrypto,
        netCrypto,
        priceKrw,
        feeRate,
        feeLabel,
        createdAt: Date.now(),
      });

      const sym = coin === 'btc' ? 'BTC' : 'LTC';
      const confirmFields = [
        { name: '차감 원화', value: `**${krw.toLocaleString('ko-KR')}** 원`, inline: true },
        { name: priceFieldName, value: `**${Math.round(priceKrw).toLocaleString('ko-KR')}** 원/${sym}`, inline: true },
        { name: `환산 ${sym} (대행 수수료 전)`, value: `**${grossCrypto}**`, inline: false },
        { name: `대행 ${feeLabel} 반영 후`, value: `**${tierNetCrypto}** ${sym}`, inline: false },
      ];
      if (chainFeeCrypto > 0) {
        confirmFields.push({
          name: '추정 온체인 수수료',
          value: `**${chainFeeCrypto}** ${sym} (수령 수량에서 차감 · 노드 실제와 다를 수 있음)`,
          inline: false,
        });
      }
      confirmFields.push(
        { name: '전송 수량 (수령)', value: `**${netCrypto}** ${sym}`, inline: false },
        {
          name: '네트워크 송금',
          value:
            chainFeeCrypto > 0
              ? `위 추정분 반영. 그 외 노드·혼잡도에 따라 실비가 달라질 수 있어요.`
              : '**변동** · 체인·노드 기준(대행 %와 별개)',
          inline: false,
        },
        { name: '수령 주소', value: `\`${address}\``, inline: false }
      );

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`📤 ${sym} 송금 확인`)
        .addFields(confirmFields)
        .setFooter({ text: '전송하기를 누르면 잔액이 차감되고 코인이 전송됩니다.' })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`csend:${sendToken}`)
          .setLabel('전송하기')
          .setStyle(ButtonStyle.Success)
      );

      return interaction.reply({
        embeds: [embed],
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.isModalSubmit() && interaction.customId === 'krw_ltc_calc_modal') {
      const krwRaw = (interaction.fields.getTextInputValue('calc_krw_amount') || '').trim().replace(/,/g, '');
      const krw = Math.floor(Number(krwRaw));
      const minCalc = getMinSendKrwForInteraction(interaction);
      if (!Number.isFinite(krw) || krw < minCalc) {
        return interaction.reply({
          content: formatMinSendKrwReply(minCalc),
          flags: MessageFlags.Ephemeral,
        });
      }
      if (krw > 100_000_000) {
        return interaction.reply({
          content: '**1억 원 이하**로 입력해 주세요.',
          flags: MessageFlags.Ephemeral,
        });
      }
      await interaction.deferReply({ flags: EPHEMERAL_V2 });
      let market;
      try {
        market = await prices.getMarketSnapshot();
      } catch (e) {
        return interaction.editReply({
          content: `시세 조회에 실패했어요. 잠시 후 다시 시도해 주세요.\n\`${e.message || e}\``,
        });
      }
      const refKrw = market.refKrw;
      if (!Number.isFinite(refKrw) || refKrw <= 0) {
        return interaction.editReply({
          content:
            'LTC 원화 시세를 가져오지 못했어요. (빗썸·CoinGecko·업비트 직접 호가 + 바이낸스/바이빗×USDT 간접 시세까지 모두 실패)\n' +
            'Node가 **아웃바운드 HTTPS**를 쓸 수 있는지(백신·방화벽·회사망·DNS·VPN) 확인한 뒤 잠시 후 다시 시도해 주세요.',
        });
      }
      const gid = interaction.guildId;
      const uid = interaction.user.id;
      const feeRate = gid ? store.getFeeRateForUser(gid, uid) : 0.06;
      const feeLbl = formatFeePctDisplay(feeRate);
      const grossLtc = ltc.roundLtc8(krw / refKrw);
      const netLtc = ltc.netLtcAfterFee(grossLtc, feeRate);
      if (grossLtc <= 0 || netLtc <= 0) {
        return interaction.editReply({ content: '환산된 LTC 수량이 너무 작아요. 금액을 늘려 주세요.' });
      }
      const lines = [
        '### 🧮 계산 결과',
        `• 입력 원화: **${krw.toLocaleString('ko-KR')}** 원`,
        gid
          ? `• 내 등급 기준 **대행** 수수료: **${feeLbl}** (+ **네트워크 송금** 수수료는 전송마다 **변동**)`
          : '• **대행** 수수료: **6%** (서버 밖 USER 기준) + **네트워크 송금** 수수료 **변동**',
        '',
        '### 💎 LTC 환산',
        `• 대행 수수료 **전**: **${grossLtc}** LTC`,
        `• 대행 **${feeLbl}** 반영 후 (송금 시와 동일): **${netLtc}** LTC`,
      ];
      const box = cv2.container([cv2.textDisplay(lines.join('\n'))]);
      return interaction.editReply({ ...cv2.v2Payload([box]) });
    }
  } catch (err) {
    console.error(err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: '처리 중 오류가 발생했습니다.', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: '처리 중 오류가 발생했습니다.', flags: MessageFlags.Ephemeral });
      }
    } catch (_) {}
  }
});

client.login(token);

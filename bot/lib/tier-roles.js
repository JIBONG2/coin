/**
 * 코인 자판기 회원 역할 · 누적 송금액 기준 등급 역할 동기화
 */

const tiers = require('./tiers');
const store = require('../store');

const TIER_KEYS_WITH_ROLE = ['BUYER', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'];

function normalizeRoleId(raw) {
  const s = String(raw || '').trim();
  return /^\d{17,20}$/.test(s) ? s : '';
}

function getVendingMemberRoleIdFromRaw(rawConfig) {
  const env = process.env.VENDING_MEMBER_ROLE_ID && String(process.env.VENDING_MEMBER_ROLE_ID).trim();
  if (env) {
    const e = normalizeRoleId(env);
    if (e) return e;
  }
  const vr =
    rawConfig && rawConfig.vendingRoles && typeof rawConfig.vendingRoles === 'object'
      ? rawConfig.vendingRoles
      : {};
  return normalizeRoleId(vr.memberRoleId);
}

function getTierRoleIdMapFromRaw(rawConfig) {
  const vr =
    rawConfig && rawConfig.vendingRoles && typeof rawConfig.vendingRoles === 'object'
      ? rawConfig.vendingRoles
      : {};
  const m = vr.tierRoleIds && typeof vr.tierRoleIds === 'object' ? vr.tierRoleIds : {};
  const out = {};
  for (const k of TIER_KEYS_WITH_ROLE) {
    const id = normalizeRoleId(m[k]);
    if (id) out[k] = id;
  }
  return out;
}

function allMappedTierRoleIds(map) {
  return [...new Set(Object.values(map))];
}

/**
 * 누적 송금액 → 등급에 맞춰 등급 역할만 정리(기존 등급 역할 제거 후 해당 등급 1개 부여, USER면 전부 제거)
 * @returns {Promise<{ ok: boolean, skipped?: boolean, reason?: string }>}
 */
async function syncTierRolesForUser(client, guildId, userId, rawConfig) {
  const map = getTierRoleIdMapFromRaw(rawConfig);
  const allIds = allMappedTierRoleIds(map);
  if (allIds.length === 0) return { ok: true, skipped: true };

  let guild;
  try {
    guild = await client.guilds.fetch(String(guildId));
  } catch {
    return { ok: false, reason: 'guild_fetch' };
  }

  let member;
  try {
    member = await guild.members.fetch(String(userId));
  } catch {
    return { ok: false, reason: 'member_fetch' };
  }

  const vol = store.getCumulativeVolume(guildId, userId);
  const tier = tiers.getTierForVolume(vol);
  const wantRole = tier.key !== 'USER' && map[tier.key] ? map[tier.key] : null;

  const toRemove = allIds.filter((id) => member.roles.cache.has(id));
  try {
    if (toRemove.length) {
      await member.roles.remove(toRemove, '누적 송금액 기준 등급 역할 동기화');
    }
    if (wantRole && !member.roles.cache.has(wantRole)) {
      await member.roles.add(wantRole, '누적 송금액 기준 등급 역할 동기화');
    }
  } catch (e) {
    console.warn('[등급 역할 동기화 실패]', guildId, userId, e.message || e);
    return { ok: false, reason: 'discord_roles' };
  }

  return { ok: true };
}

module.exports = {
  getVendingMemberRoleIdFromRaw,
  getTierRoleIdMapFromRaw,
  syncTierRolesForUser,
  TIER_KEYS_WITH_ROLE,
};

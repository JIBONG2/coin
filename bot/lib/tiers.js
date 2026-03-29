/**
 * 누적 송금 원화 기준 등급·대행 수수료 (코인 수량에서 차감)
 * USER 0원 6% → DIAMOND 1,500만원+ 4.5%
 */

/** min 이상이면 해당 등급 (높은 구간 우선) */
const TIERS_BY_MIN_DESC = [
  { key: 'DIAMOND', min: 15_000_000, fee: 0.045 },
  { key: 'PLATINUM', min: 7_500_000, fee: 0.047 },
  { key: 'GOLD', min: 1_500_000, fee: 0.05 },
  { key: 'SILVER', min: 700_000, fee: 0.053 },
  { key: 'BRONZE', min: 300_000, fee: 0.055 },
  { key: 'BUYER', min: 10_000, fee: 0.057 },
  { key: 'USER', min: 0, fee: 0.06 },
];

const TIER_LABELS = {
  USER: 'USER (0$) · 누적 0원',
  BUYER: 'BUYER (10$) · 누적 10,000원~',
  BRONZE: 'BRONZE (200$) · 누적 300,000원~',
  SILVER: 'SILVER (500$) · 누적 700,000원~',
  GOLD: 'GOLD (1000$) · 누적 1,500,000원~',
  PLATINUM: 'PLATINUM (5000$) · 누적 7,500,000원~',
  DIAMOND: 'DIAMOND (10000$) · 누적 15,000,000원~',
};

function getTierForVolume(cumulativeKrw) {
  const v = Math.max(0, Math.floor(Number(cumulativeKrw) || 0));
  for (const t of TIERS_BY_MIN_DESC) {
    if (v >= t.min) {
      return {
        key: t.key,
        min: t.min,
        feeRate: t.fee,
        cumulativeKrw: v,
        label: TIER_LABELS[t.key] || t.key,
      };
    }
  }
  const u = TIERS_BY_MIN_DESC[TIERS_BY_MIN_DESC.length - 1];
  return { key: u.key, min: u.min, feeRate: u.fee, cumulativeKrw: v, label: TIER_LABELS[u.key] };
}

function feePercentLabel(feeRate) {
  const pct = feeRate * 100;
  return (Math.round(pct * 100) / 100).toString().replace(/\.?0+$/, '') + '%';
}

/** 등급 % 옆에 붙이는 공통 문구 — 대행 + 네트워크 송금 수수료 함께 고지 */
const TIER_FEE_NETWORK_SUFFIX = ' + **네트워크 송금 수수료**(변동)';

/** 안내용 등급표 텍스트 (이용방법 메뉴) */
function buildTierInfoLines() {
  const rows = [
    '### ✨ 등급별 수수료',
    '-# 누적 송금액(원화) 기준 **대행 수수료** + **블록체인 송금(네트워크) 수수료**(전송마다 변동)',
    '',
    '**USER**',
    `　**0원** 이상 · 대행 **6%**${TIER_FEE_NETWORK_SUFFIX}`,
    '',
    '**BUYER**',
    `　**10,000원** 이상 · 대행 **5.7%**${TIER_FEE_NETWORK_SUFFIX}`,
    '',
    '**BRONZE**',
    `　**300,000원** 이상 · 대행 **5.5%**${TIER_FEE_NETWORK_SUFFIX}`,
    '',
    '**SILVER**',
    `　**700,000원** 이상 · 대행 **5.3%**${TIER_FEE_NETWORK_SUFFIX}`,
    '',
    '**GOLD**',
    `　**1,500,000원** 이상 · 대행 **5%**${TIER_FEE_NETWORK_SUFFIX}`,
    '',
    '**PLATINUM**',
    `　**7,500,000원** 이상 · 대행 **4.7%**${TIER_FEE_NETWORK_SUFFIX}`,
    '',
    '**DIAMOND**',
    `　**15,000,000원** 이상 · 대행 **4.5%**${TIER_FEE_NETWORK_SUFFIX}`,
    '',
    '-# 네트워크 수수료는 노드·체인 혼잡도에 따라 달라지며, **대행 %와 별개**로 발생합니다.',
  ];
  return rows.join('\n');
}

module.exports = {
  getTierForVolume,
  feePercentLabel,
  buildTierInfoLines,
  TIER_FEE_NETWORK_SUFFIX,
  TIERS_BY_MIN_DESC,
};

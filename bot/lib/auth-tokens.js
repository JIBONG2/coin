const crypto = require('crypto');

/**
 * 본인 인증 시작 URL용 HMAC 토큰 (guildId, userId, exp)
 */
function signUserAuthStartToken(guildId, userId, secret) {
  const s = String(secret || '').trim();
  if (!s) return '';
  const payload = {
    g: String(guildId),
    u: String(userId),
    exp: Date.now() + 25 * 60 * 1000,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', s).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyUserAuthStartToken(token, secret) {
  const s = String(secret || '').trim();
  if (!s || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', s).update(body).digest('base64url');
  try {
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
  } catch {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  if (!payload.g || !payload.u) return null;
  return { guildId: String(payload.g), userId: String(payload.u) };
}

module.exports = { signUserAuthStartToken, verifyUserAuthStartToken };

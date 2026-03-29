const crypto = require('crypto');
const express = require('express');
const store = require('../store');
const { verifyUserAuthStartToken } = require('./auth-tokens');

const jsonParser = express.json();

function parseCookies(header) {
  const o = {};
  const raw = header && typeof header === 'string' ? header : '';
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      o[k] = decodeURIComponent(v);
    } catch {
      o[k] = v;
    }
  });
  return o;
}

function setAuthCookie(res, sid) {
  res.setHeader(
    'Set-Cookie',
    `auth_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 60}`
  );
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', 'auth_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeKrToE164(input) {
  const d = String(input || '').replace(/\D/g, '');
  if (d.length < 9) return null;
  if (d.startsWith('82')) return `+${d}`;
  if (d.startsWith('0')) return `+82${d.slice(1)}`;
  if (d.startsWith('1') && d.length === 10) return `+82${d}`;
  return `+82${d}`;
}

/** @type {Map<string, { guildId: string, userId: string, exp: number, oauthOk?: boolean, phoneE164?: string, sendCount?: number, lastSendAt?: number, devCode?: string }>} */
const sessions = new Map();

function pruneSessions() {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (v.exp < now) sessions.delete(k);
  }
}

setInterval(pruneSessions, 60 * 1000).unref();

async function twilioCreateVerification(e164) {
  const sid = process.env.TWILIO_ACCOUNT_SID && String(process.env.TWILIO_ACCOUNT_SID).trim();
  const token = process.env.TWILIO_AUTH_TOKEN && String(process.env.TWILIO_AUTH_TOKEN).trim();
  const svc = process.env.TWILIO_VERIFY_SERVICE_SID && String(process.env.TWILIO_VERIFY_SERVICE_SID).trim();
  if (!sid || !token || !svc) return { ok: false, reason: 'twilio_not_configured' };
  const url = `https://verify.twilio.com/v2/Services/${encodeURIComponent(svc)}/Verifications`;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const body = new URLSearchParams({ To: e164, Channel: 'sms' });
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, reason: 'twilio_error', message: t.slice(0, 200) };
  }
  return { ok: true };
}

async function twilioCheckVerification(e164, code) {
  const sid = process.env.TWILIO_ACCOUNT_SID && String(process.env.TWILIO_ACCOUNT_SID).trim();
  const token = process.env.TWILIO_AUTH_TOKEN && String(process.env.TWILIO_AUTH_TOKEN).trim();
  const svc = process.env.TWILIO_VERIFY_SERVICE_SID && String(process.env.TWILIO_VERIFY_SERVICE_SID).trim();
  const url = `https://verify.twilio.com/v2/Services/${encodeURIComponent(svc)}/VerificationCheck`;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const body = new URLSearchParams({ To: e164, Code: String(code || '').trim() });
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== 'approved') return { ok: false, reason: 'bad_code' };
  return { ok: true };
}

function phoneAuthMode() {
  return String(process.env.PHONE_AUTH_MODE || '').trim().toLowerCase();
}

/**
 * @param {import('express').Express} app
 */
function mountUserAuth(app) {
  const stateSecret = process.env.AUTH_STATE_SECRET && String(process.env.AUTH_STATE_SECRET).trim();
  const clientId = process.env.DISCORD_CLIENT_ID && String(process.env.DISCORD_CLIENT_ID).trim();
  const clientSecret = process.env.DISCORD_CLIENT_SECRET && String(process.env.DISCORD_CLIENT_SECRET).trim();
  const redirectUri = process.env.OAUTH_REDIRECT_URI && String(process.env.OAUTH_REDIRECT_URI).trim();
  const publicBase = String(process.env.AUTH_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');

  app.get('/auth/start', (req, res) => {
    if (!stateSecret || !clientId || !clientSecret || !redirectUri || !publicBase) {
      return res.status(503).type('html')
        .send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>설정 필요</title></head><body>
        <p>본인 인증 서버가 아직 설정되지 않았습니다. <code>AUTH_PUBLIC_BASE_URL</code>, <code>OAUTH_REDIRECT_URI</code>, <code>DISCORD_CLIENT_SECRET</code>, <code>AUTH_STATE_SECRET</code> 를 확인하세요.</p>
        </body></html>`);
    }
    const tok = req.query.token;
    const payload = verifyUserAuthStartToken(tok, stateSecret);
    if (!payload) {
      return res.status(400).type('html').send('<!DOCTYPE html><html><body><p>링크가 잘못되었거나 만료되었습니다. 디스코드에서 다시 시도해 주세요.</p></body></html>');
    }
    pruneSessions();
    const sid = crypto.randomBytes(20).toString('hex');
    sessions.set(sid, {
      guildId: payload.guildId,
      userId: payload.userId,
      exp: Date.now() + 30 * 60 * 1000,
    });
    setAuthCookie(res, sid);
    const authUrl = new URL('https://discord.com/api/oauth2/authorize');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'identify');
    authUrl.searchParams.set('state', sid);
    res.redirect(authUrl.toString());
  });

  app.get('/auth/discord/callback', async (req, res) => {
    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(503).send('oauth not configured');
    }
    const sid = req.query.state && String(req.query.state);
    const code = req.query.code && String(req.query.code);
    const sess = sid ? sessions.get(sid) : null;
    if (!sess || sess.exp < Date.now()) {
      return res.status(400).type('html').send('<!DOCTYPE html><html><body><p>세션이 만료되었습니다. 처음부터 다시 진행해 주세요.</p></body></html>');
    }
    if (!code) {
      return res.status(400).type('html').send('<!DOCTYPE html><html><body><p>디스코드 로그인이 취소되었거나 실패했습니다.</p></body></html>');
    }
    try {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      });
      const tr = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const tj = await tr.json();
      if (!tr.ok || !tj.access_token) {
        return res.status(502).type('html').send(`<body><p>토큰 교환 실패: ${escapeHtml(tj.error || tr.status)}</p></body>`);
      }
      const me = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tj.access_token}` },
      });
      const mj = await me.json();
      if (!me.ok || !mj.id) {
        return res.status(502).type('html').send('<body><p>디스코드 사용자 정보를 가져오지 못했습니다.</p></body>');
      }
      if (String(mj.id) !== String(sess.userId)) {
        return res.status(403).type('html').send(
          '<!DOCTYPE html><html><body><p>로그인한 디스코드 계정이 링크를 연 계정과 다릅니다. <strong>같은 계정</strong>으로 로그인해 주세요.</p></body></html>'
        );
      }
      sess.oauthOk = true;
      sess.oauthAt = new Date().toISOString();
      sessions.set(sid, sess);
      setAuthCookie(res, sid);
      if (!publicBase) {
        return res.status(503).type('html').send('<body><p>AUTH_PUBLIC_BASE_URL 이 설정되지 않아 다음 단계로 이동할 수 없습니다.</p></body>');
      }
      res.redirect(`${publicBase}/auth/phone`);
    } catch (e) {
      res.status(500).type('html').send(`<body><p>${escapeHtml(e.message)}</p></body>`);
    }
  });

  app.get('/auth/phone', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies.auth_sid;
    const sess = sid ? sessions.get(sid) : null;
    if (!sess || sess.exp < Date.now() || !sess.oauthOk) {
      return res.status(403).type('html').send(
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p>먼저 디스코드 로그인을 완료해 주세요. 디스코드 봇에서 본인 인증 링크를 다시 열어 주세요.</p></body></html>'
      );
    }
    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>휴대폰 인증</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 420px; margin: 2rem auto; padding: 0 1rem; background: #1e1f22; color: #f2f3f5; }
    h1 { font-size: 1.25rem; }
    label { display: block; margin: 0.75rem 0 0.25rem; font-size: 0.9rem; color: #b5bac1; }
    input { width: 100%; box-sizing: border-box; padding: 0.6rem 0.75rem; border-radius: 8px; border: 1px solid #3f4147; background: #2b2d31; color: #f2f3f5; }
    button { margin-top: 1rem; width: 100%; padding: 0.65rem; border: none; border-radius: 8px; background: #5865f2; color: #fff; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .msg { margin-top: 0.75rem; font-size: 0.9rem; white-space: pre-wrap; }
    .ok { color: #3ba55d; } .err { color: #ed4245; }
  </style>
</head>
<body>
  <h1>2단계 · 휴대폰 인증</h1>
  <p style="color:#b5bac1;font-size:0.9rem;">국내 번호는 01012345678 형식으로 입력해 주세요.</p>
  <label>휴대폰 번호</label>
  <input id="phone" type="tel" placeholder="01012345678" autocomplete="tel"/>
  <button type="button" id="sendBtn">인증번호 받기</button>
  <label style="margin-top:1.25rem">인증번호 (6자리)</label>
  <input id="code" type="text" inputmode="numeric" maxlength="8" placeholder="123456" autocomplete="one-time-code"/>
  <button type="button" id="verifyBtn">인증 완료</button>
  <div id="out" class="msg"></div>
  <script>
    const out = document.getElementById('out');
    function show(t, ok) { out.textContent = t; out.className = 'msg ' + (ok ? 'ok' : 'err'); }
    document.getElementById('sendBtn').onclick = async () => {
      const phone = document.getElementById('phone').value.trim();
      out.textContent = '';
      const r = await fetch('/auth/phone/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ phone })
      });
      const j = await r.json().catch(() => ({}));
      if (j.ok) show(j.message || '인증번호를 발송했습니다.', true);
      else show(j.message || '발송 실패', false);
    };
    document.getElementById('verifyBtn').onclick = async () => {
      const code = document.getElementById('code').value.trim();
      out.textContent = '';
      const r = await fetch('/auth/phone/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ code })
      });
      const j = await r.json().catch(() => ({}));
      if (j.ok) {
        show('인증이 완료되었습니다. 디스코드로 돌아가 서비스를 이용해 주세요.', true);
        document.getElementById('sendBtn').disabled = true;
        document.getElementById('verifyBtn').disabled = true;
      } else show(j.message || '실패', false);
    };
  </script>
</body>
</html>`;
    res.type('html').send(html);
  });

  app.post('/auth/phone/send', jsonParser, async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies.auth_sid;
    const sess = sid ? sessions.get(sid) : null;
    if (!sess || sess.exp < Date.now() || !sess.oauthOk) {
      return res.status(403).json({ ok: false, message: '세션이 만료되었습니다. 처음부터 다시 해 주세요.' });
    }
    const e164 = normalizeKrToE164(req.body && req.body.phone);
    if (!e164) {
      return res.status(400).json({ ok: false, message: '휴대폰 번호 형식을 확인해 주세요.' });
    }
    const now = Date.now();
    sess.sendCount = (sess.sendCount || 0) + 1;
    if (sess.sendCount > 5) {
      return res.status(429).json({ ok: false, message: '요청 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
    }
    if (sess.lastSendAt && now - sess.lastSendAt < 45 * 1000) {
      return res.status(429).json({ ok: false, message: '잠시 후 다시 요청해 주세요. (약 45초)' });
    }
    sess.lastSendAt = now;
    sess.phoneE164 = e164;

    const mode = phoneAuthMode();
    if (mode === 'dev' || mode === 'test') {
      const fixed = process.env.PHONE_OTP_DEV_CODE && String(process.env.PHONE_OTP_DEV_CODE).trim();
      sess.devCode = fixed || String(100000 + Math.floor(Math.random() * 900000));
      sessions.set(sid, sess);
      console.log(`[본인인증·DEV] sid=${sid.slice(0, 8)}… OTP=${sess.devCode} phone=${e164}`);
      return res.json({
        ok: true,
        message: `개발 모드: 인증번호는 서버 콘솔에 출력됩니다. (${sess.devCode})`,
      });
    }

    const tw = await twilioCreateVerification(e164);
    if (!tw.ok) {
      return res.status(502).json({
        ok: false,
        message:
          tw.reason === 'twilio_not_configured'
            ? 'SMS 발송이 설정되지 않았습니다. Twilio Verify 또는 PHONE_AUTH_MODE=dev 로 설정하세요.'
            : `SMS 발송 실패: ${tw.message || tw.reason}`,
      });
    }
    sessions.set(sid, sess);
    res.json({ ok: true, message: '인증번호를 문자로 보냈습니다.' });
  });

  app.post('/auth/phone/verify', jsonParser, async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies.auth_sid;
    const sess = sid ? sessions.get(sid) : null;
    if (!sess || sess.exp < Date.now() || !sess.oauthOk || !sess.phoneE164) {
      return res.status(403).json({ ok: false, message: '세션이 만료되었습니다.' });
    }
    const code = req.body && String(req.body.code || '').trim();
    if (!/^\d{4,8}$/.test(code)) {
      return res.status(400).json({ ok: false, message: '인증번호 형식을 확인해 주세요.' });
    }

    const mode = phoneAuthMode();
    let ok = false;
    if (mode === 'dev' || mode === 'test') {
      ok = sess.devCode && code === sess.devCode;
    } else {
      const chk = await twilioCheckVerification(sess.phoneE164, code);
      ok = chk.ok;
    }

    if (!ok) {
      return res.status(400).json({ ok: false, message: '인증번호가 올바르지 않습니다.' });
    }

    const phoneHash = crypto.createHash('sha256').update(sess.phoneE164).digest('hex');
    const last4 = sess.phoneE164.slice(-4);
    const oauthAt = new Date().toISOString();
    store.markUserVerified(sess.guildId, sess.userId, {
      oauthAt: sess.oauthAt || oauthAt,
      phoneAt: oauthAt,
      phoneLast4: last4,
      phoneHash,
    });
    sessions.delete(sid);
    clearAuthCookie(res);
    res.json({ ok: true, message: 'done' });
  });
}

module.exports = { mountUserAuth };

const express = require('express');
const store = require('./store');

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

/**
 * POST /webhook/deposit — { depositorName, amount } + secret
 * ALL /api/deposit/sms — message 또는 depositorName+amount (쥬판기와 동일 패턴)
 */
function resolveGuildIdFromReq(req) {
  const b = req.body || {};
  const q = req.query || {};
  const fromReq = b.guildId ?? q.guildId;
  if (fromReq != null && String(fromReq).trim() !== '') return String(fromReq).trim();
  const envG = process.env.GUILD_ID && String(process.env.GUILD_ID).trim();
  return envG || null;
}

function createDepositServer(onMatch) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const expectedSecret = process.env.WEBHOOK_SECRET || '';
  const DEBUG_SMS = String(process.env.DEBUG_SMS || '').trim() === '1';
  const DISABLE_WEBHOOK_SECRET =
    String(process.env.DISABLE_WEBHOOK_SECRET || '').trim() === '1' ||
    String(process.env.DISABLE_WEBHOOK_SECRET || '').trim().toLowerCase() === 'true';

  function checkSecret(req) {
    if (DISABLE_WEBHOOK_SECRET) return true;
    const secret =
      req.query?.secret || req.headers['x-webhook-secret'] || req.body?.secret;
    if (expectedSecret && secret !== expectedSecret) return false;
    return true;
  }

  app.post('/webhook/deposit', (req, res) => {
    if (!checkSecret(req)) return res.status(401).json({ ok: false, reason: 'unauthorized' });
    const { depositorName, amount } = req.body || {};
    if (!depositorName || amount == null) {
      return res.status(400).json({ ok: false, reason: 'depositorName and amount required' });
    }
    const gid = resolveGuildIdFromReq(req);
    const result = store.matchAndCompleteDeposit(depositorName, amount, { guildId: gid });
    if (!result.ok) return res.status(200).json(result);
    if (typeof onMatch === 'function') onMatch(result);
    res.json({ ok: true, userId: result.userId, amount: result.amount });
  });

  app.all('/api/deposit/sms', async (req, res) => {
    if (!checkSecret(req)) {
      if (DEBUG_SMS) console.log('[SMS] unauthorized');
      return res.status(401).json({ ok: false, reason: 'unauthorized' });
    }

    const message =
      req.query?.message ||
      req.body?.message ||
      req.body?.content ||
      req.body?.text ||
      '';
    const depositorName = req.query?.depositorName || req.body?.depositorName;
    const amountParam = req.query?.amount ?? req.body?.amount;

    const forceDirect =
      String(process.env.SMS_MATCH_ONLY || '').trim() === '1' ||
      String(process.env.SMS_MATCH_ONLY || '').trim().toLowerCase() === 'true';

    if (!forceDirect && DISCORD_WEBHOOK_URL && message) {
      try {
        const body = JSON.stringify({ content: String(message).slice(0, 2000) });
        const r = await fetch(DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        if (!r.ok) {
          const t = await r.text();
          return res.status(502).json({ ok: false, reason: 'webhook_failed', message: t });
        }
        return res.json({ ok: true, mode: 'webhook', message: '디스코드 채널로 전달됨' });
      } catch (e) {
        return res.status(502).json({ ok: false, reason: 'webhook_error', message: e.message });
      }
    }

    if (!DISCORD_WEBHOOK_URL) {
      let depositorNameFinal = depositorName;
      let amountFinal = amountParam != null ? Number(amountParam) : null;

      if (depositorNameFinal && amountFinal > 0) {
        /* ok */
      } else if (message) {
        const parsed = store.parseDepositMessage(message);
        if (!parsed) {
          return res.status(400).json({
            ok: false,
            reason: 'parse_failed',
            message: '메시지에서 입금자명·금액을 찾지 못했습니다.',
          });
        }
        depositorNameFinal = parsed.depositorName;
        amountFinal = parsed.amount;
      } else {
        return res.status(400).json({
          ok: false,
          reason: 'message or (depositorName, amount) required',
        });
      }
      const gid = resolveGuildIdFromReq(req);
      const result = store.matchAndCompleteDeposit(depositorNameFinal, amountFinal, { guildId: gid });
      if (DEBUG_SMS) console.log('[SMS] match', result.ok, result.reason);
      if (!result.ok) return res.status(200).json(result);
      if (typeof onMatch === 'function') onMatch(result);
      return res.json({ ok: true, userId: result.userId, amount: result.amount });
    }

    return res.status(400).json({
      ok: false,
      reason: 'DISCORD_WEBHOOK_URL 사용 시 message 필수',
    });
  });

  app.get('/health', (_, res) => res.json({ ok: true }));

  return app;
}

module.exports = { createDepositServer };

/**
 * myGang SMS send endpoint — batch-aware, AU-normalised, dual env-var support.
 *
 * Payload (either shape is accepted):
 *   { messages: [ {to, body}, ... ] }        ← current app
 *   { to, body }                             ← legacy single-message
 *
 * Response:
 *   { sent, failed, results: [ {to, ok, sid?, error?, code?}, ... ] }
 *
 * Env vars (either naming scheme works):
 *   NEW:  TWILIO_SID        / TWILIO_TOKEN       / TWILIO_FROM
 *   OLD:  TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER
 */

/**
 * Normalise AU mobile to E.164 (+61XXXXXXXXX).
 * Accepts "+61 4XX XXX XXX", "61 4XX...", "04XX XXX XXX", "4XX XXX XXX".
 */
function normaliseAU(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^\d+]/g, '');
  if (!cleaned) return null;

  if (cleaned.startsWith('+61') && cleaned.length === 12) return cleaned;
  if (cleaned.startsWith('61') && cleaned.length === 11) return '+' + cleaned;
  if (cleaned.startsWith('04') && cleaned.length === 10) return '+61' + cleaned.slice(1);
  if (cleaned.startsWith('4') && cleaned.length === 9) return '+61' + cleaned;

  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Resolve credentials — try new names first, fall back to old names.
  const sid = process.env.TWILIO_SID || process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_TOKEN || process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM || process.env.TWILIO_PHONE_NUMBER;

  if (!sid || !token || !from) {
    const missing = [];
    if (!sid) missing.push('TWILIO_SID (or TWILIO_ACCOUNT_SID)');
    if (!token) missing.push('TWILIO_TOKEN (or TWILIO_AUTH_TOKEN)');
    if (!from) missing.push('TWILIO_FROM (or TWILIO_PHONE_NUMBER)');
    res.status(500).json({
      error: 'Server not configured',
      detail: 'Missing env vars: ' + missing.join(', '),
      hint: 'Set these on the Vercel project (Settings - Environment Variables) and redeploy.',
    });
    return;
  }

  // Basic sanity on values so typos surface as clear errors, not Twilio 401s.
  if (!sid.startsWith('AC')) {
    res.status(500).json({
      error: 'Invalid TWILIO_SID',
      detail: 'Account SID must start with "AC". Got: ' + sid.slice(0, 4) + '...',
    });
    return;
  }
  if (!from.startsWith('+')) {
    res.status(500).json({
      error: 'Invalid TWILIO_FROM',
      detail: 'Sender number must be in E.164 format (starting with +). Got: ' + from.slice(0, 4) + '...',
    });
    return;
  }

  // Parse payload — accept batch or legacy single-message shape.
  let messages = [];
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (Array.isArray(body && body.messages)) {
      messages = body.messages;
    } else if (body && body.to && body.body) {
      messages = [{ to: body.to, body: body.body }];
    } else {
      res.status(400).json({
        error: 'Invalid payload',
        detail: 'Expected {messages: [...]} or {to, body}',
        received: Object.keys(body || {}),
      });
      return;
    }
  } catch (e) {
    res.status(400).json({ error: 'Invalid JSON body', detail: String(e.message || e) });
    return;
  }

  if (messages.length === 0) {
    res.status(400).json({ error: 'No messages to send' });
    return;
  }

  const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json';

  const results = [];
  let sent = 0;
  let failed = 0;

  for (const m of messages) {
    const toNorm = normaliseAU(m && m.to);
    if (!toNorm) {
      failed++;
      results.push({ to: m && m.to, ok: false, error: 'Invalid AU mobile: ' + (m && m.to) });
      continue;
    }
    if (!m.body || !String(m.body).trim()) {
      failed++;
      results.push({ to: toNorm, ok: false, error: 'Empty message body' });
      continue;
    }

    const form = new URLSearchParams();
    form.append('To', toNorm);
    form.append('From', from);
    form.append('Body', String(m.body));

    try {
      const twilioRes = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
      const data = await twilioRes.json().catch(function () { return {}; });
      if (twilioRes.ok) {
        sent++;
        results.push({ to: toNorm, ok: true, sid: data.sid });
      } else {
        failed++;
        results.push({
          to: toNorm,
          ok: false,
          error: data.message || ('Twilio returned ' + twilioRes.status),
          code: data.code,
          twilioStatus: twilioRes.status,
        });
      }
    } catch (err) {
      failed++;
      results.push({
        to: toNorm,
        ok: false,
        error: 'Network/Twilio error: ' + String((err && err.message) || err),
      });
    }
  }

  // Always 200 when we processed — individual failures are in results.
  res.status(200).json({ sent, failed, results });
};

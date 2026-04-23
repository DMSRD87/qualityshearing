/**
 * myGang SMS send endpoint — batch-aware with AU number normalisation.
 *
 * Accepts payload shape:  { messages: [ {to, body}, ... ] }
 * Returns:                { sent, failed, results: [...] }
 *
 * Env vars required on Vercel:
 *   TWILIO_SID      (Account SID — starts with AC...)
 *   TWILIO_TOKEN    (Auth token)
 *   TWILIO_FROM     (Sender number in E.164 format, e.g. +61XXXXXXXXXX)
 */

/**
 * Normalise any AU mobile input to E.164 (+61XXXXXXXXX).
 * Accepts: +61 4XX XXX XXX, 61 4XX..., 04XX XXX XXX, 4XX XXX XXX.
 * Whitespace, dashes and parens are stripped before the rules apply.
 */
function normaliseAU(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^\d+]/g, '');
  if (!cleaned) return null;

  // Already E.164 and AU-shaped
  if (cleaned.startsWith('+61') && cleaned.length === 12) return cleaned;

  // "61..." without plus
  if (cleaned.startsWith('61') && cleaned.length === 11) return '+' + cleaned;

  // "04XXXXXXXX" (10 digits)
  if (cleaned.startsWith('04') && cleaned.length === 10) {
    return '+61' + cleaned.slice(1);
  }

  // "4XXXXXXXX" (9 digits) — bare mobile
  if (cleaned.startsWith('4') && cleaned.length === 9) {
    return '+61' + cleaned;
  }

  // Anything else: let Twilio reject it with a clear error
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_TOKEN;
  const from = process.env.TWILIO_FROM;

  if (!sid || !token || !from) {
    res.status(500).json({
      error: 'Server not configured',
      detail: 'Missing TWILIO_SID, TWILIO_TOKEN or TWILIO_FROM env vars',
    });
    return;
  }

  // Accept EITHER the new batch format OR the legacy single-message format,
  // so older deployments that still send {to, body} keep working.
  let messages = [];
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (Array.isArray(body?.messages)) {
      messages = body.messages;
    } else if (body?.to && body?.body) {
      messages = [{ to: body.to, body: body.body }];
    } else {
      res.status(400).json({ error: 'Invalid payload — expected {messages: [...]} or {to, body}' });
      return;
    }
  } catch (e) {
    res.status(400).json({ error: 'Invalid JSON body', detail: String(e) });
    return;
  }

  if (messages.length === 0) {
    res.status(400).json({ error: 'No messages to send' });
    return;
  }

  const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

  const results = [];
  let sent = 0;
  let failed = 0;

  for (const m of messages) {
    const toNorm = normaliseAU(m.to);
    if (!toNorm) {
      failed++;
      results.push({ to: m.to, ok: false, error: 'Invalid AU mobile: ' + m.to });
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
      const data = await twilioRes.json().catch(() => ({}));
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
        });
      }
    } catch (err) {
      failed++;
      results.push({ to: toNorm, ok: false, error: 'Network/Twilio error: ' + String(err) });
    }
  }

  res.status(200).json({ sent, failed, results });
};

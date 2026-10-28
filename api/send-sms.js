/**
 * myGang SMS send endpoint — batch-aware, AU-normalised, dual env-var support,
 * METERED (28 Oct 2026).
 *
 * Payload (either shape is accepted):
 *   { messages: [ {to, body}, ... ] }        ← current app
 *   { to, body }                             ← legacy single-message
 * Header x-mygang-slug: the contractor slug (the app sets it; used only for the meter).
 *
 * Response:
 *   { sent, failed, segments, results: [ {to, ok, sid?, segments?, error?, code?}, ... ] }
 *
 * Env vars (either naming scheme works):
 *   NEW:  TWILIO_SID        / TWILIO_TOKEN       / TWILIO_FROM
 *   OLD:  TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER
 *
 * METER: after the batch, one row goes to Supabase sms_usage (slug, kind, recipients,
 * sent, failed, segments). Segments come from Twilio's own num_segments on each
 * accepted message (what the bill is based on), with a GSM-7/UCS-2 estimate as the
 * fallback. The meter is fire-and-forget: it can never fail a send. The Supabase
 * anon key is the public one already shipped in the app; sms_usage only allows
 * inserts and reads under it.
 */
const SUPABASE_URL = 'https://yhkcdycypwxzxxwaxnzj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inloa2NkeWN5cHd4enh4d2F4bnpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMjgxMTgsImV4cCI6MjA5MTkwNDExOH0.q9u1O_uixHxDcb8bJgPJg-CaSSPU3XNZxfqYV6YnHWE';

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

/* Same rules the app shows before Send: GSM-7 153 chars/segment (160 if one), UCS-2 67 (70 if one). */
const GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";
function estimateSegments(s) {
  s = String(s || ''); if (!s) return 0;
  let gsm = true, n = 0;
  for (const c of s) { if (GSM.indexOf(c) >= 0) n += 1; else if (GSM_EXT.indexOf(c) >= 0) n += 2; else { gsm = false; break; } }
  if (gsm) return n <= 160 ? 1 : Math.ceil(n / 153);
  return s.length <= 70 ? 1 : Math.ceil(s.length / 67);
}
/* what sort of text this is, from the text itself - no app change needed */
function kindOf(body) {
  const b = String(body || '');
  if (/in myGang Team chat/.test(b)) return 'pointer';
  if (/^Update from /.test(b)) return 'broadcast';
  if (/you have been added to a job/i.test(b)) return 'job_card';
  if (/have your shearing locked in|Farmer - PIN/.test(b)) return 'farmer';
  if (/Your myGang PIN/.test(b)) return 'pin';
  return 'other';
}
async function meter(row) {
  try {
    if (!row.contractor_slug || !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.startsWith('__')) return;
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 3000);
    await fetch(SUPABASE_URL + '/rest/v1/sms_usage', {
      method: 'POST', signal: ctrl.signal,
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    }).catch(() => {});
    clearTimeout(t);
  } catch (_) { /* never fail a send over the meter */ }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const sid = process.env.TWILIO_SID || process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_TOKEN || process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM || process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) {
    const missing = [];
    if (!sid) missing.push('TWILIO_SID (or TWILIO_ACCOUNT_SID)');
    if (!token) missing.push('TWILIO_TOKEN (or TWILIO_AUTH_TOKEN)');
    if (!from) missing.push('TWILIO_FROM (or TWILIO_PHONE_NUMBER)');
    res.status(500).json({ error: 'Server not configured', detail: 'Missing env vars: ' + missing.join(', '), hint: 'Set these on the Vercel project (Settings - Environment Variables) and redeploy.' });
    return;
  }
  if (!sid.startsWith('AC')) { res.status(500).json({ error: 'Invalid TWILIO_SID', detail: 'Account SID must start with "AC". Got: ' + sid.slice(0, 4) + '...' }); return; }
  if (!from.startsWith('+')) { res.status(500).json({ error: 'Invalid TWILIO_FROM', detail: 'Sender number must be in E.164 format (starting with +). Got: ' + from.slice(0, 4) + '...' }); return; }

  let messages = [];
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (Array.isArray(body && body.messages)) messages = body.messages;
    else if (body && body.to && body.body) messages = [{ to: body.to, body: body.body }];
    else { res.status(400).json({ error: 'Invalid payload', detail: 'Expected {messages: [...]} or {to, body}', received: Object.keys(body || {}) }); return; }
  } catch (e) { res.status(400).json({ error: 'Invalid JSON body', detail: String(e.message || e) }); return; }
  if (messages.length === 0) { res.status(400).json({ error: 'No messages to send' }); return; }

  const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json';
  const results = [];
  let sent = 0, failed = 0, segments = 0;

  for (const m of messages) {
    const toNorm = normaliseAU(m && m.to);
    if (!toNorm) { failed++; results.push({ to: m && m.to, ok: false, error: 'Invalid AU mobile: ' + (m && m.to) }); continue; }
    if (!m.body || !String(m.body).trim()) { failed++; results.push({ to: toNorm, ok: false, error: 'Empty message body' }); continue; }
    const form = new URLSearchParams();
    form.append('To', toNorm); form.append('From', from); form.append('Body', String(m.body));
    try {
      const twilioRes = await fetch(url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
      const data = await twilioRes.json().catch(function () { return {}; });
      if (twilioRes.ok) {
        const segs = Number(data.num_segments) || estimateSegments(m.body);
        sent++; segments += segs;
        results.push({ to: toNorm, ok: true, sid: data.sid, segments: segs });
      } else {
        failed++;
        results.push({ to: toNorm, ok: false, error: data.message || ('Twilio returned ' + twilioRes.status), code: data.code, twilioStatus: twilioRes.status });
      }
    } catch (err) {
      failed++;
      results.push({ to: toNorm, ok: false, error: 'Network/Twilio error: ' + String((err && err.message) || err) });
    }
  }

  /* the meter - one row per batch, after the sends, never blocking the reply */
  const slug = String(req.headers['x-mygang-slug'] || (req.body && req.body.contractor_slug) || '').slice(0, 80);
  const firstBody = String((messages[0] && messages[0].body) || '');
  await meter({ contractor_slug: slug, kind: kindOf(firstBody), recipients: messages.length, sent, failed, segments, sample: firstBody.replace(/\s+/g, ' ').slice(0, 80) });

  res.status(200).json({ sent, failed, segments, results });
};

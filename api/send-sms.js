/* myGang — SMS Edge Function
   Credentials stored in Vercel Environment Variables — never in code
   Required env vars (set in Vercel dashboard):
     TWILIO_SID
     TWILIO_TOKEN
     TWILIO_FROM
*/

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const TWILIO_SID = process.env.TWILIO_SID;
  const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
  const TWILIO_FROM = process.env.TWILIO_FROM;

  const { messages } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'No messages provided' });
  }

  const results = [];

  for (const msg of messages) {
    const { to, body } = msg;

    if (!to || !body) {
      results.push({ to, status: 'error', error: 'Missing to or body' });
      continue;
    }

    /* Format Australian numbers to E.164 */
    let phone = to.replace(/\s/g, '');
    if (phone.startsWith('04')) phone = '+61' + phone.slice(1);
    if (phone.startsWith('61') && !phone.startsWith('+')) phone = '+' + phone;

    try {
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            To: phone,
            From: TWILIO_FROM,
            Body: body,
          }).toString(),
        }
      );

      const data = await response.json();

      if (response.ok) {
        results.push({ to: phone, status: 'sent', sid: data.sid });
      } else {
        results.push({ to: phone, status: 'error', error: data.message });
      }
    } catch (err) {
      results.push({ to: phone, status: 'error', error: err.message });
    }
  }

  const sent = results.filter(r => r.status === 'sent').length;
  const failed = results.filter(r => r.status === 'error').length;

  return res.status(200).json({ sent, failed, results });
}

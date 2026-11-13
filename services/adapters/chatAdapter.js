// chatAdapter — Twilio Conversations / Infobip (WhatsApp Business, SMS, omnichannel)
const { env, http, adapter } = require('./base');
module.exports = adapter('chat', ['TWILIO_ACCOUNT_SID', 'INFOBIP_API_KEY'], {
  async sendMessage(conv, body) {
    if (env('TWILIO_ACCOUNT_SID') && env('TWILIO_AUTH_TOKEN') && env('TWILIO_WHATSAPP_FROM')) {
      const auth = Buffer.from(env('TWILIO_ACCOUNT_SID') + ':' + env('TWILIO_AUTH_TOKEN')).toString('base64');
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env('TWILIO_ACCOUNT_SID')}/Messages.json`, {
        method: 'POST', headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: 'whatsapp:' + env('TWILIO_WHATSAPP_FROM'), To: 'whatsapp:' + (conv.phone || conv.masked_phone || ''), Body: body }),
      });
      const j = await r.json();
      return { sid: j.sid, provider: 'twilio', status: j.status };
    }
    if (env('INFOBIP_API_KEY')) {
      const r = await http('https://' + env('INFOBIP_BASE_URL', 'api.infobip.com') + '/whatsapp/1/message/text', {
        method: 'POST', headers: { Authorization: 'App ' + env('INFOBIP_API_KEY') },
        body: { from: env('INFOBIP_WHATSAPP_FROM'), to: conv.phone, content: { text: body } },
      });
      return { sid: r.messageId, provider: 'infobip' };
    }
    return { sid: 'mock-' + Date.now(), provider: 'mock', delivered: true };
  },
  // normalizes an inbound WhatsApp/DM webhook payload to {from, body, channel}
  parseInbound(payload, channel = 'whatsapp') {
    const m = payload && (payload.Body || (payload.results && payload.results[0] && payload.results[0].message && payload.results[0].message.text));
    const from = payload && (payload.From || (payload.results && payload.results[0] && payload.results[0].from));
    return { from: (from || '').replace('whatsapp:', ''), body: m || '', channel };
  },
});

// socialDmAdapter — ManyChat / Respond.io (Instagram & Facebook DM lead yakalama)
const { env, http, adapter } = require('./base');
module.exports = adapter('socialdm', ['MANYCHAT_API_KEY', 'RESPOND_IO_TOKEN'], {
  // normalizes a DM webhook payload into {name, handle, body, channel}
  captureDm(payload) {
    const e = (payload && payload.entry && payload.entry[0]) || payload || {};
    const msg = (e.messaging && e.messaging[0]) || e;
    const sender = msg.sender || {};
    return { name: (msg.sender && msg.sender.name) || sender.id || 'DM Kullanıcı', handle: '@' + (sender.id || 'dm'),
      body: (msg.message && msg.message.text) || payload.text || '', channel: 'instagram' };
  },
  async replyDm(handle, text) {
    if (env('MANYCHAT_API_KEY')) {
      await http('https://api.manychat.com/fb/sending/sendContent', {
        method: 'POST', headers: { Authorization: 'Bearer ' + env('MANYCHAT_API_KEY') },
        body: { subscriber_id: handle, data: { version: 'v2', content: { messages: [{ type: 'text', text }] } } },
      }).catch(() => null);
      return { sent: true, provider: 'manychat' };
    }
    return { sent: true, provider: 'mock', handle };
  },
});

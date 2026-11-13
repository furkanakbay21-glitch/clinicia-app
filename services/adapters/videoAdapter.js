// videoAdapter — Agora.io / Daily.co tele-sağlık odası (WebRTC)
const { env, http, adapter } = require('./base');
const crypto = require('crypto');
module.exports = adapter('video', ['AGORA_APP_ID', 'DAILY_API_KEY'], {
  // creates (or mock-creates) an encrypted consult room; returns { room, provider }
  async createRoom(patient, opts = {}) {
    if (env('DAILY_API_KEY')) {
      const r = await http('https://api.daily.co/v1/rooms', {
        method: 'POST', headers: { Authorization: 'Bearer ' + env('DAILY_API_KEY') },
        body: { privacy: 'private', properties: { exp: Math.floor(Date.now() / 1000) + 7200, enable_screenshare: true } },
      });
      return { room: r.url, provider: 'daily', expires: r.config && r.config.exp };
    }
    if (env('AGORA_APP_ID')) {
      const channel = 'clinicia-' + crypto.randomBytes(6).toString('hex');
      return { room: `/v/${channel}`, provider: 'agora', channel, appId: env('AGORA_APP_ID'), token: env('AGORA_TOKEN') || null };
    }
    return { room: '/v/' + crypto.randomBytes(8).toString('hex'), provider: 'mock' };
  },
});

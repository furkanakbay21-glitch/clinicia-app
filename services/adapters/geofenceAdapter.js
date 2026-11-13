// geofenceAdapter — Radar.io / OneSignal FCM (iniş algılama + saha bildirimi)
const { env, http, adapter } = require('./base');
module.exports = adapter('geofence', ['RADAR_SECRET_KEY', 'ONESIGNAL_APP_ID'], {
  async registerArrivalWatch(task, airportCode) {
    if (env('RADAR_SECRET_KEY')) {
      await http('https://api.radar.io/v1/geofences', {
        method: 'POST', headers: { Authorization: env('RADAR_SECRET_KEY') },
        body: { tag: 'airport', externalId: airportCode, type: 'circle', coordinates: [28.75, 41.26], radius: 5000 },
      }).catch(() => null);
      return { watch_id: 'radar-' + task.id, provider: 'radar' };
    }
    return { watch_id: 'mock-geo-' + task.id, provider: 'mock', airport: airportCode };
  },
  async notifyFieldTeam(event) {
    if (env('ONESIGNAL_APP_ID') && env('ONESIGNAL_REST_KEY')) {
      await http('https://onesignal.com/api/v1/notifications', {
        method: 'POST', headers: { Authorization: 'Basic ' + env('ONESIGNAL_REST_KEY') },
        body: { app_id: env('ONESIGNAL_APP_ID'), contents: { en: event.message }, included_segments: ['Field Team'] },
      }).catch(() => null);
      return { sent: true, provider: 'onesignal' };
    }
    return { sent: true, provider: 'mock', event };
  },
});

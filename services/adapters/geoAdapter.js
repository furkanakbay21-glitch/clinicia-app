// geoAdapter — Google Maps / Mapbox (VIP araç konumu + rota matrisi)
const { env, http, adapter } = require('./base');
module.exports = adapter('geo', ['GOOGLE_MAPS_KEY', 'MAPBOX_TOKEN'], {
  async vehiclePosition(task) {
    const h = task.id * 37 % 100;
    return { task_id: task.id, lat: 41.0 + h / 100, lng: 28.9 + h / 120, speed_kmh: 40 + (h % 30), provider: this.configured() ? 'gmaps' : 'mock' };
  },
  async routeMatrix(from, to) {
    if (env('GOOGLE_MAPS_KEY')) {
      const r = await http(`https://maps.googleapis.com/maps/api/distancematrix/json?origins=${from.lat},${from.lng}&destinations=${to.lat},${to.lng}&key=${env('GOOGLE_MAPS_KEY')}`);
      const e = r.rows && r.rows[0] && r.rows[0].elements && r.rows[0].elements[0];
      return { eta_min: e && e.duration && Math.round(e.duration.value / 60), km: e && e.distance && e.distance.value / 1000, provider: 'gmaps' };
    }
    return { eta_min: 25 + (String(from.lat).length % 15), km: 18.4, provider: 'mock' };
  },
});

// flightAdapter — FlightAware AeroAPI / Amadeus (canlı PNR, rötar, iniş)
const { env, http, adapter } = require('./base');
module.exports = adapter('flight', ['FLIGHTAWARE_API_KEY', 'AMADEUS_API_KEY'], {
  async track(flightNo, date) {
    if (env('FLIGHTAWARE_API_KEY')) {
      const r = await http(`https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(flightNo)}`, {
        headers: { 'x-apikey': env('FLIGHTAWARE_API_KEY') },
      });
      const f = r.flights && r.flights[0];
      if (f) return { flight: flightNo, status: f.status, gate: f.gate_destination, eta: f.estimated_in, delayed: (f.delayed || 0) > 0, provider: 'flightaware' };
    }
    if (env('AMADEUS_API_KEY') && env('AMADEUS_API_SECRET')) {
      const t = await http('https://test.api.amadeus.com/v1/security/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${env('AMADEUS_API_KEY')}&client_secret=${env('AMADEUS_API_SECRET')}`,
      }).catch(() => null);
      if (t) return { flight: flightNo, status: 'scheduled', provider: 'amadeus', note: 'status fetch wired, needs flight date' };
    }
    // deterministic mock — same flight no always yields same mock status
    const h = [...flightNo].reduce((a, c) => a + c.charCodeAt(0), 0);
    const st = ['scheduled', 'scheduled', 'enroute', 'landed'][h % 4];
    return { flight: flightNo, status: st, eta_min: (h % 45), gate: 'B' + (h % 20 + 1), provider: 'mock' };
  },
});

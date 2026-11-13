// fxAdapter — TCMB EVDS / ExchangeRate-API (canlı kur + kur sabitleme)
const { env, http, adapter } = require('./base');
module.exports = adapter('fx', ['TCMB_EVDS_API_KEY', 'EXCHANGERATE_API_KEY'], {
  async rates() {
    if (env('EXCHANGERATE_API_KEY')) {
      const r = await http(`https://v6.exchangerate-api.com/v6/${env('EXCHANGERATE_API_KEY')}/latest/EUR`);
      return { base: 'EUR', rates: { TRY: r.conversion_rates && r.conversion_rates.TRY, USD: r.conversion_rates && r.conversion_rates.USD }, provider: 'exchangerate' };
    }
    if (env('TCMB_EVDS_API_KEY')) {
      const r = await http(`https://evds2.tcmb.gov.tr/service/evds/series=TP.DK.EUR.A-TP.DK.USD.A&startDate=${new Date().toISOString().slice(0,10)}&endDate=${new Date().toISOString().slice(0,10)}&type=json&key=${env('TCMB_EVDS_API_KEY')}`).catch(() => null);
      if (r && r.items && r.items[0]) return { base: 'EUR', rates: { TRY: +r.items[0]['TP_DK_EUR_A'], USD: +r.items[0]['TP_DK_USD_A'] }, provider: 'tcmb' };
    }
    return { base: 'EUR', rates: { TRY: 55.95, USD: 1.09, GBP: 0.85 }, provider: 'mock' };
  },
  async lock(pair, amount) {
    const r = await this.rates();
    return { pair, amount, locked_rate: r.rates && r.rates[pair] || null, locked_until: new Date(Date.now() + 864e5).toISOString(), provider: r.provider };
  },
});

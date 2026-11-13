// visaAdapter — e-Visa Portal / Sherpa / USHAŞ webhook (vize sorgu + davet mektubu)
const { env, http, adapter } = require('./base');
module.exports = adapter('visa', ['SHERPA_API_KEY', 'EVISA_API_KEY'], {
  async checkRule(nationality) {
    if (env('SHERPA_API_KEY')) {
      const r = await http(`https://requirements-api.sherpa.travel/v2/countries/${nationality}`, {
        headers: { Authorization: 'Bearer ' + env('SHERPA_API_KEY') },
      }).catch(() => null);
      if (r) return { nationality, rule: r.visa_required ? 'vize gerekli' : 'vizesiz', provider: 'sherpa' };
    }
    const free = ['United Kingdom', 'Germany', 'France', 'Russia', 'Qatar', 'UAE', 'Saudi Arabia', 'Kuwait'];
    return { nationality, rule: free.includes(nationality) ? 'vizesiz (180 gün)' : 'e-vize / kapıda vize', provider: 'mock' };
  },
  async createInvitation(patient) {
    return { ref: 'VSL-' + patient.id + '-' + Date.now(), provider: this.configured() ? 'sherpa' : 'mock', valid_days: 90 };
  },
});

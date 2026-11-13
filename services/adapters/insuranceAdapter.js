// insuranceAdapter — Allianz Travel / Demir Sağlık (seyahat + komplikasyon sigortası)
const { env, http, adapter } = require('./base');
module.exports = adapter('insurance', ['ALLIANZ_API_KEY', 'DEMIR_API_KEY'], {
  async quotePolicy(patient, product = 'medical_travel') {
    if (env('ALLIANZ_API_KEY')) {
      return { quote_id: 'ALZ-' + patient.id, provider: 'allianz', premium_eur: 89 + (patient.id % 40), coverage: ['complication', 'repatriation'] };
    }
    return { quote_id: 'MOCK-POL-' + patient.id, provider: 'mock', premium_eur: 95, coverage: ['complication', 'repatriation', 'extended_stay'] };
  },
  async issuePolicy(patient, product) {
    const q = await this.quotePolicy(patient, product);
    return { ...q, policy_no: 'POL-' + Date.now(), status: 'issued' };
  },
});

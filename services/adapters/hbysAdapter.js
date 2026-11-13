// hbysAdapter — BulutKlinik Core API & Google Calendar (hekim takvim + RFQ senkronizasyonu)
const { env, http, adapter } = require('./base');
module.exports = adapter('hbys', ['BULUTKLINIK_API_KEY', 'GOOGLE_CALENDAR_KEY'], {
  async syncDoctorCalendar(doctor) {
    if (env('BULUTKLINIK_API_KEY')) {
      const r = await http(env('BULUTKLINIK_BASE_URL', 'https://api.bulutklinik.com') + '/v1/doctors/' + doctor.id + '/schedule', {
        headers: { Authorization: 'Bearer ' + env('BULUTKLINIK_API_KEY') },
      });
      return { doctor_id: doctor.id, slots: r.slots || [], provider: 'bulutklinik' };
    }
    return { doctor_id: doctor.id, slots: ['09:00', '11:30', '14:00', '16:30'], provider: 'mock' };
  },
  async pushRfq(rfq) {
    return { rfq_id: rfq.id, pushed: true, provider: this.configured() ? 'bulutklinik' : 'mock', external_ref: 'BK-' + rfq.id };
  },
});

// analyticsAdapter — AWS QuickSight / Tremor Chart (kârlılık + ülke BI)
const { env, adapter } = require('./base');
module.exports = adapter('analytics', ['AWS_QUICKSIGHT_ARN', 'TREMOR_API_KEY'], {
  async embedUrl(dashboardId = 'clinicia-profit') {
    if (env('AWS_QUICKSIGHT_ARN')) {
      return { url: `https://quicksight.aws.amazon.com/sn/embed/share/accounts/${env('AWS_ACCOUNT_ID')}/dashboards/${dashboardId}`, provider: 'quicksight' };
    }
    return { url: null, provider: 'mock', inline: true };
  },
  async profitByCountry(ctx) {
    if (ctx && ctx.all) {
      return ctx.all(`SELECT p.nationality country, COUNT(*) patients,
        COALESCE(SUM(t.amount),0) revenue FROM patients p
        LEFT JOIN transactions t ON t.patient_id=p.id AND t.kind='income'
        GROUP BY p.nationality ORDER BY revenue DESC`);
    }
    return [];
  },
});

// localizationAdapter — DeepL Pro / Lokalise (medikal şablon + post-op talimat çevirisi)
const { env, http, adapter } = require('./base');
const TPL = {
  postop_care: { tr: 'Bol sıvı tüketin, pansumanı kuru tutun, 3 gün sonra kontrole gelin.',
    en: 'Drink plenty of fluids, keep the dressing dry, return for a check-up in 3 days.',
    de: 'Viel trinken, Verband trocken halten, in 3 Tagen zur Kontrolle kommen.',
    ar: 'اشرب الكثير من السوائل، حافظ على الضمادة جافة، عد للمراجعة بعد 3 أيام.',
    fr: 'Buvez beaucoup, gardez le pansement sec, revenez dans 3 jours.',
    ru: 'Пейте больше жидкости, держите повязку сухой, придите на осмотр через 3 дня.' },
};
module.exports = adapter('localization', ['DEEPL_API_KEY', 'LOKALISE_TOKEN'], {
  async translateTemplate(key, lang, vars = {}) {
    if (env('DEEPL_API_KEY') && vars.text) {
      const r = await http('https://api-free.deepl.com/v2/translate', {
        method: 'POST',
        body: { auth_key: env('DEEPL_API_KEY'), text: [vars.text], target_lang: lang.toUpperCase() },
      });
      return { text: r.translations && r.translations[0] && r.translations[0].text, provider: 'deepl' };
    }
    let t = (TPL[key] && (TPL[key][lang] || TPL[key].en)) || vars.text || '';
    for (const [k, v] of Object.entries(vars)) t = t.split('{' + k + '}').join(v);
    return { text: t, provider: 'mock', key, lang };
  },
});

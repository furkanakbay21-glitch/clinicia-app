// aiAdapter — OpenAI GPT-4o / Anthropic Claude (çeviri, gece AI, lead scoring)
const { env, http, adapter } = require('./base');
module.exports = adapter('ai', ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'], {
  async chat(system, user) {
    if (env('OPENAI_API_KEY')) {
      const r = await http('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + env('OPENAI_API_KEY') },
        body: { model: env('AI_MODEL', 'gpt-4o-mini'), messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
      });
      return r.choices && r.choices[0] && r.choices[0].message.content;
    }
    if (env('ANTHROPIC_API_KEY')) {
      const r = await http('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
        body: { model: env('AI_MODEL', 'claude-haiku-4-5'), max_tokens: 1024, system, messages: [{ role: 'user', content: user }] },
      });
      return r.content && r.content[0] && r.content[0].text;
    }
    return null; // caller falls back to its built-in mock
  },
  async translate(text, direction, lang) {
    const prompt = direction === 'in'
      ? `Translate to Turkish, medical tourism context, reply with ONLY the translation:\n${text}`
      : `Translate to ${lang}, warm professional tone, reply with ONLY the translation:\n${text}`;
    const out = await this.chat('You are a medical-tourism translator for a Turkish health agency.', prompt);
    return out ? { translated: out, lang, direction, provider: this.vendor } : null;
  },
  async nightGreeting(p) {
    const out = await this.chat('You are the night-shift AI receptionist of a Turkish health-tourism agency. Bilingual TR+EN, concise.',
      `Patient ${p.name} (${p.nationality}), complaint: ${p.complaint}. Write a 2-sentence welcome asking for photos/x-rays and promising a 09:00 consultant callback.`);
    return out;
  },
  async leadScore(p, signals = {}) {
    const out = await this.chat('You are a conversion analyst. Reply JSON only: {"pct":int,"segment":"low|mid|high","budget":"€X-€Y","reason":"short"}.',
      `Country: ${p.nationality}, complaint: ${p.complaint}, signals: ${JSON.stringify(signals)}`);
    try { return out && JSON.parse(out.match(/\{.*\}/s)[0]); } catch (e) { return null; }
  },
});

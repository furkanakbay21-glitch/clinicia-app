// Adapter base contract — every adapter: { id, vendor, configured(), health(), ...actions }
// If its env keys are set the adapter calls the real vendor API, otherwise it returns
// a deterministic mock so the whole ERP keeps working without any key.
const env = (k, d = null) => process.env[k] || d;
async function http(url, opts = {}) {
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${url} -> ${r.status}`);
  return r.json().catch(() => ({}));
}
function adapter(id, envKeys, impl) {
  const a = {
    id,
    get vendor() { return env(id.toUpperCase() + '_PROVIDER', 'mock'); },
    configured: () => envKeys.some(k => !!env(k)),
    health() { return { id, vendor: a.vendor, configured: a.configured(), mode: a.configured() ? 'live' : 'mock' }; },
    ...impl,
  };
  return a;
}
module.exports = { env, http, adapter };

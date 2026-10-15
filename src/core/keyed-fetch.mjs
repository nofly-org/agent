const MAX_HOPS = 5;

const NET_REASONS = [
  [/^ECONNREFUSED$/, ({ origin }) => `nothing answered at ${origin} (connection refused) - check the URL and that the backend is up`],
  [/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL)$/, ({ host }) => `${host} could not be found (DNS lookup failed) - check the URL, VPN or DNS`],
  [/^(ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED)$/, ({ origin }) => `the connection to ${origin} closed before it answered`],
  [/^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/, ({ origin }) => `${origin} did not answer in time`],
  [/^(EHOSTUNREACH|ENETUNREACH|ENETDOWN)$/, ({ host }) => `${host} cannot be reached from this network`],
  [/CERT|^UNABLE_TO_|^ERR_TLS_|^ERR_SSL_|SELF_SIGNED/, ({ host, code }) => `the TLS certificate of ${host} could not be verified (${code}) - if a company proxy inspects HTTPS, point NODE_EXTRA_CA_CERTS at its CA bundle`],
];

const PROXY_SENSITIVE = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|EHOSTUNREACH|ENETUNREACH)$/;

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i;

function bypassesProxy(host, env) {
  const list = String(env.NO_PROXY ?? env.no_proxy ?? '').split(',').map((e) => e.trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean);
  return list.some((entry) => entry === '*' || host === entry || host.endsWith(`.${entry}`));
}

function proxyHint(code, protocol, host, env) {
  if (!PROXY_SENSITIVE.test(code) || env.NODE_USE_ENV_PROXY === '1' || LOOPBACK.test(host) || bypassesProxy(host.toLowerCase(), env)) return '';
  const name = protocol === 'https:' ? 'HTTPS_PROXY' : 'HTTP_PROXY';
  return env[name] || env[name.toLowerCase()] ? ` (${name} is set, but Node uses a proxy only with NODE_USE_ENV_PROXY=1)` : '';
}

export function describeFetchError(error, url, env = process.env) {
  const cause = error?.cause;
  const code = cause?.code ?? (Array.isArray(cause?.errors) ? cause.errors.find((e) => e?.code)?.code : undefined) ?? error?.code;
  let origin = String(url ?? '');
  let host = origin;
  let protocol = '';
  try {
    const u = new URL(origin);
    origin = u.origin;
    host = u.hostname;
    protocol = u.protocol;
  } catch {
  }
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return `${origin} did not answer in time`;
  if (typeof code === 'string') {
    for (const [re, say] of NET_REASONS) if (re.test(code)) return say({ origin, host, code }) + proxyHint(code, protocol, host, env);
  }
  if (cause?.message === 'bad port') return `the port in ${origin} is one that fetch refuses to connect to - use another port`;
  const message = String(error?.message ?? error);
  const detail = cause?.message && cause.message !== message ? ` (${cause.message})` : '';
  return `${message}${detail}`;
}

export function redirectAllowed(from, to) {
  if (from.origin === to.origin) return true;
  return from.protocol === 'http:' && to.protocol === 'https:' && from.hostname === to.hostname
    && (to.port === '' || to.port === '443') && (from.port === '' || from.port === '80');
}

export async function keyedFetch(url, init = {}) {
  let current = new URL(String(url));
  let opts = { ...init, redirect: 'manual' };
  for (let hop = 0; ; hop += 1) {
    const res = await fetch(current, opts);
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    try {
      await res.body?.cancel();
    } catch {
    }
    const next = new URL(location, current);
    if (!redirectAllowed(current, next)) {
      throw new Error(`refused a redirect from ${current.origin} to ${next.origin} - the Shomra key is only sent to the backend it was configured for`);
    }
    if (hop >= MAX_HOPS) throw new Error(`too many redirects from ${current.origin}`);
    const method = String(opts.method ?? 'GET').toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      const { body, ...rest } = opts;
      opts = { ...rest, method: 'GET' };
    }
    current = next;
  }
}

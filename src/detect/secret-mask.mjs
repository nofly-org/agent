import { headerCredentialKey, maskNamedSecretsIn, maskSecretValue } from './signals/mcp-config.mjs';

const JSON_PAIR = /"([A-Za-z0-9_.\- ]{1,100})"(\s*:\s*)"((?:[^"\\\n]|\\.){1,4096})"/g;
const LINE_PAIR = /^(\s*(?:export\s+|-\s+)?["']?)([A-Za-z0-9_.\-]{1,100})(["']?\s*[:=]\s*)(["']?)([^"'\s#,]{1,4096})(["']?)/gm;

export function maskSecrets(text) {
  const originals = new Map();
  const remember = (real, masked) => {
    if (real !== masked) originals.set(masked, real);
  };
  const value = (key, raw) => {
    if (originals.has(raw)) return raw;
    const masked = maskSecretValue(raw, { key, header: headerCredentialKey(key) });
    remember(raw, masked);
    return masked;
  };
  let out = maskNamedSecretsIn(text, remember);
  out = out.replace(JSON_PAIR, (whole, key, sep, raw) => `"${key}"${sep}"${value(key, raw)}"`);
  out = out.replace(LINE_PAIR, (whole, lead, key, sep, open, raw, close) => `${lead}${key}${sep}${open}${value(key, raw)}${close}`);
  const restore = (masked) => {
    let back = String(masked ?? '');
    for (const [fake, real] of [...originals].reverse()) back = back.split(fake).join(real);
    return back;
  };
  return { text: out, masked: originals.size, restore };
}

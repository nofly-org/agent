import { api } from '../core/api-client.mjs';
import { contentSha256 } from '../detect/signals/ai-verdict.mjs';
import { REWORDING_NOT_RUN } from './result.mjs';
import { mergeSastIntoResult } from './sast.mjs';

export function hashOnly(flags = {}) {
  if (flags['hash-only']) return true;
  return ['0', 'false', 'off', 'no'].includes(String(process.env.NOFLY_UPLOAD_CONTENT ?? '').trim().toLowerCase());
}

export async function askKnownReview(url, apiKey, { content, name, path }) {
  const res = await api(url, apiKey, '/gate/known', {
    sha256: contentSha256(content),
    ...(name ? { name: String(name).slice(0, 200) } : {}),
    ...(path ? { path: String(path).slice(0, 500) } : {}),
  });
  return { known: res?.known === true, findings: Array.isArray(res?.findings) ? res.findings : [] };
}

export function withKnownReview(result, known) {
  if (!known) return result;
  const merged = mergeSastIntoResult(result, known.findings);
  if (!known.known) return { ...merged, knownReview: 'none' };
  const notAttempted = (merged.notAttempted ?? []).filter((n) => n?.check !== REWORDING_NOT_RUN.check);
  return { ...merged, notAttempted, knownReview: 'held' };
}

import { createHash, createHmac } from 'node:crypto';
import { posix } from 'node:path';

export const NO_RELATED = 'none';
export const PUBLIC_TAG = 'public';
export const MAX_ORG_TAGS = 3;
export const VERDICT_RETENTION_DAYS = 90;
const DEV_KEY = 'nofly-dev-insecure-key-change-me';

export const ARTIFACT_TARGET = '@artifact';

const sha256 = (text        ) => createHash('sha256').update(text).digest('hex');

export function contentSha256(text        )         {
  return sha256(String(text ?? '').replace(/\r\n/g, '\n'));
}

export function verdictKeyOf(a                                                                                                       )             {
  const content = contentSha256(a.content ?? '');
  const dir = posix.dirname(a.path.replace(/\\/g, '/'));
  const related = (a.related ?? [])
    .filter((r) => typeof r?.path === 'string' && typeof r?.text === 'string' && r.text)
    .map((r) => [posix.relative(dir, r.path .replace(/\\/g, '/')), contentSha256(r.text )]         )
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const relatedDigest = related.length ? sha256(JSON.stringify(related)) : NO_RELATED;
  return { id: `${content}:${relatedDigest}`, contentSha256: content, relatedDigest };
}

export function verdictEngine(parts           )         {
  return sha256(JSON.stringify(parts));
}

export function orgTagOf(orgId                           , secret = process.env.NOFLY_SECRET_KEY?.trim() || DEV_KEY)         {
  if (!orgId) return PUBLIC_TAG;
  return createHmac('sha256', secret).update(`ai-verdict:${orgId}`).digest('base64url').slice(0, 22);
}

export function mayServe(orgTags          , tag        )          {
  return orgTags.includes(tag) || new Set(orgTags).size >= 2;
}

export function needsTag(orgTags          , tag        )          {
  return !orgTags.includes(tag) && orgTags.length < MAX_ORG_TAGS;
}

export function targetFor(owner        , path        )         {
  return owner === path ? ARTIFACT_TARGET : posix.relative(posix.dirname(owner), path);
}

export function pathFor(owner        , target        )         {
  return target === ARTIFACT_TARGET ? owner : posix.join(posix.dirname(owner), target);
}

export function cachedAnswers(raw         )                        {
  if (!Array.isArray(raw)) return null;
  const out                 = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object' || typeof (r       ).target !== 'string' || !(r       ).f || typeof (r       ).f !== 'object') return null;
    const quote = (r       ).quote;
    out.push({ f: (r       ).f, target: (r       ).target, quote: typeof quote === 'string' ? quote : null });
  }
  return out;
}


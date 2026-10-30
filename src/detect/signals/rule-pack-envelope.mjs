import { createHash, sign, verify } from 'node:crypto';

export const RULE_PACK_FORMAT = 'nofly-rule-packs/1';

export function keyFingerprintOf(publicKeyPem        )         {
  return createHash('sha256').update(String(publicKeyPem).trim(), 'utf8').digest('hex');
}

export function rulePackPayload(packs               , issuedAt        )         {
  return JSON.stringify({ format: RULE_PACK_FORMAT, issuedAt, packs });
}

export function signRulePacks(payload        , key                                                 )                   {
  return {
    payload,
    alg: 'ed25519',
    signature: sign(null, Buffer.from(payload, 'utf8'), key.privateKeyPem).toString('base64'),
    publicKey: key.publicKeyPem,
    keyFingerprint: keyFingerprintOf(key.publicKeyPem),
  };
}

export function openRulePacks(envelope         , pinnedFingerprint                )                                      {
  const e = (envelope ?? {})                             ;
  if (typeof e.payload !== 'string' || typeof e.signature !== 'string' || typeof e.publicKey !== 'string') return { error: 'not a rule pack bundle' };
  const fingerprint = keyFingerprintOf(e.publicKey);
  if (e.keyFingerprint !== fingerprint) return { error: 'the bundle names a key it was not signed with' };
  if (pinnedFingerprint && pinnedFingerprint !== fingerprint) return { error: 'signed by a key this machine does not trust' };
  let valid = false;
  try {
    valid = verify(null, Buffer.from(e.payload, 'utf8'), e.publicKey, Buffer.from(e.signature, 'base64'));
  } catch {
    valid = false;
  }
  if (!valid) return { error: 'the signature does not match the contents' };
  let body     ;
  try {
    body = JSON.parse(e.payload);
  } catch {
    return { error: 'the contents are not JSON' };
  }
  if (body?.format !== RULE_PACK_FORMAT || !Array.isArray(body.packs)) return { error: 'not a format this version reads' };
  const packs = body.packs.filter((p     ) => p && typeof p.kind === 'string' && Array.isArray(p.rules));
  return { packs, issuedAt: String(body.issuedAt ?? ''), fingerprint };
}


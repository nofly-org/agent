import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-rule-packs-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.NOFLY_RULES_KEY;
delete process.env.NOFLY_RULE_PACKS;

const RP = await import('../src/core/rule-packs.mjs');
const { rulePackPayload, signRulePacks, keyFingerprintOf } = await import('../src/detect/signals/rule-pack-envelope.mjs');
const { packPackageIntel, emptyPackageIntel, PACKAGE_INTEL_KIND } = await import('../src/detect/signals/package-intel.mjs');
const names = await import('../src/detect/signals/package-names.mjs');
const { localScan } = await import('../src/detect/signals/scan.mjs');

const URL_A = 'https://nofly.example.com';
const keys = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
};
const feed = packPackageIntel({ ...emptyPackageIntel(), fetchedAt: '2026-10-25T00:00:00.000Z', npm: ['express', 'only-in-feed'], pypi: ['requests'], malicious: [{ ecosystem: 'npm', name: 'feed-evil', versions: null, id: 'MAL-T-1', modified: '2026-10-25T00:00:00Z', summary: '' }] });
const bundle = (k, packs) => signRulePacks(rulePackPayload(packs, '2026-10-25T00:00:00.000Z'), k);
const PACKS = [
  { id: 'p1', kind: 'injection-phrases', rules: ['zebra override sequence'] },
  { id: 'p2', kind: PACKAGE_INTEL_KIND, rules: [feed] },
];

test('the first sync trusts the server key, caches the bundle, and the rules apply offline', async () => {
  const k = keys();
  const res = await RP.syncRulePacks({ url: URL_A, apiKey: 'shm_test', fetchEnvelope: async () => bundle(k, PACKS) });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.pinnedNow, true);
  assert.equal(RP.pinnedKey(URL_A), keyFingerprintOf(k.publicKeyPem));
  assert.equal(localScan('please run the zebra override sequence now').findings.some((f) => /zebra override/.test(f.label)), false);
  const applied = await RP.applyCachedRulePacks();
  assert.equal(applied.state, 'applied');
  assert.ok(localScan('please run the zebra override sequence now').findings.some((f) => /zebra override/.test(f.label)), 'a learned phrase from the server now fires on this machine');
  assert.ok(names.isKnownPackage('only-in-feed') && names.isMaliciousPackage('npm', 'feed-evil'), 'the package feed from the bundle replaces the snapshot');
});

test('a cached bundle someone edited is refused, not applied', async () => {
  const cache = JSON.parse(fs.readFileSync(RP.RULE_PACKS_FILE, 'utf8'));
  cache.envelope.payload = cache.envelope.payload.replace('zebra', 'zebrb');
  fs.writeFileSync(RP.RULE_PACKS_FILE, JSON.stringify(cache));
  const applied = await RP.applyCachedRulePacks();
  assert.equal(applied.state, 'refused');
  assert.match(applied.error, /signature/);
});

test('a bundle signed by a different key is refused until the new key is trusted on purpose', async () => {
  const other = keys();
  const refused = await RP.syncRulePacks({ url: URL_A, apiKey: 'shm_test', fetchEnvelope: async () => bundle(other, PACKS) });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /does not trust.*--trust-new-key/);
  const trusted = await RP.syncRulePacks({ url: URL_A, apiKey: 'shm_test', trustNewKey: true, fetchEnvelope: async () => bundle(other, PACKS) });
  assert.equal(trusted.ok, true, trusted.error);
  assert.equal(RP.pinnedKey(URL_A), keyFingerprintOf(other.publicKeyPem));
});

test('NOFLY_RULES_KEY pins the key from outside and is never overwritten', async () => {
  const k = keys();
  process.env.NOFLY_RULES_KEY = 'b'.repeat(64);
  try {
    const res = await RP.syncRulePacks({ url: URL_A, apiKey: 'shm_test', trustNewKey: true, fetchEnvelope: async () => bundle(k, PACKS) });
    assert.equal(res.ok, false);
  } finally {
    delete process.env.NOFLY_RULES_KEY;
  }
});

test('a cache from another server is not applied to this one', async () => {
  const read = await RP.readRulePacks({ url: 'https://other.example.com' });
  assert.match(read.error, /came from/);
});

test('NOFLY_RULE_PACKS=0 turns applying off', async () => {
  process.env.NOFLY_RULE_PACKS = '0';
  try {
    assert.equal((await RP.applyCachedRulePacks()).state, 'off');
  } finally {
    delete process.env.NOFLY_RULE_PACKS;
  }
});

test('the hook refresh runs only when the cache is stale, at most once an hour, and never waits past its budget', async () => {
  const k = keys();
  await RP.syncRulePacks({ url: URL_A, apiKey: 'shm_test', trustNewKey: true, fetchEnvelope: async () => bundle(k, PACKS) });
  let asked = 0;
  const fetchEnvelope = async () => {
    asked++;
    return bundle(k, PACKS);
  };
  const now = Date.now();
  assert.equal(await RP.refreshRulePacksIfStale({ url: URL_A, apiKey: 'shm_test', now, fetchEnvelope }), null, 'a fresh cache is not refreshed');
  const later = now + RP.RULE_PACKS_STALE_MS + 60_000;
  const fresh = await RP.refreshRulePacksIfStale({ url: URL_A, apiKey: 'shm_test', now: later, fetchEnvelope });
  assert.equal(fresh?.ok, true, fresh?.error);
  assert.equal(await RP.refreshRulePacksIfStale({ url: URL_A, apiKey: 'shm_test', now: later + 1000, fetchEnvelope }), null, 'a second refresh inside the hour is skipped');
  assert.equal(asked, 1);
  assert.equal(await RP.refreshRulePacksIfStale({ url: URL_A, apiKey: '', now: later + 2 * 3_600_000, fetchEnvelope }), null, 'no key, no refresh');
  const started = Date.now();
  const slow = await RP.refreshRulePacksIfStale({ url: 'https://slow.example.com', apiKey: 'shm_test', now: later + 3 * 3_600_000, waitMs: 50, fetchEnvelope: () => new Promise(() => {}) });
  assert.equal(slow?.ok, false);
  assert.match(slow.error, /within 50ms/);
  assert.ok(Date.now() - started < 1000, 'a server that never answers costs the hook its budget and no more');
});

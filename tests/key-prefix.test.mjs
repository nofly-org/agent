import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_PREFIX, isAgentCredential, isNoFlyKey, keyScope } from '../src/core/api-key.mjs';
import { forwardHeaders } from '../src/commands/llm-proxy.mjs';

test('keys are minted as nfy_, and keys issued under the earlier prefixes keep working', () => {
  assert.equal(KEY_PREFIX, 'nfy_');
  for (const prefix of ['nfy_', 'shm_', 'dgx_']) {
    assert.equal(isNoFlyKey(`${prefix}live_x`), true, prefix);
    assert.equal(isAgentCredential(`${prefix}agt_x`), true, prefix);
    assert.equal(keyScope(`${prefix}ci_x`), 'CI', prefix);
    assert.equal(keyScope(`${prefix}gw_x`), 'gateway', prefix);
  }
  assert.equal(isAgentCredential('nfy_live_x'), false);
  assert.equal(isNoFlyKey('sk-ant-api03-x'), false);
  assert.equal(isAgentCredential(undefined), false);
});

test('the LLM proxy forwards an nfy_agt_ credential a local client presents, and never a bare handle', () => {
  const ctx = { apiKey: 'org', actor: 'host/user', sessionId: 's', agentId: null };
  assert.equal(forwardHeaders({ 'x-nofly-agent': 'nfy_agt_app' }, ctx)['x-nofly-agent'], 'nfy_agt_app');
  assert.equal('x-nofly-agent' in forwardHeaders({ 'x-nofly-agent': 'billing-bot' }, ctx), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptLegacyEnv, adoptLegacyHeaders, withLegacyHeaders } from '../src/core/legacy.mjs';
import { wrapMcpConfig, unwrapMcpConfig } from '../src/mcp/config-wrapping.mjs';
import { mcpToolInvocation } from '../src/mcp/server-tools.mjs';
import { RULES_BEGIN, RULES_END, currentMarkers, hasRulesBlock } from '../src/rules/sections.mjs';
import { isCronEntry, mergeCrontab } from '../src/core/schedule-plan.mjs';
import { forwardHeaders } from '../src/commands/llm-proxy.mjs';

test('an old SHOMRA_ variable is read as its NOFLY_ name, and never overrides one already set', () => {
  const env = { SHOMRA_URL: 'https://old', SHOMRA_GUARD_LOCAL: '0', NOFLY_GUARD_LOCAL: '1' };
  adoptLegacyEnv(env);
  assert.equal(env.NOFLY_URL, 'https://old');
  assert.equal(env.NOFLY_GUARD_LOCAL, '1');
});

test('the backend hears both header names, and a client cannot slip in an old one', () => {
  const sent = withLegacyHeaders({ 'X-NoFly-Key': 'k', 'Content-Type': 'application/json' });
  assert.equal(sent['x-shomra-key'], 'k');
  const incoming = adoptLegacyHeaders({ 'x-shomra-session': 's1', 'x-shomra-actor': 'mallory' });
  assert.deepEqual(incoming, { 'x-nofly-session': 's1', 'x-nofly-actor': 'mallory' });
  const forwarded = forwardHeaders({ host: '127.0.0.1', 'x-shomra-actor': 'mallory' }, { apiKey: 'k', actor: 'dana', sessionId: 's2' });
  assert.equal(forwarded['x-nofly-actor'], 'dana');
  assert.equal(forwarded['x-shomra-actor'], undefined);
});

test('a server guarded by the old CLI is repointed, not wrapped twice, and can still be unwrapped', () => {
  const cfg = { mcpServers: { fs: { command: 'node', args: ['/old/shomra.mjs', 'mcp-guard', '--name', 'fs', '--', 'npx', '-y', 'server-fs'] } } };
  const out = wrapMcpConfig(cfg, '/new/nofly.mjs', 'node');
  assert.deepEqual(out.updated, ['fs']);
  assert.deepEqual(cfg.mcpServers.fs.args, ['/new/nofly.mjs', 'mcp-guard', '--name', 'fs', '--', 'npx', '-y', 'server-fs']);
  const old = { mcpServers: { fs: { command: 'node', args: ['/old/shomra.mjs', 'mcp-guard', '--name', 'fs', '--', 'npx', '-y', 'server-fs'] } } };
  assert.deepEqual(unwrapMcpConfig(old, '/new/nofly.mjs').restored, ['fs']);
  assert.deepEqual(old.mcpServers.fs, { command: 'npx', args: ['-y', 'server-fs'] });
});

test('an agent still calling the old tool names reaches the same tool', () => {
  assert.deepEqual(mcpToolInvocation('shomra_rules', {}, '/repo'), mcpToolInvocation('nofly_rules', {}, '/repo'));
});

test('a rules block written under the old name is recognised and rewritten in place', () => {
  const old = 'intro\n<!-- BEGIN SHOMRA MANAGED BLOCK -->\nold rules\n<!-- END SHOMRA MANAGED BLOCK -->\n';
  assert.equal(hasRulesBlock(old), true);
  assert.equal(currentMarkers(old), `intro\n${RULES_BEGIN}\nold rules\n${RULES_END}\n`);
});

test('a scheduled report from the old CLI is replaced, not left running beside the new one', () => {
  assert.equal(isCronEntry('17 */6 * * * node /old/shomra.mjs report >/dev/null 2>&1 # shomra-report'), true);
  assert.equal(mergeCrontab('0 1 * * * backup\n17 */6 * * * old # shomra-report\n', 'new # nofly-report'), '0 1 * * * backup\nnew # nofly-report\n');
});

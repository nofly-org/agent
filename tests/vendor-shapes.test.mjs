import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGuardInput } from '../src/guard/normalize.mjs';
import { guardNeedsServer } from '../src/guard/classify.mjs';

const GEMINI_MCP = {
  hook_event_name: 'BeforeTool',
  session_id: 's1',
  cwd: '/repo',
  tool_name: 'mcp_desktop_commander_execute_command',
  tool_input: { command: 'npm install left-pad' },
  mcp_context: { server_name: 'desktop_commander', tool_name: 'execute_command', command: 'npx', args: ['-y', '@wonderwhy-er/desktop-commander'] },
};

test('a Gemini CLI MCP call is read as server + tool, not as an unknown single-underscore name', () => {
  const n = normalizeGuardInput('gemini', GEMINI_MCP);
  assert.equal(n.tool_name, 'mcp__desktop_commander__execute_command');
  assert.deepEqual(n.tool_input, { command: 'npm install left-pad' });
  assert.equal(guardNeedsServer(n.tool_name, n.tool_input, false, {}), true, 'an MCP call always escalates');
});

test('a Gemini built-in tool keeps its own name', () => {
  assert.equal(normalizeGuardInput('gemini', { tool_name: 'run_shell_command', tool_input: { command: 'ls' } }).tool_name, 'run_shell_command');
  assert.equal(normalizeGuardInput('gemini', { tool_name: 'mcp__x__y', tool_input: {}, mcp_context: { server_name: 'a', tool_name: 'b' } }).tool_name, 'mcp__x__y');
});

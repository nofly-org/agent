import path from 'node:path';
import { MAX_ARTIFACT_BYTES, readRegularFile } from '../artifacts/matchers.mjs';
import { splitCommandLine } from './lookup.mjs';

const CODE_FILE_RE = /\.(?:[cm]?js|jsx|[cm]?ts|tsx|py)$/i;
const MCP_GATE_RE = /mcp|modelcontextprotocol/i;
const COMMAND_RE = /(?<![\w$.])(["']?)command\1\s*(?::|=(?!=))\s*(["'`])([^"'`\\\n]{1,200})\2/g;
const ARGS_RE = /(?<![\w$.])(["']?)args\1\s*(?::|=(?!=))\s*\[([^\]]{0,2000})\]/g;
const NAME_RE = /(?<![\w$.])(["']?)name\1\s*(?::|=(?!=))\s*(["'`])([^"'`\\\n]{1,64})\2/g;
const KEY_BEFORE_OBJECT_RE = /(["']?)([A-Za-z0-9_@.-]{1,64})\1\s*:\s*\{[^{}]*$/;
const ELEMENT_RE = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const TRANSPORT_URL_RE = /\b(?:StreamableHTTPClientTransport|SSEClientTransport|WebSocketClientTransport|streamablehttp_client|streamable_http_client|sse_client|websocket_client|MCPServerStreamableHttp|MCPServerStreamableHTTP|MCPServerSse|MCPServerSSE)\b[^;]{0,300}?(["'`])((?:https?|wss?):\/\/[^"'`\s\\]{3,300})\1/g;
const SERVER_URL_RE = /(?<![\w$.])(["']?)server_url\1\s*(?::|=(?!=))\s*(["'`])((?:https?|wss?):\/\/[^"'`\s\\]{3,300})\2/g;
const MCP_PATH_URL_RE = /(["'`])((?:https?|wss?):\/\/[^"'`\s\\/]{1,200}(?:\/[^"'`\s\\]*)?\/(?:mcp|sse)(?:[/?#][^"'`\s\\]*)?)\1/gi;
const DOC_HOST_RE = /^(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|npmjs\.com|pypi\.org|modelcontextprotocol\.io|docs\.[\w.-]+)$/i;
const RUNNER_RE = /^(?:npx|pnpx|bunx|uvx|uv|pipx|node|nodejs|bun|deno|python[\d.]*|py|docker|podman|java|go|cargo|dotnet|ruby|sh|bash)(?:\.exe|\.cmd)?$/i;
const GENERIC_KEYS = new Set(['params', 'parameters', 'server', 'servers', 'options', 'opts', 'config', 'transport', 'stdio', 'spec', 'settings', 'mcpservers', 'mcp_servers', 'mcp', 'env']);
const WINDOW = 600;
const MAX_REFS_PER_FILE = 40;

export function isMcpCodeScannable(file) {
  return CODE_FILE_RE.test(String(file ?? ''));
}

function lineAt(text, index) {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

function stringsIn(body) {
  const out = [];
  for (const m of String(body).matchAll(ELEMENT_RE)) {
    if (m[1] === '`' && m[2].includes('${')) continue;
    out.push(m[2].replace(/\\(["'`\\])/g, '$1'));
  }
  return out;
}

function launchable(command) {
  const program = String(command).split(/[\\/]/).pop();
  return RUNNER_RE.test(program) || /mcp/i.test(program) || /[\\/]/.test(command) || /\.(?:[cm]?js|py|exe)$/i.test(program);
}

function contextBefore(text, start) {
  const from = Math.max(0, start - 400);
  let depth = 0;
  let first = -1;
  for (let i = start - 1; i >= from; i--) {
    const c = text[i];
    if (c === ')' || c === '}' || c === ']') depth++;
    else if (c === '(' || c === '{' || c === '[') {
      if (depth > 0) depth--;
      else if (first === -1) first = i;
      else return text.slice(i + 1, start);
    }
  }
  const anchor = first === -1 ? start : first;
  return text.slice(Math.max(from, text.lastIndexOf('\n', anchor - 1) + 1), start);
}

function nameBefore(text, start) {
  const before = contextBefore(text, start);
  const named = [...before.matchAll(NAME_RE)].pop();
  const keyed = KEY_BEFORE_OBJECT_RE.exec(before);
  if (keyed && !GENERIC_KEYS.has(keyed[2].toLowerCase())) return keyed[2];
  return named ? named[3] : null;
}

function remoteUrlOk(raw) {
  if (/[{}$]/.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (DOC_HOST_RE.test(u.hostname) || /\/(?:blob|tree)\//.test(u.pathname)) return null;
    return u.href;
  } catch {
    return null;
  }
}

function stdioRefs(text) {
  const commands = [...text.matchAll(COMMAND_RE)];
  const argLists = [...text.matchAll(ARGS_RE)];
  const refs = [];
  commands.forEach((cm, i) => {
    const value = cm[3].trim();
    if (!value || (cm[2] === '`' && value.includes('${'))) return;
    const lower = i > 0 ? commands[i - 1].index : -Infinity;
    const upper = i + 1 < commands.length ? commands[i + 1].index : Infinity;
    const near = argLists
      .filter((a) => a.index > lower && a.index < upper && Math.abs(a.index - cm.index) <= WINDOW)
      .sort((a, b) => Math.abs(a.index - cm.index) - Math.abs(b.index - cm.index))[0];
    const split = splitCommandLine(value);
    const listed = near ? stringsIn(near[2]) : [];
    const command = split[0];
    const args = [...split.slice(1), ...listed];
    if (!command || !launchable(command)) return;
    refs.push({ kind: 'stdio', command, args, index: cm.index, name: nameBefore(text, Math.min(cm.index, near?.index ?? cm.index)), via: 'launch spec' });
  });
  return refs;
}

function remoteRefs(text) {
  const refs = [];
  const seen = new Set();
  const add = (raw, index, via) => {
    const url = remoteUrlOk(raw);
    if (!url || seen.has(url)) return;
    seen.add(url);
    refs.push({ kind: 'remote', url, index, name: nameBefore(text, index), via });
  };
  for (const m of text.matchAll(TRANSPORT_URL_RE)) add(m[2], m.index, 'MCP transport');
  for (const m of text.matchAll(SERVER_URL_RE)) add(m[3], m.index, 'server_url');
  for (const m of text.matchAll(MCP_PATH_URL_RE)) add(m[2], m.index, 'MCP endpoint URL');
  return refs;
}

export function scanMcpCodeRefs(text, file = '') {
  const content = String(text ?? '');
  if (!MCP_GATE_RE.test(content)) return [];
  const refs = [...stdioRefs(content), ...remoteRefs(content)].sort((a, b) => a.index - b.index).slice(0, MAX_REFS_PER_FILE);
  return refs.map(({ index, ...ref }) => ({ ...ref, file, line: lineAt(content, index) }));
}

export function collectMcpCodeReferences(root, entries) {
  const refs = [];
  for (const rel of entries) {
    if (!isMcpCodeScannable(rel)) continue;
    const read = readRegularFile(path.join(root, rel), MAX_ARTIFACT_BYTES);
    if (typeof read.content !== 'string' || read.content.includes('\0')) continue;
    refs.push(...scanMcpCodeRefs(read.content, rel));
  }
  return refs;
}

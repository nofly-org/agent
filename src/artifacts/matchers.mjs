import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_MANIFEST_RE, TOOL_MANIFEST_RE } from '../detect/signals/manifests.mjs';

export const ARTIFACT_MATCHERS = [
  { kind: 'plugin', re: PLUGIN_MANIFEST_RE },
  { kind: 'tool-manifest', re: TOOL_MANIFEST_RE },
  { kind: 'mcp', re: /(^|\/)\.?mcp\.json$/i },
  { kind: 'mcp', re: /(^|\/)\.(vscode|cursor)\/mcp\.json$/i },
  { kind: 'mcp', re: /(^|\/)\.(kiro\/settings|amazonq|roo|windsurf|vs|junie\/mcp)\/mcp\.json$/i },
  { kind: 'mcp', re: /(^|\/)(opencode\.jsonc?|crush\.json|\.codex\/config\.toml|\.continue\/(config\.ya?ml|mcpServers\/[^/]+\.(ya?ml|json)))$/i },
  { kind: 'model-config', re: /(^|\/)(tokenizer_config|generation_config|adapter_config|model_index|special_tokens_map|config_sentence_transformers|preprocessor_config|processor_config)\.json$/i },
  { kind: 'model-config', re: /(^|\/)(chat_template\.(jinja2?|json)|(.*\.)?modelfile|MLmodel|config\.pbtxt|bentofile\.ya?ml)$/i },
  { kind: 'skill', re: /(^|\/)SKILL\.md$/i },
  { kind: 'command', re: /(^|\/)\.claude\/commands\/.+\.md$/i },
  { kind: 'subagent', re: /(^|\/)\.claude\/agents\/.+\.md$/i },
  { kind: 'hook', re: /(^|\/)\.claude\/settings(\.local)?\.json$/i },

  { kind: 'hook', re: /(^|\/)\.cursor\/hooks\.json$/i },
  { kind: 'hook', re: /(^|\/)(\.windsurf|\.codeium\/windsurf)\/hooks\.json$/i },
  { kind: 'hook', re: /(^|\/)\.gemini\/settings\.json$/i },
  { kind: 'hook', re: /(^|\/)\.cline\/hooks\.json$/i },
  { kind: 'hook', re: /(^|\/)\.codex\/hooks\.json$/i },
  { kind: 'hook', re: /(^|\/)(\.github|\.copilot)\/hooks\/[^/]+\.json$/i },
  { kind: 'hook', re: /(^|\/)\.aider\.conf\.yml$/i },
  { kind: 'agent-card', re: /(^|\/)\.well-known\/agent(-card)?\.json$/i },
  { kind: 'agent-card', re: /(^|\/)agent[-_]card\.json$/i },
  { kind: 'rules', re: /(^|\/)(CLAUDE|AGENTS|GEMINI|CONVENTIONS)\.md$/i },
  { kind: 'rules', re: /(^|\/)\.(cursorrules|windsurfrules|clinerules|aiderrules|continuerules|goosehints)$/i },
  { kind: 'rules', re: /(^|\/)\.github\/copilot-instructions\.md$/i },
  { kind: 'rules', re: /(^|\/)\.cursor\/rules\/[^/]+\.mdc$/i },

  { kind: 'env', re: /(^|\/)\.env(\.(local|development|dev|production|prod|staging|stage|test))?$/i },
  { kind: 'memory', re: /(^|\/)MEMORY\.md$/i },
  { kind: 'memory', re: /(^|\/)(mem0|letta_memory|memgpt_memory)\.json$/i },
  { kind: 'memory', re: /(^|\/)(\.mem0|\.letta|\.memgpt|memory)\/[^/]+\.(md|json)$/i },
];

export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'vendor', '.venv', '__pycache__']);

export const MAX_ARTIFACT_BYTES = 1_000_000;

const ALWAYS_SKIP = new Set(['node_modules', '.git']);
const AGENT_CONFIG_SEGMENT = /^(?:\.claude|\.cursor|\.codex|\.gemini|\.windsurf|\.codeium|\.cline|\.clinerules|\.continue|\.kiro|\.roo|\.amazonq|\.junie|\.github|\.copilot|\.agents?|\.vscode|\.opencode|\.goose|skills)$/i;

export function descendInto(parentRel, name) {
  if (ALWAYS_SKIP.has(name)) return false;
  if (!SKIP_DIRS.has(name)) return true;
  return String(parentRel ?? '').split('/').some((segment) => AGENT_CONFIG_SEGMENT.test(segment));
}

function realOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function insideRoot(realRoot, target) {
  const rel = path.relative(realRoot, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function readableEntry(realRoot, full, ent) {
  if (ent.isFile()) return {};
  if (!ent.isSymbolicLink()) return null;
  let real;
  let st;
  try {
    real = fs.realpathSync(full);
    st = fs.statSync(real);
  } catch {
    return null;
  }
  if (st.isDirectory()) return null;
  if (!st.isFile()) return { skip: 'a symlink to something that is not a regular file' };
  if (!insideRoot(realRoot, real)) return { skip: 'a symlink to a file outside the scanned folder' };
  return {};
}

export function walkArtifacts(root) {
  const found = [];
  const realRoot = realOr(root);
  const stack = [[root, '']];
  while (stack.length) {
    const [dir, relDir] = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (descendInto(relDir, ent.name)) stack.push([full, rel]);
        continue;
      }
      const match = ARTIFACT_MATCHERS.find((m) => m.re.test(rel));
      if (!match) continue;
      const readable = readableEntry(realRoot, full, ent);
      if (readable) found.push({ full, rel, kind: match.kind, ...readable });
    }
  }
  return found;
}

export function resolveScanTarget(value, { fallback = '.' } = {}) {
  const target = value === undefined || value === null || value === '' ? fallback : value;
  if (typeof target !== 'string') return { error: 'a path is required after --path' };
  if (target.startsWith('-')) return { error: `"${target}" looks like a flag, not a path - did you mean --${target.replace(/^-+/, '')}?` };
  const full = path.resolve(target);
  let st;
  try {
    st = fs.statSync(full);
  } catch {
    return { error: `No such file or directory: ${target}` };
  }
  if (st.isDirectory()) return { root: full };
  if (!st.isFile()) return { error: `${target} is not a file or a directory` };
  const root = path.dirname(full);
  const rel = path.basename(full);
  const kind = ARTIFACT_MATCHERS.find((m) => m.re.test(rel))?.kind;
  return { root, single: { full, rel, ...(kind ? { kind } : {}) } };
}

export function readRegularFile(full, maxBytes = MAX_ARTIFACT_BYTES) {
  let fd;
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { skip: 'not a regular file' };
    if (st.size > maxBytes) return { skip: 'too large' };
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    return { content: buf.subarray(0, n).toString('utf8') };
  } catch (error) {
    return { skip: `could not be read (${error.code ?? error.message})` };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}

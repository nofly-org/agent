import fs from 'node:fs';
import path from 'node:path';
import { isAiUsageScannable } from '../../detect/ai-usage.mjs';
import { exists } from './fs-read.mjs';
import { userDirs } from './platform.mjs';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt',
  '.cache', '.venv', 'venv', 'env', '__pycache__', '.tox', 'target', 'vendor',
  'bin', 'obj', '.gradle', '.idea', 'coverage', '.pytest_cache', '.mypy_cache',
  'Pods', '.terraform', '.expo', 'tmp', 'temp', '.turbo', '.parcel-cache',
  '.svelte-kit', 'bower_components', '.pnpm-store', 'site-packages', '.yarn',
]);

function workspaceParents(HOME) {
  const names = [
    'Desktop', 'Documents', 'source', 'source/repos', 'repos', 'Repos',
    'projects', 'Projects', 'dev', 'Dev', 'Developer', 'git', 'Git', 'code',
    'Code', 'workspace', 'Workspace', 'work', 'src', 'go/src', 'ghq',
    'OneDrive/Desktop', 'OneDrive/Documents',
  ];
  return names.map((n) => path.join(HOME, n)).filter(exists);
}

export function resolveRoots(roots, autoExpand, home) {
  const { HOME } = userDirs(home);
  const out = new Set();
  for (const r of roots || []) if (r) out.add(path.resolve(r));
  if (autoExpand) {
    out.add(HOME);
    for (const parent of workspaceParents(HOME)) {
      out.add(parent);
      try {
        for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
          if (e.isDirectory() && !e.name.startsWith('.') && !IGNORE_DIRS.has(e.name)) {
            out.add(path.join(parent, e.name));
          }
        }
      } catch {

      }
    }
  }
  return [...out].slice(0, 500);
}

const RULE_NAMES = new Set([
  '.cursorrules', '.windsurfrules', '.clinerules', '.roorules', '.aider.conf.yml',
  '.aider.conf.yaml', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'copilot-instructions.md',
]);

const MANIFEST_NAMES = new Set([
  'package.json', 'requirements.txt', 'requirements-dev.txt', 'pyproject.toml',
  'Pipfile', 'environment.yml', 'environment.yaml',
]);

const isEnvFile = (base) =>
  /^\.env(\..+)?$/.test(base) && !/(example|sample|template|dist)/i.test(base);

const VECTOR_INDEX_BASENAMES = new Set([
  'chroma.sqlite3',
  'index.faiss', 'index.pkl',
  'docstore.json', 'default__vector_store.json',
  'chroma-embeddings.parquet', 'chroma-collections.parquet',
]);

const VECTOR_INDEX_EXTS = new Set(['faiss', 'lance', 'usearch']);

const isVectorIndex = (base) =>
  VECTOR_INDEX_BASENAMES.has(base.toLowerCase()) ||
  VECTOR_INDEX_EXTS.has((base.slice(base.lastIndexOf('.') + 1) || '').toLowerCase());

const MAX_SOURCE_FILES = 600;
const EXPLICIT_DIRS = 20_000;
const SHARED_DIRS = 40_000;
const MAX_DEPTH = 6;

const HOME_SKIP = new Set([
  'Library', 'AppData', 'Applications', 'Music', 'Movies', 'Pictures', 'Videos', 'snap', 'go',
  '.npm', '.cargo', '.rustup', '.m2', '.nvm', '.pyenv', '.rbenv', '.conda', 'anaconda3', 'miniconda3',
  '.android', '.dotnet', '.nuget', '.Trash', '.local', '.vscode', '.vscode-server', '.cursor-server', '.docker',
]);

const keyOf = (dir) => path.resolve(dir);

export function walkWorkspace(roots, opts = {}) {
  const found = { mcp: [], rules: [], manifests: [], env: [], vector: [], source: [], capped: [] };
  const seenDir = new Set();
  const explicit = new Set((opts.explicit ?? []).filter(Boolean).map(keyOf));
  const home = opts.home ? keyOf(opts.home) : null;
  const shared = { dirs: opts.sharedDirs ?? SHARED_DIRS };
  let sourceCapped = false;

  const consider = (base, full, parentBase) => {
    if (base === '.mcp.json' || base === 'mcp.json') found.mcp.push({ file: full, parentBase });
    else if (base === 'settings.json' && (parentBase === '.gemini' || parentBase === '.zed'))
      found.mcp.push({ file: full, parentBase });
    else if (RULE_NAMES.has(base)) {
      if (base === 'copilot-instructions.md' && parentBase !== '.github') return;
      found.rules.push({ file: full, parentBase });
    } else if (MANIFEST_NAMES.has(base)) found.manifests.push({ file: full, parentBase });
    else if (isEnvFile(base)) found.env.push({ file: full, parentBase });
    else if (isVectorIndex(base)) found.vector.push({ file: full, parentBase });
    else if (isAiUsageScannable(base)) {
      if (found.source.length < MAX_SOURCE_FILES) found.source.push({ file: full, parentBase });
      else sourceCapped = true;
    }
  };

  const walkRoot = (root, budget) => {
    const atHome = home !== null && keyOf(root) === home;
    const queue = [{ dir: root, depth: 0 }];
    for (let next = 0; next < queue.length; next++) {
      if (budget.dirs <= 0) return false;
      const { dir, depth } = queue[next];
      let real;
      try {
        real = fs.realpathSync(dir);
      } catch {
        continue;
      }
      if (seenDir.has(real)) continue;
      seenDir.add(real);
      budget.dirs--;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < MAX_DEPTH && !IGNORE_DIRS.has(e.name) && !(atHome && depth === 0 && HOME_SKIP.has(e.name))) queue.push({ dir: full, depth: depth + 1 });
        } else if (e.isFile()) {
          consider(e.name, full, path.basename(dir));
        }
      }
    }
    return true;
  };

  const first = roots.filter((r) => explicit.has(keyOf(r)));
  const rest = roots.filter((r) => !explicit.has(keyOf(r)) && keyOf(r) !== home);
  const last = roots.filter((r) => !explicit.has(keyOf(r)) && keyOf(r) === home);
  for (const root of first) {
    if (!walkRoot(root, { dirs: opts.explicitDirs ?? EXPLICIT_DIRS })) found.capped.push({ reason: 'walk-budget', path: root });
  }
  const shareds = [...rest, ...last];
  for (let i = 0; i < shareds.length; i++) {
    if (walkRoot(shareds[i], shared)) continue;
    found.capped.push({ reason: 'walk-budget', path: shareds[i], ...(shareds.length - i > 1 ? { count: shareds.length - i } : {}) });
    break;
  }
  if (sourceCapped) found.capped.push({ reason: 'source-cap', path: null });
  return found;
}

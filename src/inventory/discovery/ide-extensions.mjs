import fs from 'node:fs';
import path from 'node:path';
import { readJson, readTextBounded } from './fs-read.mjs';
import { userDirs } from './platform.mjs';

export const MAX_EXTENSIONS = 300;
export const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_BUNDLE_BYTES = 64 * 1024 * 1024;
export const EXTENSION_SCAN_BUDGET_MS = 20_000;
const MAX_HOSTS = 60;
const MAX_CONTRIBUTES = 40;
const MAX_PULLS = 30;

const HOST_RE = /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)/gi;
const IP_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export const READ_SIGNALS = [
  ['credential-files', /(?:^|[^\w$])\.(?:ssh|aws|kube|docker|azure|gnupg)[\\/]|\.netrc\b|\.git-credentials\b|\bid_(?:rsa|ed25519|ecdsa)\b/],
  ['auth-sessions', /\bauthentication\.getSession\s*\(/],
  ['secret-storage', /\bsecrets\.(?:get|store)\s*\(|\bkeytar\b/],
  ['clipboard', /\bclipboard\.readText\s*\(/],
  ['terminal', /\bonDidWriteTerminalData\b|\bonDidStartTerminalShellExecution\b|\.shellIntegration\b/],
  ['workspace-files', /\bworkspace\.findFiles\s*\(|\bworkspace\.fs\.readFile\s*\(/],
  ['open-documents', /\bonDidChangeTextDocument\b|\bworkspace\.textDocuments\b/],
  ['language-models', /\blm\.selectChatModels\s*\(/],
];

export const CAN_SIGNALS = [
  ['network', /\bfetch\s*\(|\bhttps?\.request\s*\(|\bnew\s+WebSocket\s*\(|\bXMLHttpRequest\b|\baxios\b/],
  ['exec', /\bchild_process\b|\bexecFile(?:Sync)?\s*\(|\bspawn(?:Sync)?\s*\(/],
];

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function realInside(root, target) {
  try {
    const rel = path.relative(fs.realpathSync(root), fs.realpathSync(target));
    return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

export function extensionStores({ home } = {}) {
  const { HOME } = userDirs(home);
  let names = [];
  try {
    names = fs.readdirSync(HOME);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith('.') && n.length > 1)
    .map((n) => ({ editor: n.slice(1), root: path.join(HOME, n, 'extensions') }))
    .filter((s) => isDir(s.root) && fs.existsSync(path.join(s.root, 'extensions.json')));
}

function fsPathOf(location) {
  const raw = location?.fsPath ?? location?.path;
  if (typeof raw !== 'string' || !raw) return null;
  return process.platform === 'win32' ? raw.replace(/^\/([a-zA-Z]:)/, '$1') : raw;
}

export function installedExtensions(store) {
  const index = readJson(path.join(store.root, 'extensions.json'));
  if (!Array.isArray(index)) return { entries: [], unreadIndex: true };
  const entries = [];
  for (const e of index) {
    const id = String(e?.identifier?.id ?? '').toLowerCase();
    if (!/^[\w-]{1,80}\.[\w.-]{1,120}$/.test(id)) continue;
    const dir = e?.relativeLocation ? path.join(store.root, String(e.relativeLocation)) : fsPathOf(e?.location);
    if (!dir || !realInside(store.root, dir)) continue;
    entries.push({
      id,
      dir,
      version: typeof e?.version === 'string' ? e.version.slice(0, 40) : null,
      source: typeof e?.metadata?.source === 'string' ? e.metadata.source.slice(0, 20) : null,
      publisherDisplayName: typeof e?.metadata?.publisherDisplayName === 'string' ? e.metadata.publisherDisplayName.slice(0, 80) : null,
      preRelease: e?.metadata?.isPreReleaseVersion === true,
    });
  }
  return { entries, unreadIndex: false };
}

function entryFile(dir, rel) {
  if (typeof rel !== 'string' || !rel) return null;
  const base = path.resolve(dir, rel);
  return [base, `${base}.js`, path.join(base, 'index.js')].find((f) => {
    try {
      return fs.statSync(f).isFile() && realInside(dir, f);
    } catch {
      return false;
    }
  }) ?? null;
}

export function activationOf(pkg) {
  const events = Array.isArray(pkg?.activationEvents) ? pkg.activationEvents.map(String) : [];
  if (events.includes('*') || events.includes('onStartupFinished')) return 'always';
  if (events.length) return 'on-event';
  return pkg?.main || pkg?.browser ? 'on-contribution' : 'none';
}

export function untrustedOf(pkg) {
  const v = pkg?.capabilities?.untrustedWorkspaces?.supported;
  return v === true || v === 'limited' || v === false ? v : null;
}

export function bundleFacts(text) {
  const hosts = [];
  const seen = new Set();
  let more = false;
  for (const m of text.matchAll(HOST_RE)) {
    const h = m[1].toLowerCase();
    if (seen.has(h) || IP_HOST.test(h) || !/\.[a-z]{2,}$/.test(h)) continue;
    seen.add(h);
    if (hosts.length >= MAX_HOSTS) {
      more = true;
      break;
    }
    hosts.push(h);
  }
  return {
    reads: READ_SIGNALS.filter(([, re]) => re.test(text)).map(([tag]) => tag),
    can: CAN_SIGNALS.filter(([, re]) => re.test(text)).map(([tag]) => tag),
    hosts,
    hostsTruncated: more,
  };
}

function idsOf(list) {
  return (Array.isArray(list) ? list : [])
    .filter((x) => typeof x === 'string' && /^[\w-]{1,80}\.[\w.-]{1,120}$/.test(x.trim()))
    .map((x) => x.trim().toLowerCase())
    .slice(0, MAX_PULLS);
}

export function readExtension(entry, editor, budget) {
  const pkg = readJson(path.join(entry.dir, 'package.json'));
  const base = {
    type: 'AI_TOOL',
    name: entry.id,
    identifier: entry.dir,
    metadata: {
      category: 'ide-extension',
      editor,
      extensionId: entry.id,
      version: entry.version,
      source: entry.source,
      publisherDisplayName: entry.publisherDisplayName,
      preRelease: entry.preRelease,
    },
  };
  if (!pkg || typeof pkg !== 'object') return { ...base, metadata: { ...base.metadata, manifest: 'unread', bundleRead: 'none' } };
  const meta = {
    ...base.metadata,
    displayName: typeof pkg.displayName === 'string' ? pkg.displayName.slice(0, 120) : null,
    activation: activationOf(pkg),
    untrustedWorkspaces: untrustedOf(pkg),
    contributes: pkg.contributes && typeof pkg.contributes === 'object' ? Object.keys(pkg.contributes).slice(0, MAX_CONTRIBUTES) : [],
    pulls: [...idsOf(pkg.extensionPack), ...idsOf(pkg.extensionDependencies)].slice(0, MAX_PULLS),
  };
  const file = entryFile(entry.dir, pkg.main) ?? entryFile(entry.dir, pkg.browser);
  if (!file) return { ...base, metadata: { ...meta, bundleRead: 'none' } };
  if (Date.now() > budget.deadline || budget.bytes <= 0) return { ...base, metadata: { ...meta, bundleRead: 'skipped' } };
  const read = readTextBounded(file, Math.min(MAX_BUNDLE_BYTES, budget.bytes));
  if (!read) return { ...base, metadata: { ...meta, bundleRead: 'unread' } };
  budget.bytes -= read.text.length;
  return { ...base, metadata: { ...meta, ...bundleFacts(read.text), bundleRead: read.truncated ? 'partial' : 'complete' } };
}

export function discoverIdeExtensions(opts = {}) {
  const budget = { bytes: MAX_TOTAL_BUNDLE_BYTES, deadline: Date.now() + (opts.budgetMs ?? EXTENSION_SCAN_BUDGET_MS) };
  const out = [];
  for (const store of extensionStores(opts)) {
    const { entries, unreadIndex } = installedExtensions(store);
    if (unreadIndex) opts.onCap?.({ reason: 'extension-index-unread', path: path.join(store.root, 'extensions.json') });
    for (const entry of entries) {
      if (out.length >= MAX_EXTENSIONS) {
        opts.onCap?.({ reason: 'extension-cap', path: store.root, detail: `more than ${MAX_EXTENSIONS} editor extensions are installed; the rest were not read` });
        return out;
      }
      out.push(readExtension(entry, store.editor, budget));
    }
  }
  return out;
}

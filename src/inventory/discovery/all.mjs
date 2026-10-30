import { clampAsset } from '../../core/wire-limits.mjs';
import { discoverAiDependencies, discoverAiUsageInCode } from './ai-dependencies.mjs';
import { discoverAiTools } from './ai-tools.mjs';
import { discoverCloudClis } from './cloud-clis.mjs';
import { discoverCodingAgents } from './coding-agents.mjs';
import { discoverIdeExtensions } from './ide-extensions.mjs';
import { discoverMcpClients } from './mcp-clients.mjs';
import { discoverMcpServers } from './mcp-servers.mjs';
import { discoverDotenvKeys, discoverModelKeys } from './model-keys.mjs';
import { discoverRulesFiles } from './rules-files.mjs';
import { discoverVectorStores } from './vector-stores.mjs';
import { userDirs } from './platform.mjs';
import { resolveRoots, walkWorkspace } from './workspace.mjs';

const failures = [];

export function discoveryFailures() {
  return failures.slice();
}

function fromSource(source, read) {
  try {
    const found = read();
    return Array.isArray(found) ? found : [];
  } catch (error) {
    failures.push({ reason: 'source-failed', path: source, detail: String(error?.message ?? error).slice(0, 200) });
    return [];
  }
}

export function discoverAll(roots = [process.cwd()], opts = {}) {
  const { autoExpand = true, home, extensions = true } = opts;
  const own = userDirs(home).own;
  const scanRoots = resolveRoots(roots, autoExpand, home);
  const files = walkWorkspace(scanRoots, { explicit: roots, home: userDirs(home).HOME });
  for (const cap of files.capped) failures.push(cap);
  const all = [
    ...fromSource('mcp-servers', () => discoverMcpServers(scanRoots, files, { home })),
    ...fromSource('rules-files', () => discoverRulesFiles(scanRoots, files)),
    ...fromSource('ai-dependencies', () => discoverAiDependencies(scanRoots, files)),
    ...fromSource('ai-usage-in-code', () => discoverAiUsageInCode(scanRoots, files)),
    ...fromSource('mcp-clients', () => discoverMcpClients(scanRoots, files)),
    ...fromSource('vector-stores', () => discoverVectorStores(scanRoots, files)),
    ...fromSource('dotenv-keys', () => discoverDotenvKeys(scanRoots, files)),
    ...fromSource('ai-tools', () => discoverAiTools({ home })),
    ...fromSource('coding-agents', () => discoverCodingAgents(scanRoots, { home })),
    ...(extensions ? fromSource('ide-extensions', () => discoverIdeExtensions({ home, onCap: (c) => failures.push(c) })) : []),
    ...(own ? fromSource('model-keys', () => discoverModelKeys()) : []),
    // ⚠ What this HOST is logged into - the reach an agent with a shell
    // inherits and no agent policy granted. See `cloud-clis.mjs`.
    ...fromSource('cloud-clis', () => discoverCloudClis({ home })),
  ];

  const clamped = all.map(clampAsset);

  const seen = new Set();
  const out = [];
  for (const a of clamped) {
    const key = `${a.type}::${a.identifier || a.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

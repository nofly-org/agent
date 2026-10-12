import { downrankCodeContext, grade, localScan } from '../detect/guard-signals.mjs';

const MAX_EXTRACT_DEPTH = 24;
const MAX_SCREEN_CHARS = 512 * 1024;
const TEXT_MIME_RE = /^(?:text\/|application\/(?:json|xml|javascript|x-sh|x-shellscript|x-yaml|yaml|toml|x-python|x-httpd-php|sql|graphql))/i;

function windowed(text, max = MAX_SCREEN_CHARS) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n${text.slice(text.length - half)}`;
}

function fullJson(value) {
  if (value == null) return '';
  try {
    return windowed(JSON.stringify(value) ?? '');
  } catch {
    return '';
  }
}

function decodedBlob(owner, blob) {
  if (typeof blob !== 'string' || !TEXT_MIME_RE.test(String(owner?.mimeType ?? ''))) return null;
  try {
    return Buffer.from(blob.slice(0, MAX_SCREEN_CHARS * 2), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export const LISTING_KEY = {
  'tools/list': 'tools',
  'resources/list': 'resources',
  'resources/templates/list': 'resourceTemplates',
  'prompts/list': 'prompts',
};

export const RESULT_METHODS = new Set(['resources/read', 'prompts/get', 'completion/complete']);

function extractResultText(value) {
  const collected = [];
  let size = 0;
  const push = (text) => {
    collected.push(text);
    size += text.length;
  };
  const walk = (node, depth) => {
    if (size > MAX_SCREEN_CHARS * 4) return;
    if (typeof node === 'string') return push(node);
    if (!node || typeof node !== 'object') return;
    if (depth > MAX_EXTRACT_DEPTH) return push(fullJson(node));
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(node)) {
      if (key === 'blob') {
        const text = decodedBlob(node, item);
        if (text) push(text);
        continue;
      }
      walk(item, depth + 1);
    }
  };
  walk(value, 0);
  return collected;
}

function isUnmaskedThreat(finding) {
  return !finding.codeContext && (finding.severity === 'CRITICAL' || finding.category === 'injection');
}

export function screenResult(result) {
  const text = windowed(extractResultText(result).join('\n'));
  if (!text.trim()) return { blocked: false };

  const scan = localScan(text);
  if (!scan.findings.some(isUnmaskedThreat)) return { blocked: false };

  const ranked = downrankCodeContext(scan.findings);
  const worst = ranked.find((f) => f.severity === 'CRITICAL' && !f.codeContext)
    ?? ranked.find((f) => f.category === 'injection' && !f.codeContext)
    ?? ranked[0];
  return { blocked: true, label: worst?.label || 'malicious content' };
}

function descriptorText(entry, method) {
  const descriptor = entry ?? {};
  const parts = method === 'tools/list'
    ? [
      descriptor.name ?? '', typeof descriptor.title === 'string' ? descriptor.title : '', descriptor.description ?? '',
      fullJson(descriptor.annotations), fullJson(descriptor.inputSchema), fullJson(descriptor.outputSchema), fullJson(descriptor._meta),
    ]
    : [
      descriptor.name ?? '', descriptor.title ?? '', descriptor.description ?? '',
      descriptor.uri ?? '', descriptor.uriTemplate ?? '', fullJson(descriptor.arguments), fullJson(descriptor._meta),
    ];
  return windowed(parts.filter((p) => typeof p === 'string' && p).join('\n'));
}

function descriptorLabel(entry) {
  return String(entry?.name ?? entry?.uri ?? entry?.uriTemplate ?? 'unnamed');
}

function poisonedText(text) {
  if (!text.trim()) return false;
  const { findings } = localScan(text, { categories: ['injection', 'secret', 'egress'] });
  return findings.some((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH');
}

function isPoisonedDescriptor(entry, method) {
  return poisonedText(descriptorText(entry, method));
}

export function screenInstructions(result) {
  if (typeof result?.instructions !== 'string' || !poisonedText(windowed(result.instructions))) return { result, withheld: false };
  const { instructions: _withheld, ...rest } = result;
  return { result: rest, withheld: true };
}

export function screenListing(method, result, deniedTools = []) {
  const key = LISTING_KEY[method];
  const entries = key && Array.isArray(result?.[key]) ? result[key] : null;
  if (!entries) return { result, withheld: [], denied: [], total: 0 };

  const denySet = new Set(deniedTools ?? []);
  const kept = [];
  const withheld = [];
  const denied = [];
  for (const entry of entries) {
    if (method === 'tools/list' && denySet.has(String(entry?.name ?? ''))) {
      denied.push(String(entry.name));
    } else if (isPoisonedDescriptor(entry, method)) {
      withheld.push(descriptorLabel(entry));
    } else {
      kept.push(entry);
    }
  }
  if (!withheld.length && !denied.length) return { result, withheld: [], denied: [], total: entries.length };
  return { result: { ...result, [key]: kept }, withheld, denied, total: entries.length };
}

export function screenToolCallArguments(toolArguments) {
  const leaves = windowed(extractResultText(toolArguments).join('\n'));
  const { findings } = localScan(`${leaves}\n${fullJson(toolArguments)}`, { categories: ['shell', 'injection', 'secret'] });
  if (grade(findings).verdict !== 'BLOCK') return { blocked: false };
  const label = findings.find((f) => f.severity === 'CRITICAL')?.label || 'dangerous tool call';
  return { blocked: true, label };
}

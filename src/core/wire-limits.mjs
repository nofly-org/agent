
import { createHash } from 'node:crypto';

export const WIRE_LIMITS = {
  asset: { name: 255, identifier: 1024, content: 200_000 },
  artifact: { name: 200, path: 1024, content: 200_000 },
  artifactFile: { path: 1024, content: 200_000 },
};

const FINGERPRINT = 12;

export function clampField(value, max) {
  if (typeof value !== 'string' || value.length <= max) return value;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 10);
  return `${value.slice(0, Math.max(1, max - FINGERPRINT))}…#${digest}`;
}

export function clampAsset(asset) {
  const L = WIRE_LIMITS.asset;
  return {
    ...asset,
    name: clampField(asset.name, L.name),
    ...(asset.identifier != null ? { identifier: clampField(asset.identifier, L.identifier) } : {}),
    ...(typeof asset.content === 'string' && asset.content.length > L.content
      ? { content: asset.content.slice(0, L.content) }
      : {}),
  };
}

export function clampArtifact(artifact) {
  const L = WIRE_LIMITS.artifact;
  const F = WIRE_LIMITS.artifactFile;
  return {
    ...artifact,
    name: clampField(artifact.name, L.name),
    path: clampField(artifact.path, L.path),
    ...(typeof artifact.content === 'string' && artifact.content.length > L.content
      ? { content: artifact.content.slice(0, L.content) }
      : {}),
    ...(Array.isArray(artifact.files)
      ? {
          files: artifact.files.map((f) => ({
            ...f,
            path: clampField(f.path, F.path),

            ...(typeof f.content === 'string' && f.content.length > F.content
              ? { content: f.content.slice(0, F.content) }
              : {}),
          })),
        }
      : {}),
  };
}

export const MAX_WIRE_DEPTH = 32;
export const TOO_DEEP = '[nofly: nested too deep to read]';

export function pruneDepth(value, depth = 0) {
  if (!value || typeof value !== 'object') return value;
  if (depth >= MAX_WIRE_DEPTH) return TOO_DEEP;
  if (Array.isArray(value)) return value.map((item) => pruneDepth(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, pruneDepth(item, depth + 1)]));
}

export function boundedJson(value, space) {
  try {
    return JSON.stringify(pruneDepth(value), null, space);
  } catch {
    return JSON.stringify(TOO_DEEP);
  }
}

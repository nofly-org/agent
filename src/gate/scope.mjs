import fs from 'node:fs';
import path from 'node:path';
import { MAX_ARTIFACT_BYTES, artifactKindOf, descendInto, walkablePath } from '../artifacts/matchers.mjs';
import { blobSizes, readBlobs } from '../core/git-changes.mjs';
import { FILE_MODES, LINK_MODE, keysUnder, sortedKeys, touchesChange, treeResolver } from '../core/git-tree.mjs';
import { bundledKind, byBundledPriority, planBundled } from './sast.mjs';

const MAX_LINKS_FOLLOWED = 2000;

function changedFolders(changed) {
  const dirs = new Set();
  for (const rel of changed) {
    let dir = path.posix.dirname(rel);
    while (!dirs.has(dir)) {
      dirs.add(dir);
      if (dir === '.') break;
      dir = path.posix.dirname(dir);
    }
  }
  return dirs;
}

function bundledPath(inner) {
  const parts = inner.split('/');
  let parent = 'skills';
  for (const segment of parts.slice(0, -1)) {
    if (!descendInto(parent, segment)) return false;
    parent = `${parent}/${segment}`;
  }
  return !!bundledKind(parts[parts.length - 1]);
}

function bundledEntries(tree, keys, skillRel) {
  const dir = path.posix.dirname(skillRel);
  const base = dir === '.' ? '' : dir;
  const out = [];
  for (const rel of keysUnder(keys, base)) {
    if (rel === skillRel) continue;
    const entry = tree.get(rel);
    if (!FILE_MODES.has(entry.mode) && entry.mode !== LINK_MODE) continue;
    if (bundledPath(base ? rel.slice(base.length + 1) : rel)) out.push(entry);
  }
  return out;
}

const fromCwd = (root, rel) => path.relative(process.cwd(), path.join(root, ...rel.split('/'))).split(path.sep).join('/');

async function treeSkillScripts(root, tree, keys, resolve, skillRel) {
  const candidates = [];
  const skipped = [];
  for (const entry of bundledEntries(tree, keys, skillRel)) {
    const resolved = entry.mode === LINK_MODE ? await resolve(entry.rel) : { oid: entry.oid };
    if (resolved.directory || resolved.dangling) continue;
    if (resolved.skip) skipped.push({ rel: fromCwd(root, entry.rel), skip: resolved.skip });
    else candidates.push({ rel: fromCwd(root, entry.rel), oid: resolved.oid });
  }
  const sizes = blobSizes(root, [...new Set(candidates.map((c) => c.oid))]);
  const plan = planBundled(candidates.map((c) => ({ ...c, size: sizes.get(c.oid) ?? null })).sort(byBundledPriority));
  const blobs = await readBlobs(root, plan.take.map((c) => c.oid), { maxBytes: MAX_ARTIFACT_BYTES });
  return [...plan.take.map((c) => ({ rel: c.rel, ...blobs.get(c.oid) })), ...skipped, ...plan.skipped];
}

async function linkedScriptTouches(tree, keys, resolve, skillRel, changed) {
  for (const entry of bundledEntries(tree, keys, skillRel)) {
    if (entry.mode !== LINK_MODE) continue;
    if (touchesChange((await resolve(entry.rel)).trail, changed)) return true;
  }
  return false;
}

export async function treeArtifacts(root, tree, { changed = null, single = null, carrier = 'this commit' } = {}) {
  const resolve = treeResolver(root, tree);
  const keys = sortedKeys(tree);
  const changedSet = changed ? new Set(changed) : null;
  const folders = changed ? changedFolders(changed) : null;
  const artifacts = [];
  const wanted = [];
  for (const rel of keys) {
    if (single && rel !== single.rel) continue;
    const kind = single ? single.kind ?? artifactKindOf(rel) : artifactKindOf(rel);
    if (!single && (!kind || !walkablePath(rel))) continue;
    const entry = tree.get(rel);
    let resolved = null;
    let inScope = !changedSet || changedSet.has(rel) || (kind === 'skill' && folders.has(path.posix.dirname(rel)));
    if (!inScope && entry.mode === LINK_MODE) {
      resolved = await resolve(rel);
      inScope = touchesChange(resolved.trail, changedSet);
    }
    if (!inScope && kind === 'skill') inScope = await linkedScriptTouches(tree, keys, resolve, rel, changedSet);
    if (!inScope) continue;
    resolved ??= await resolve(rel);
    if (resolved.directory) continue;
    const artifact = { full: path.join(root, ...rel.split('/')), rel, ...(kind ? { kind } : {}) };
    if (resolved.dangling) {
      artifacts.push({ ...artifact, skip: `a symlink to a file ${carrier} does not carry` });
      continue;
    }
    if (resolved.skip) {
      artifacts.push({ ...artifact, skip: resolved.skip });
      continue;
    }
    if (kind === 'skill') artifact.scripts = await treeSkillScripts(root, tree, keys, resolve, rel);
    artifacts.push(artifact);
    wanted.push([artifact, resolved.oid]);
  }
  const blobs = await readBlobs(root, wanted.map(([, oid]) => oid), { maxBytes: MAX_ARTIFACT_BYTES });
  for (const [artifact, oid] of wanted) artifact.read = blobs.get(oid);
  return artifacts;
}

function realRelative(realRoot, full) {
  let real;
  try {
    real = fs.realpathSync(full);
  } catch {
    return null;
  }
  const rel = path.relative(realRoot, real).split(path.sep).join('/');
  return rel && !rel.startsWith('../') && rel !== '..' && !path.isAbsolute(rel) ? rel : null;
}

function linkedScriptsOnDisk(skillDir) {
  const out = [];
  const stack = [[skillDir, '']];
  while (stack.length && out.length < MAX_LINKS_FOLLOWED) {
    const [dir, inner] = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const rel = inner ? `${inner}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (descendInto(inner ? `skills/${inner}` : 'skills', ent.name)) stack.push([path.join(dir, ent.name), rel]);
      } else if (ent.isSymbolicLink() && bundledPath(rel)) out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

export function touchedArtifacts(root, artifacts, changed) {
  const changedSet = new Set(changed);
  const folders = changedFolders(changed);
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
  }
  return artifacts.filter((artifact) => {
    if (changedSet.has(artifact.rel)) return true;
    const isSkill = artifact.kind === 'skill';
    if (isSkill && folders.has(path.posix.dirname(artifact.rel))) return true;
    const real = realRelative(realRoot, artifact.full);
    if (real && real !== artifact.rel && touchesChange([real], changedSet)) return true;
    if (!isSkill) return false;
    const realDir = realRelative(realRoot, path.dirname(artifact.full));
    if (realDir && folders.has(realDir)) return true;
    return linkedScriptsOnDisk(path.dirname(artifact.full)).some((link) => {
      const target = realRelative(realRoot, link);
      return !!target && touchesChange([target], changedSet);
    });
  });
}

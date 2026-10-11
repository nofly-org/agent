import fs from 'node:fs';
import path from 'node:path';

export class SettingsFileError extends Error {}

export function readJsonFile(file) {
  if (!fs.existsSync(file)) return {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new SettingsFileError(`${file} could not be read (${error.code ?? error.message}) - nothing was changed.`);
  }
  if (!raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    throw new SettingsFileError(`${file} is not valid JSON (comments and trailing commas are not supported here) - fix or move it first; nothing was changed.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SettingsFileError(`${file} does not hold a JSON object - fix or move it first; nothing was changed.`);
  }
  return parsed;
}

function realTarget(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function ownerOf(target) {
  let cur = target;
  for (let i = 0; i < 64; i++) {
    try {
      const st = fs.statSync(cur);
      return { uid: st.uid, gid: st.gid };
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
  return null;
}

function handOver(p, owner) {
  if (!owner) return;
  try {
    fs.chownSync(p, owner.uid, owner.gid);
  } catch {
  }
}

function makeDirs(dir, owner) {
  const first = fs.mkdirSync(dir, { recursive: true });
  if (!first || !owner) return;
  for (let cur = dir, i = 0; i < 64; i++) {
    handOver(cur, owner);
    const parent = path.dirname(cur);
    if (cur === first || parent === cur) return;
    cur = parent;
  }
}

export function writeFileAtomic(file, text) {
  const target = realTarget(file);
  const dir = path.dirname(target);
  const found = typeof process.getuid === 'function' && process.getuid() === 0 ? ownerOf(target) : null;
  const owner = found && found.uid !== 0 ? found : null;
  makeDirs(dir, owner);
  let mode;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    mode = undefined;
  }
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  } catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EPERM' && error.code !== 'EROFS') throw error;
    fs.writeFileSync(target, text);
    handOver(target, owner);
    return;
  }
  try {
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    handOver(tmp, owner);
    fs.renameSync(tmp, target);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export function writeJsonFile(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

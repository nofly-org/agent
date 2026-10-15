import fs from 'node:fs';
import path from 'node:path';
import { readFailure, readRegularText } from './safe-read.mjs';

const MAX_SETTINGS_BYTES = 256 * 1024 * 1024;

export class SettingsFileError extends Error {}

export function readJsonFile(file) {
  if (!fs.existsSync(file)) return {};
  let raw;
  try {
    raw = readRegularText(file, MAX_SETTINGS_BYTES);
  } catch (error) {
    throw new SettingsFileError(`${file} could not be read (${readFailure(error)}) - nothing was changed.`);
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

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function realOrNearest(p) {
  const tail = [];
  let cur = path.resolve(p);
  for (let i = 0; i < 256; i++) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return path.resolve(p);
}

const insideDir = (root, p) => {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

export function outsideProject(file, project = process.cwd()) {
  const lexical = path.resolve(file);
  const root = path.resolve(project);
  if (!insideDir(root, lexical)) return null;
  const realRoot = realOrNearest(root);
  const real = realOrNearest(lexical);
  return insideDir(realRoot, real) ? null : real;
}

export function writeFileAtomic(file, text) {
  const escaped = outsideProject(file);
  if (escaped) throw new SettingsFileError(`${file} leads through a symlink to ${escaped}, outside this project - nothing was changed. Remove the link, or run the command from the folder it points into.`);
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
    if (isLink(target)) throw error;
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

function jsonStyle(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { indent: 2, eol: '\n' };
  }
  const nested = /\n([ \t]+)\S/.exec(raw);
  const indent = !nested ? 2 : nested[1].startsWith('\t') ? '\t' : Math.min(nested[1].length, 8);
  return { indent, eol: raw.includes('\r\n') ? '\r\n' : '\n' };
}

export function writeJsonFile(file, value) {
  const { indent, eol } = jsonStyle(file);
  const text = `${JSON.stringify(value, null, indent)}\n`;
  writeFileAtomic(file, eol === '\n' ? text : text.replace(/\n/g, eol));
}

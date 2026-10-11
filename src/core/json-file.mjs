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

export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    mode = undefined;
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export function writeJsonFile(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

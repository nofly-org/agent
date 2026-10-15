import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LEGACY_NAME = 'shomra';

export function adoptLegacyEnv(env = process.env) {
  for (const key of Object.keys(env)) {
    if (!key.startsWith('SHOMRA_')) continue;
    const current = `NOFLY_${key.slice('SHOMRA_'.length)}`;
    if (env[current] === undefined) env[current] = env[key];
  }
  return env;
}

export function preferredPath(current, legacy) {
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}

export function stateDirs(home = os.homedir()) {
  return [path.join(home, '.nofly'), path.join(home, `.${LEGACY_NAME}`)];
}

export function stateDir(home = os.homedir()) {
  const [current, legacy] = stateDirs(home);
  return preferredPath(current, legacy);
}

export function withLegacyHeaders(headers) {
  for (const [key, value] of Object.entries(headers)) {
    const m = /^x-nofly-(.+)$/i.exec(key);
    if (!m || value === undefined) continue;
    const legacy = `x-${LEGACY_NAME}-${m[1].toLowerCase()}`;
    if (!Object.keys(headers).some((k) => k.toLowerCase() === legacy)) headers[legacy] = value;
  }
  return headers;
}

export function adoptLegacyHeaders(headers) {
  for (const key of Object.keys(headers)) {
    const m = /^x-shomra-(.+)$/i.exec(key);
    if (!m) continue;
    const current = `x-nofly-${m[1].toLowerCase()}`;
    if (headers[current] === undefined) headers[current] = headers[key];
    delete headers[key];
  }
  return headers;
}

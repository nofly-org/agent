import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.mjs';
import { clampInt } from './numbers.mjs';
import { readRegularText } from './safe-read.mjs';

const BREAKER_FILE = path.join(CONFIG_DIR, 'guard-breaker.json');

export function guardTimeoutMs() {
  return clampInt(process.env.NOFLY_GUARD_TIMEOUT_MS, 2000, 200, 30000);
}

export function breakerCooldownMs() {
  return clampInt(process.env.NOFLY_GUARD_BREAKER_MS, 30000, 0, 600000);
}

export function breakerWindowOpen(at, now, cooldown) {
  if (!(cooldown > 0) || typeof at !== 'number' || !Number.isFinite(at)) return false;
  const age = now - at;
  return age >= 0 && age < cooldown;
}

export function breakerThreshold() {
  return clampInt(process.env.NOFLY_GUARD_BREAKER_FAILURES, 3, 1, 20);
}

function readBreaker() {
  try {
    const state = JSON.parse(readRegularText(BREAKER_FILE));
    if (!state || typeof state !== 'object' || typeof state.at !== 'number') return null;
    return { at: state.at, failures: Number.isInteger(state.failures) && state.failures > 0 ? state.failures : 1 };
  } catch {
    return null;
  }
}

export function breakerOpen() {
  const cooldown = breakerCooldownMs();
  if (cooldown === 0) return false;
  const state = readBreaker();
  return !!state && state.failures >= breakerThreshold() && breakerWindowOpen(state.at, Date.now(), cooldown);
}

export function nextFailures(prev, now, cooldown, threshold) {
  if (!prev) return 1;
  const span = cooldown > 0 ? cooldown : 30000;
  if (breakerWindowOpen(prev.at, now, span)) return prev.failures + 1;
  if (prev.failures >= threshold && breakerWindowOpen(prev.at, now, span * 10)) return prev.failures + 1;
  return 1;
}

export function breakerTrip() {
  try {
    const now = Date.now();
    const failures = nextFailures(readBreaker(), now, breakerCooldownMs(), breakerThreshold());
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(BREAKER_FILE, JSON.stringify({ at: now, failures }), { mode: 0o600 });
  } catch {
  }
}

export function breakerReset() {
  try {
    fs.rmSync(BREAKER_FILE, { force: true });
  } catch {
  }
}

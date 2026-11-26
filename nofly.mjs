#!/usr/bin/env node
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { stateDir } from './src/core/state-dir.mjs';

if (process.platform === 'win32') v8.setFlagsFromString('--wasm-tiering-budget=2000000000');

if (typeof module.enableCompileCache === 'function') {
  try {
    const own = stateDir(os.homedir());
    fs.mkdirSync(own, { recursive: true, mode: 0o700 });
    module.enableCompileCache(path.join(own, 'compile-cache'));
  } catch {
  }
}

const { dim, red } = await import('./src/core/terminal.mjs');
const { main } = await import('./src/cli/main.mjs');

function reportFatal(cause) {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  console.error(red(`✗ ${error.message}`));
  if (process.env.NOFLY_DEBUG) console.error(dim(error.stack ?? ''));
  process.exit(1);
}

process.on('unhandledRejection', reportFatal);

main().catch(reportFatal);

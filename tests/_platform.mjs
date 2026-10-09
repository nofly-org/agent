import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAMES = ['Shomra.Backend', 'shomra.backend', 'Dragox.Backend'];

export function platformPath(...parts) {
  const roots = [process.env.SHOMRA_PLATFORM_DIR, ...NAMES.map((n) => path.join(here, '..', '..', n))].filter(Boolean);
  for (const root of roots) {
    const p = path.join(root, ...parts);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

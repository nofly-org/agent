import os from 'node:os';
import path from 'node:path';

export function stateDir(home = os.homedir()) {
  return path.join(home, '.nofly');
}

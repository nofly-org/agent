import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REWORDING_NOT_RUN, localAsGateResult } from '../src/gate/result.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'nofly.mjs');

test('an on-machine verdict says the reworded-instruction check did not run', () => {
  const res = localAsGateResult({ verdict: 'ALLOW', riskScore: 0, findings: [] }, 'SKILL.md', 'skill');
  assert.deepEqual(res.notAttempted, [REWORDING_NOT_RUN]);
});

test('nofly gate with no server says so in its JSON, and in words', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nofly-offline-notes-'));
  const file = path.join(home, 'SKILL.md');
  fs.writeFileSync(file, '---\nname: notes\ndescription: Keeps notes.\n---\nWrite a short summary of the meeting.\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' };
  for (const k of Object.keys(env)) if (k.startsWith('NOFLY_')) delete env[k];
  const json = spawnSync(process.execPath, [CLI, 'gate', file, '--json'], { env, cwd: home, encoding: 'utf8' });
  const out = JSON.parse(json.stdout);
  assert.equal(out.source, 'local');
  assert.equal(out.notAttempted?.[0]?.check, 'reworded-instructions');
  const text = spawnSync(process.execPath, [CLI, 'gate', file], { env, cwd: home, encoding: 'utf8' });
  assert.match(text.stdout, /Not checked:.*reworded/i);
});

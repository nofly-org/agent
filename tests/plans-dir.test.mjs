import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { configuredPlanDirs, planFilesField, plansDirectoryOf } from '../src/guard/plans-dir.mjs';

const home = path.resolve('/home/dev');
const cwd = path.resolve('/repo');
const files = (map) => (p) => {
  const k = path.resolve(p);
  if (k in map) return map[k];
  throw new Error('ENOENT');
};

test('plansDirectory is read from a settings document', () => {
  assert.equal(plansDirectoryOf('{"plansDirectory":"./docs/plans"}'), './docs/plans');
  assert.equal(plansDirectoryOf('{"plansDirectory":"  "}'), null);
  assert.equal(plansDirectoryOf('{"plansDirectory":3}'), null);
  assert.equal(plansDirectoryOf('not json'), null);
  assert.equal(plansDirectoryOf(null), null);
});

test('a relative directory resolves against the project, ~ against home, and duplicates fold', () => {
  const read = files({
    [path.join(home, '.claude', 'settings.json')]: '{"plansDirectory":"~/agent-plans"}',
    [path.join(cwd, '.claude', 'settings.json')]: '{"plansDirectory":"docs/plans"}',
    [path.join(cwd, '.claude', 'settings.local.json')]: '{"plansDirectory":"./docs/plans/"}',
  });
  assert.deepEqual(configuredPlanDirs(cwd, { home, read }), [path.join(home, 'agent-plans'), path.join(cwd, 'docs', 'plans')]);
});

test('only markdown written directly inside a configured plan directory is declared', () => {
  const read = files({ [path.join(cwd, '.claude', 'settings.json')]: '{"plansDirectory":"docs/plans"}' });
  const field = (file_path) => planFilesField('Write', { file_path, content: 'x' }, { cwd }, { home, read });
  assert.deepEqual(field('docs/plans/next.md'), { plan_files: ['docs/plans/next.md'] });
  const abs = path.join(cwd, 'docs', 'plans', 'next.md');
  assert.deepEqual(field(abs), { plan_files: [abs] });
  assert.deepEqual(field('docs/plans/archive/old.md'), {});
  assert.deepEqual(field('docs/plans/notes.txt'), {});
  assert.deepEqual(field('README.md'), {});
});

test('with no setting there is no field, and an unreadable settings file never throws', () => {
  const input = { file_path: 'docs/plans/a.md', content: 'x' };
  assert.deepEqual(planFilesField('Write', input, { cwd }, { home, read: files({}) }), {});
  assert.deepEqual(planFilesField('Write', input, { cwd }, { home, read: () => { throw new Error('EACCES'); } }), {});
  assert.deepEqual(planFilesField('Read', {}, { cwd }, { home, read: files({}) }), {});
});

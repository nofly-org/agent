import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifactKindFor } from '../src/guard/artifact-paths.mjs';
import { guardNeedsServer } from '../src/guard/classify.mjs';

const PLANS = [
  '/home/dev/.claude/plans/quiet-otter.md',
  '/home/dev/.gemini/tmp/shop-api/plans/plan.md',
  '/home/dev/.cursor/plans/checkout.plan.md',
  'repo/.cursor/plans/checkout.plan.md',
  'repo/.kiro/specs/auth/tasks.md',
];

test('a vendor plan or spec file is governed on the machine, so its write and its later read both reach the server', () => {
  for (const p of PLANS) {
    assert.ok(artifactKindFor(p), `${p} is an artifact`);
    assert.equal(guardNeedsServer('Write', { file_path: p, content: '# Plan\n1. Update the tests.\n' }, false), true, `a write of ${p} escalates`);
    assert.equal(guardNeedsServer('Read', { file_path: p }, false), true, `a read of ${p} escalates`);
  }
});

test('generic planning files at the repo root stay on the machine', () => {
  for (const p of ['TODO.md', 'PLAN.md', 'NOTES.md', 'docs/plans/roadmap.md', 'repo/.kiro/specs/auth/notes.md']) {
    assert.equal(artifactKindFor(p), null, `${p} is not an artifact`);
    assert.equal(guardNeedsServer('Read', { file_path: p }, false), false, `a read of ${p} stays local`);
  }
});

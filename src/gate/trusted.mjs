import path from 'node:path';
import { fileAtRevision } from '../core/git-changes.mjs';
import { relativeToBase } from './locations.mjs';
import { REPO_CONFIG_DIRS, REPO_IGNORE_FILES, REPO_POLICY_FILES } from './repo-policy.mjs';
import { NO_MARKS, marksIn } from './suppressions.mjs';

export const UNVERIFIED_MARK_NOTE = 'the base branch could not be read, so a nofly-ignore mark here could not be checked against it';

export function trustedConfig(root, scope) {
  if (!scope) return { ignore: '', baseline: null, policy: null, markTrust: () => NO_MARKS, markNote: UNVERIFIED_MARK_NOTE };
  const read = (rel) => fileAtRevision(root, scope.baseRev, rel, { fromTop: !!scope.fromTop });
  let policy = null;
  for (const dir of REPO_CONFIG_DIRS) {
    for (const file of REPO_POLICY_FILES) {
      const text = read(`${dir}/${file}`);
      if (text !== null) {
        policy = { text, file };
        break;
      }
    }
    if (policy) break;
  }
  const top = path.resolve(root);
  const marks = new Map();
  return {
    ignore: REPO_IGNORE_FILES.map((file) => read(file)).filter((text) => text !== null).join('\n'),
    baseline: REPO_CONFIG_DIRS.map((dir) => read(`${dir}/baseline.json`)).find((text) => text !== null) ?? null,
    policy,
    markTrust: (full) => {
      const rel = relativeToBase(path.resolve(full), top);
      if (!rel) return NO_MARKS;
      if (!marks.has(rel)) marks.set(rel, marksIn(read(rel)));
      return marks.get(rel);
    },
  };
}

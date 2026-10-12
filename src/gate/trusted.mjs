import path from 'node:path';
import { fileAtRevision } from '../core/git-changes.mjs';
import { relativeToBase } from './locations.mjs';
import { REPO_POLICY_FILES } from './repo-policy.mjs';
import { NO_MARKS, marksIn } from './suppressions.mjs';

export const UNVERIFIED_MARK_NOTE = 'the base branch could not be read, so a shomra-ignore mark here could not be checked against it';

export function trustedConfig(root, scope) {
  if (!scope) return { ignore: '', baseline: null, policy: null, markTrust: () => NO_MARKS, markNote: UNVERIFIED_MARK_NOTE };
  const read = (rel) => fileAtRevision(root, scope.baseRev, rel, { fromTop: !!scope.fromTop });
  let policy = null;
  for (const file of REPO_POLICY_FILES) {
    const text = read(`.shomra/${file}`);
    if (text !== null) {
      policy = { text, file };
      break;
    }
  }
  const top = path.resolve(root);
  const marks = new Map();
  return {
    ignore: read('.shomraignore') ?? '',
    baseline: read('.shomra/baseline.json'),
    policy,
    markTrust: (full) => {
      const rel = relativeToBase(path.resolve(full), top);
      if (!rel) return NO_MARKS;
      if (!marks.has(rel)) marks.set(rel, marksIn(read(rel)));
      return marks.get(rel);
    },
  };
}

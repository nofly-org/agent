import { boundedJson } from '../../core/wire-limits.mjs';
import { stripJsonComments } from './file-read.mjs';

export function canonicalHooks(text) {
  let doc;
  try {
    doc = JSON.parse(stripJsonComments(text));
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const hooks = doc.hooks;
  if (!hooks || typeof hooks !== 'object' || !Object.keys(hooks).length) return null;
  return boundedJson({ hooks }, 2);
}

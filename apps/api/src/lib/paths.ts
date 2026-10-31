import { resolve } from 'node:path';

/** True if `path` is `root` or inside it, compared by path segment (`/a/bc` is not under `/a/b`). */
export function isUnderRoot(path: string, root: string): boolean {
  const p = resolve(path);
  const r = resolve(root);
  return p === r || p.startsWith(r.endsWith('/') ? r : r + '/');
}

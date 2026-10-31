const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const KEY_VALUE = /\b(api[_-]?key|secret|token|password|passwd)\b(["']?\s*[:=]\s*["']?)([^\s"'\\]{8,})/gi;
const MASK = '[REDACTED]';

function redactString(s: string): string {
  let out = s;
  for (const re of PATTERNS) out = out.replace(re, MASK);
  return out.replace(KEY_VALUE, (_m, key: string, sep: string) => `${key}${sep}${MASK}`);
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
  }
  return value;
}

/** Returns a deep copy of `value` with known secret shapes replaced by `[REDACTED]`. */
export function redactSecrets<T>(value: T): T {
  return walk(value) as T;
}

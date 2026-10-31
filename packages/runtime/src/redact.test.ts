import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it('replaces secrets deeply without mutating input', () => {
    const input = {
      out: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 end',
      nested: ['AKIAABCDEFGHIJKLMNOP'],
      cfg: 'password=hunter2hunter2',
    };
    const copy = structuredClone(input);
    const out = redactSecrets(input);
    expect(out).toEqual({
      out: 'key [REDACTED] end',
      nested: ['[REDACTED]'],
      cfg: 'password=[REDACTED]',
    });
    expect(input).toEqual(copy);
  });

  it('covers the remaining patterns and leaves plain text alone', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(`a ghp_${'a'.repeat(36)} b`)).toBe('a [REDACTED] b');
    expect(redactSecrets('xoxb-1234567890-abc')).toBe('[REDACTED]');
    expect(redactSecrets(`x ${pem} y`)).toBe('x [REDACTED] y');
    expect(redactSecrets('API_KEY: "abcdefgh12"')).toBe('API_KEY: "[REDACTED]"');
    expect(redactSecrets({ n: 1, ok: 'hello world', b: true })).toEqual({ n: 1, ok: 'hello world', b: true });
  });

  it('redacts prefixed/suffixed key names (underscore-joined)', () => {
    expect(redactSecrets('GITHUB_TOKEN=ghx_abcdefgh1234')).toBe('GITHUB_TOKEN=[REDACTED]');
    expect(redactSecrets('AWS_SECRET_ACCESS_KEY: "abcdefghijklmnop"')).toBe('AWS_SECRET_ACCESS_KEY: "[REDACTED]"');
    expect(redactSecrets('client_secret=abcdefgh12345678')).toBe('client_secret=[REDACTED]');
    expect(redactSecrets('the password is strong enough')).toBe('the password is strong enough');
  });
});

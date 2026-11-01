import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { machineId } from './machine-id.js';

it('override wins over /etc/machine-id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mid-'));
  const etc = join(dir, 'etc');
  writeFileSync(etc, 'from-etc\n');
  expect(machineId(dir, etc)).toBe('from-etc');
  expect(machineId(dir, etc, 'forced')).toBe('forced');
});

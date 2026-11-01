import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function readTrimmed(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * This machine's identity: `/etc/machine-id` when readable, else a random id persisted at `<fallbackDir>/machine-id`
 * (0600). A non-empty `override` (OFFICE_MACHINE_ID) wins over both. The API and a worker on the same host compute the same value from `/etc/machine-id`.
 */
export function machineId(fallbackDir: string, etcFile = '/etc/machine-id', override?: string): string {
  if (override) return override;
  const system = readTrimmed(etcFile);
  if (system) return system;
  const file = join(fallbackDir, 'machine-id');
  const saved = readTrimmed(file);
  if (saved) return saved;
  const id = randomUUID();
  mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, id, { mode: 0o600 });
  chmodSync(file, 0o600);
  return id;
}

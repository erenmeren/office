import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import type { WorkerToApi } from '@office/shared';
import { Outbox } from '../src/outbox.js';

it('persists and reloads a result with mode 0600 and deletes it', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'office-outbox-')), 'outbox');
  try {
    const box = new Outbox(dir);
    const msg = {
      type: 'run.result',
      runId: 'r1',
      sessionId: 's1',
      result: { status: 'failed', error: 'x', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, numTurns: 0, durationMs: 0 } },
    } as WorkerToApi;
    await box.put('r1', msg);
    expect(statSync(join(dir, 'r1.json')).mode & 0o777).toBe(0o600);
    expect(await box.load()).toEqual(new Map([['r1', msg]]));
    await box.delete('r1');
    expect(existsSync(join(dir, 'r1.json'))).toBe(false);
    expect((await box.load()).size).toBe(0);
  } finally {
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});

it('skips a corrupt entry instead of throwing', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'office-outbox-')), 'outbox');
  try {
    const box = new Outbox(dir);
    const msg = { type: 'heartbeat', capacity: 1, activeRunIds: [] } as WorkerToApi;
    await box.put('ok', msg);
    writeFileSync(join(dir, 'bad.json'), '{');
    const skipped: string[] = [];
    expect(await box.load((f) => skipped.push(f))).toEqual(new Map([['ok', msg]]));
    expect(skipped).toEqual(['bad.json']);
  } finally {
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});

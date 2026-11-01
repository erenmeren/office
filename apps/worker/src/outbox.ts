import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WorkerToApiSchema, type WorkerToApi } from '@office/shared';

/** Run results not yet delivered, one file per run, so they survive a worker restart. */
export class Outbox {
  constructor(private dir: string) {}

  private file = (runId: string) => join(this.dir, `${runId}.json`);

  async put(runId: string, msg: WorkerToApi): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file(runId)}.${randomUUID()}.tmp`; // rename keeps a crash from leaving a half-written entry
    await writeFile(tmp, JSON.stringify(msg), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file(runId));
  }

  async delete(runId: string): Promise<void> {
    await rm(this.file(runId), { force: true });
  }

  /** Rename to `<name>.corrupt` so the warning does not repeat on every start; `.corrupt` is never loaded. */
  private async quarantine(name: string): Promise<void> {
    await rename(join(this.dir, name), join(this.dir, `${name}.corrupt`)).catch(() => {});
  }

  async load(onSkip: (file: string, err: unknown) => void = () => {}): Promise<Map<string, WorkerToApi>> {
    const out = new Map<string, WorkerToApi>();
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
      throw err;
    }
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        const parsed = WorkerToApiSchema.safeParse(JSON.parse(await readFile(join(this.dir, name), 'utf8')));
        if (parsed.success) out.set(name.slice(0, -5), parsed.data);
        else {
          onSkip(name, parsed.error);
          await this.quarantine(name);
        }
      } catch (err) {
        onSkip(name, err); // a corrupt entry must not stop the worker starting
        await this.quarantine(name);
      }
    }
    return out;
  }
}

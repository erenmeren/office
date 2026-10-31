import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const file = (home: string) => join(home, 'credentials.json');

export async function loadCredential(home: string): Promise<string | null> {
  try {
    const { credential } = JSON.parse(await readFile(file(home), 'utf8')) as { credential?: unknown };
    return typeof credential === 'string' ? credential : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveCredential(home: string, credential: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(file(home), JSON.stringify({ credential }), { mode: 0o600 });
  // writeFile's mode only applies on create; tighten a pre-existing file too
  await chmod(file(home), 0o600);
}

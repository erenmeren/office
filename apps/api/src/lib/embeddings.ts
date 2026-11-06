/** Local text embeddings; memory text never leaves the machine (the model itself is downloaded once). */
export type Embed = (text: string) => Promise<number[]>;

// multilingual: the owner searches in Turkish, agents mostly write English
const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const RETRY_MS = 10 * 60_000;

let embedder: Embed | null = null;
let failedAt = 0;

/** Off when `enabled` is false; `custom` replaces the model (tests). */
export function configureEmbeddings(o: { enabled: boolean; cacheDir: string; custom?: Embed }) {
  failedAt = 0;
  if (o.custom) embedder = o.custom;
  else if (!o.enabled) embedder = null;
  else {
    let pipe: Promise<Embed> | undefined;
    embedder = (text) => {
      pipe ??= (async () => {
        const { env, pipeline } = await import('@huggingface/transformers');
        env.cacheDir = o.cacheDir;
        const extract = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
        return async (t: string) => Array.from((await extract(t, { pooling: 'mean', normalize: true })).data as Float32Array);
      })().catch((err) => {
        pipe = undefined;
        throw err;
      });
      return pipe.then((embed) => embed(text));
    };
  }
}

export const embeddingsReady = () => !!embedder && Date.now() - failedAt >= RETRY_MS;

/** The unit vector of `text`, or null when embeddings are off or the model cannot load (search falls back to keywords). */
export async function embed(text: string, log?: { warn: (obj: object, msg: string) => void }): Promise<number[] | null> {
  if (!embedder || !embeddingsReady()) return null;
  try {
    return await embedder(text);
  } catch (err) {
    failedAt = Date.now();
    log?.warn({ err }, 'embedding failed; memory search uses keywords only for now');
    return null;
  }
}

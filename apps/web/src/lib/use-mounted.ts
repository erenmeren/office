import { useSyncExternalStore } from 'react';

const noop = () => () => {};
/** False during SSR and hydration. Suspense boundaries hydrate late, after queries may have resolved, so data-driven views render client-only. */
export const useMounted = () => useSyncExternalStore(noop, () => true, () => false);

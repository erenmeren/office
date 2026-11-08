import type { Effort } from '@office/shared';

/** Reasoning effort names as the owner reads them; the values are the same on Claude and Codex. */
export const EFFORT_LABEL: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
export const EFFORTS = Object.keys(EFFORT_LABEL) as Effort[];

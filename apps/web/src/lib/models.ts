import type { ModelOption } from './queries';

/** The models on offer, plus the one already chosen when the list no longer has it (an agent keeps its model). */
export const modelChoices = (offered: ModelOption[] | undefined, current: string): ModelOption[] =>
  !current || (offered ?? []).some((m) => m.value === current) ? (offered ?? []) : [{ value: current, label: current }, ...(offered ?? [])];

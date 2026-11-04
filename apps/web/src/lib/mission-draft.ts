'use client';

import { useSyncExternalStore } from 'react';

/** A request drafted elsewhere (a Claude session's transcript) for the Mission Control composer; kept for this tab only. */
const KEY = 'office.missionDraft';
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

export function saveMissionDraft(text: string) {
  sessionStorage.setItem(KEY, text);
  notify();
}

export function clearMissionDraft() {
  sessionStorage.removeItem(KEY);
  notify();
}

export function useMissionDraft(): string | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => sessionStorage.getItem(KEY),
    () => null,
  );
}

const DRAFT_MAX = 6000;
const TURN_MAX = 600;

/** The owner's words from a transcript as a mission request: the last turns, each trimmed, newest kept. No model call. */
export function draftFromTranscript(session: { title: string; sessionId: string; cwd: string }, turns: { role: 'user' | 'assistant'; text: string }[]): string {
  const lines: string[] = [];
  let size = 0;
  for (const t of [...turns].reverse()) {
    if (!t.text.trim()) continue;
    const line = `${t.role === 'user' ? 'Me' : 'Claude'}: ${t.text.trim().replace(/\s+/g, ' ').slice(0, TURN_MAX)}`;
    if (size + line.length > DRAFT_MAX) break;
    lines.unshift(line);
    size += line.length;
  }
  return [
    session.title || 'Continue this work',
    '',
    `Context: a Claude Code session in ${session.cwd} (${session.sessionId.slice(0, 8)}). Plan and carry out what is still open below; edit this request before sending.`,
    '',
    ...lines,
  ].join('\n');
}

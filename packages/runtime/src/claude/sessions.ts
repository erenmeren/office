import { deleteSession, getSessionMessages, listSessions, renameSession } from '@anthropic-ai/claude-agent-sdk';

/** The SDK's read-only session store access, re-exported so the worker needs no SDK dependency of its own. */
export const claudeSessionStore = { listSessions, getSessionMessages, renameSession, deleteSession };
export type ClaudeSessionStore = typeof claudeSessionStore;

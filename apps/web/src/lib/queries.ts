'use client';

import { useQuery } from '@tanstack/react-query';
import type { RunStatus, TaskStatus, WorkerStatus } from '@office/shared';
import { api } from './api';

export type Me = { setupRequired: true } | { id: string; email: string; setupRequired: false };
export interface Project {
  id: string;
  name: string;
  slug: string;
  repoPath: string;
}
export type SkillMode = 'eager' | 'on_demand';
export interface SubagentDef {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  skills: string[];
  maxTurns?: number;
}
export interface AgentVersionView {
  id: string;
  version: number;
  createdAt: string;
  config: {
    systemPrompt: string;
    model: string;
    effort?: string;
    allowedTools: string[];
    maxTurns: number;
    maxBudgetUsd: number;
    maxConcurrentSubagents: number;
    maxSubagentDepth: number;
  };
  skills: { skillId: string; skillVersionId: string; name: string; version: number; mode: SkillMode }[];
  subagents: SubagentDef[];
}
export interface Agent {
  id: string;
  name: string;
  slug: string;
  role: string;
  description: string;
  isActive: boolean;
  currentVersionId: string | null;
  currentVersion: AgentVersionView | null;
}
export interface SkillSnapshotEntry {
  skillId: string;
  skillVersionId: string;
  name: string;
  version: number;
  checksum: string;
  mode: SkillMode;
}
export interface SubagentRun {
  id: string;
  sessionId: string;
  toolUseId: string;
  subagentType: string;
  description: string | null;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  summary: string | null;
  startedAt: string;
  endedAt: string | null;
}
export interface Task {
  id: string;
  createdAt: string;
  projectId: string;
  agentId: string;
  title: string;
  description: string;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
}
export interface TaskRun {
  id: string;
  createdAt: string;
  status: RunStatus;
  workerId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  resultText: string | null;
  error: string | null;
  costUsd: number;
  session: { id: string; skillsSnapshot: SkillSnapshotEntry[] | null } | null;
}
export interface Worker {
  id: string;
  name: string;
  status: WorkerStatus;
  capacity: number;
  lastHeartbeatAt: string | null;
}

export const TERMINAL: TaskStatus[] = ['done', 'failed', 'cancelled'];

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), retry: false });
export const useProjects = () => useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/projects') });
export const useAgents = () => useQuery({ queryKey: ['agents'], queryFn: () => api<Agent[]>('/agents') });
export const useAgent = (id: string) =>
  useQuery({ queryKey: ['agent', id], queryFn: () => api<Agent & { versions: AgentVersionView[] }>(`/agents/${id}`) });
export const useTasks = () => useQuery({ queryKey: ['tasks'], queryFn: () => api<Task[]>('/tasks') });
export const useWorkers = () => useQuery({ queryKey: ['workers'], queryFn: () => api<Worker[]>('/workers') });
export const useTask = (id: string) =>
  useQuery({
    queryKey: ['task', id],
    queryFn: () => api<Task & { runs: TaskRun[] }>(`/tasks/${id}`),
    refetchInterval: (q) => (q.state.data && TERMINAL.includes(q.state.data.status) ? false : 3000),
  });

export type SkillStatus = 'pending_review' | 'approved' | 'rejected';
export interface SkillVersion {
  id: string;
  version: number;
  checksum: string;
  createdAt: string;
  files?: Record<string, string>;
}
export interface Skill {
  id: string;
  name: string;
  description: string;
  source: 'local' | 'git' | 'ui';
  sourceRef: string | null;
  status: SkillStatus;
  currentVersionId: string | null;
  createdAt: string;
  currentVersion: SkillVersion | null;
  versions?: SkillVersion[];
}
export const useSkills = () => useQuery({ queryKey: ['skills'], queryFn: () => api<Skill[]>('/skills') });
export const useSkill = (id: string) => useQuery({ queryKey: ['skill', id], queryFn: () => api<Skill>(`/skills/${id}`) });
export const useRunSubagents = (runId: string, active: boolean) =>
  useQuery({
    queryKey: ['run-subagents', runId],
    queryFn: () => api<SubagentRun[]>(`/runs/${runId}/subagents`),
    refetchInterval: active ? 3000 : false,
  });

'use client';

import { useQuery } from '@tanstack/react-query';
import type { ApprovalStatus, ApprovalView, MessageView, MissionStatus, Plan, ProjectSettings, RunStatus, TaskStatus, WorkerStatus } from '@office/shared';
import { api } from './api';

export type Me = { setupRequired: true } | { setupRequired: false; anonymous: true } | { id: string; email: string; setupRequired: false };
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
  missionId?: string | null;
  key?: string | null;
}
export interface ContextPack {
  entryIds: string[];
  summaryIds: string[];
  inboxCount: number;
  chars: number;
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
  kind?: string;
  session: { id: string; skillsSnapshot: SkillSnapshotEntry[] | null; contextPack?: ContextPack | null } | null;
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
export const useTasks = (refetchInterval?: number) =>
  useQuery({ queryKey: ['tasks'], queryFn: () => api<Task[]>('/tasks'), refetchInterval });
export const useWorkers = () => useQuery({ queryKey: ['workers'], queryFn: () => api<Worker[]>('/workers') });
export interface CheckResult {
  status: 'passed' | 'failed' | 'timeout' | 'skipped';
  exitCode: number | null;
  command: string;
  artifactId: string | null;
}
/** Mission-era fields of a task; plain Phase 1–3 tasks carry empty values. */
export interface TaskPlanFields {
  key: string | null;
  kind: string;
  requirements: string[];
  acceptanceCriteria: string[];
  reviewNote: string | null;
  budgetUsd: number | null;
  checkResult: CheckResult | null;
  dependencies: string[];
  dependents: string[];
}
export type TaskDetailView = Task &
  TaskPlanFields & {
    runs: TaskRun[];
    mission: { id: string; title: string; status: MissionStatus; branch: string | null } | null;
    git: { runId: string; branch: string | null; baseCommit: string | null; headCommit: string; integration: 'none' | 'fast_forwarded' | 'needs_integration' } | null;
  };
export const useTask = (id: string) =>
  useQuery({
    queryKey: ['task', id],
    queryFn: () => api<TaskDetailView>(`/tasks/${id}`),
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

export type { MessageView };
export type ConversationKind = 'direct' | 'group' | 'task' | 'human';
export interface Conversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  projectId: string;
  kind: ConversationKind;
  title: string;
  taskId: string | null;
  agentIds: string[];
  includesOwner: boolean;
  sdkSessionId: string | null;
  lastMessage: MessageView | null;
  unreadForOwner: number;
  activeRun: { id: string; status: RunStatus } | null;
}
export const useConversations = (projectId: string | undefined, kind?: ConversationKind) =>
  useQuery({
    queryKey: ['conversations', projectId, kind ?? 'all'],
    queryFn: () => api<Conversation[]>(`/conversations?projectId=${projectId}${kind ? `&kind=${kind}` : ''}`),
    enabled: !!projectId,
  });
export const useConversation = (id: string | undefined) =>
  useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api<Conversation & { messages: MessageView[] }>(`/conversations/${id}`),
    enabled: !!id,
  });
export const useMessageSearch = (projectId: string | undefined, q: string) =>
  useQuery({
    queryKey: ['message-search', projectId, q],
    queryFn: () => api<MessageView[]>(`/messages/search?projectId=${projectId}&q=${encodeURIComponent(q)}`),
    enabled: !!projectId && q.trim().length > 1,
  });

export interface MemoryEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
  projectId: string | null;
  agentId: string | null;
  scope: 'project' | 'agent_project' | 'agent';
  type: 'decision' | 'convention' | 'api_contract' | 'known_issue' | 'lesson' | 'task_summary';
  title: string;
  content: string;
  authorType: 'agent' | 'user' | 'system';
  authorAgentId: string | null;
  status: 'proposed' | 'verified' | 'rejected';
  version: number;
  supersededById: string | null;
  taskId: string | null;
  runId: string | null;
  verifiedAt: string | null;
  sources: { id: string; kind: 'event' | 'message' | 'commit' | 'file' | 'run' | 'task'; ref: string; label: string | null }[];
  supersedes: { id: string; version: number } | null;
}
export type MemoryEntryDetail = MemoryEntry & {
  revisions: { id: string; version: number; title: string; createdAt: string; status: MemoryEntry['status']; authorType: MemoryEntry['authorType'] }[];
};
/** The `type` pill is applied client-side (Knowledge spans two types), so only q and status go to the API. */
export const useMemory = (projectId: string | undefined, f: { q?: string; status?: MemoryEntry['status'] } = {}) =>
  useQuery({
    queryKey: ['memory', 'list', projectId, f.q ?? '', f.status ?? ''],
    queryFn: () => {
      const qs = new URLSearchParams({ projectId: projectId! });
      if (f.q?.trim()) qs.set('q', f.q.trim());
      if (f.status) qs.set('status', f.status);
      return api<MemoryEntry[]>(`/memory?${qs}`);
    },
    enabled: !!projectId,
  });
export const useMemoryEntry = (id: string | undefined, projectId: string | undefined) =>
  useQuery({
    queryKey: ['memory', 'entry', id],
    queryFn: () => api<MemoryEntryDetail>(`/memory/${id}?projectId=${projectId}`),
    enabled: !!id && !!projectId,
  });
export const useMemoryCounts = (projectId: string | undefined) =>
  useQuery({
    queryKey: ['memory', 'counts', projectId],
    queryFn: () => api<{ proposed: number }>(`/memory/counts?projectId=${projectId}`),
    enabled: !!projectId,
  });

export type { ApprovalView, MissionStatus, Plan };
export interface MissionSummary {
  id: string;
  createdAt: string;
  title: string;
  status: MissionStatus;
  taskCounts: Record<string, number>;
}
export interface Mission extends Omit<MissionSummary, 'taskCounts'> {
  updatedAt: string;
  request: string;
  branch: string | null;
  plan: Plan | null;
  planVersion: number;
  planErrors: string[];
  summary: string | null;
  budgetUsd: number | null;
  tasks: (Task & TaskPlanFields)[];
  approvals: ApprovalView[];
  planRun: { id: string; status: RunStatus; costUsd: number; error: string | null } | null;
}
export const useMissions = (projectId: string | undefined) =>
  useQuery({ queryKey: ['missions', projectId], queryFn: () => api<MissionSummary[]>(`/missions?projectId=${projectId}`), enabled: !!projectId });
export const useMission = (id: string | undefined) =>
  useQuery({ queryKey: ['missions', 'detail', id], queryFn: () => api<Mission>(`/missions/${id}`), enabled: !!id, refetchInterval: 5000 });
export const useApprovals = (projectId: string | undefined, status?: ApprovalStatus) =>
  useQuery({
    queryKey: ['approvals', projectId, status ?? 'all'],
    queryFn: () => api<ApprovalView[]>(`/approvals?projectId=${projectId}${status ? `&status=${status}` : ''}`),
    enabled: !!projectId,
  });
export const useBudget = (projectId: string | undefined) =>
  useQuery({
    queryKey: ['budget', projectId],
    queryFn: () => api<{ spentTodayUsd: number; dailyBudgetUsd: number }>(`/projects/${projectId}/budget`),
    enabled: !!projectId,
    refetchInterval: 30_000,
  });
export const useProjectSettings = (projectId: string | undefined) =>
  useQuery({ queryKey: ['settings', projectId], queryFn: () => api<ProjectSettings>(`/projects/${projectId}/settings`), enabled: !!projectId });
export const useArtifact = (id: string | undefined) =>
  useQuery({ queryKey: ['artifact', id], queryFn: () => api<{ id: string; name: string; content: string }>(`/artifacts/${id}`), enabled: !!id });

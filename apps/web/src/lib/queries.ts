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
export interface Agent {
  id: string;
  name: string;
  slug: string;
  role: string;
  currentVersion: { version: number; config: { model: string } } | null;
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
  session: { id: string } | null;
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
export const useTasks = () => useQuery({ queryKey: ['tasks'], queryFn: () => api<Task[]>('/tasks') });
export const useWorkers = () => useQuery({ queryKey: ['workers'], queryFn: () => api<Worker[]>('/workers') });
export const useTask = (id: string) =>
  useQuery({
    queryKey: ['task', id],
    queryFn: () => api<Task & { runs: TaskRun[] }>(`/tasks/${id}`),
    refetchInterval: (q) => (q.state.data && TERMINAL.includes(q.state.data.status) ? false : 3000),
  });

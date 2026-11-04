'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import type { ProjectSettings } from '@office/shared';
import { ApprovalPolicyTable } from '@/components/approval-policy-table';
import { AgentAvatar } from '@/components/ui/agent-avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { PageActions, PageDescription, PageHeader, PageTitle } from '@/components/ui/page-header';
import { put } from '@/lib/api';
import { useAgents, useBudget, useRuntimeSettings } from '@/lib/queries';
import { changedKeys, commaToList, validateSettingsDraft } from '@/lib/settings';

const usd = (n: number) => `$${n.toFixed(2)}`;

export function SettingsForm({ projectId, settings, agentIds }: { projectId: string; settings: ProjectSettings; agentIds: string[] }) {
  const qc = useQueryClient();
  const agents = useAgents().data ?? [];
  const runtime = useRuntimeSettings().data;
  const budget = useBudget(projectId).data;
  const [original, setOriginal] = useState(settings);
  const [draft, setDraft] = useState(settings);
  const [originalIds, setOriginalIds] = useState(agentIds);
  const [ids, setIds] = useState(agentIds);
  const [resetKey, setResetKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [problems, setProblems] = useState<{ field: string; message: string }[]>([]);
  const numKeys = ['maxConcurrentRuns', 'defaultMaxAttempts', 'dailyBudgetUsd', 'defaultTaskBudgetUsd', 'approvalTimeoutMinutes', 'checkTimeoutSeconds'] as const;
  type NumKey = (typeof numKeys)[number];
  // raw text while typing, so a cleared field stays empty instead of turning into 0
  const rawOf = (s: ProjectSettings) => Object.fromEntries(numKeys.map((k) => [k, String(s[k])])) as Record<NumKey, string>;
  const [raw, setRaw] = useState(() => rawOf(settings));
  const [tagsText, setTagsText] = useState(settings.requiredWorkerTags.join(', '));
  const [domainsText, setDomainsText] = useState(settings.networkAllowedDomains.join(', '));
  const problem = (field: string) => problems.find((p) => p.field === field)?.message;

  const keys = changedKeys(original, draft);
  const idsChanged = [...ids].sort().join() !== [...originalIds].sort().join();
  const dirty = keys.length > 0 || idsChanged;
  const set = <K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]) => {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const text = (key: 'setupCommand' | 'checkCommand' | 'lintCommand' | 'envFile' | 'committerName' | 'committerEmail') => ({
    id: key,
    value: draft[key] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
  });
  const num = (key: NumKey) => ({
    id: key,
    type: 'number' as const,
    min: 1,
    value: raw[key],
    'aria-invalid': !!problem(key) || undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      setRaw((r) => ({ ...r, [key]: e.target.value }));
      set(key, e.target.value.trim() === '' ? NaN : Number(e.target.value));
    },
  });

  const discard = () => {
    setDraft(original);
    setIds(originalIds);
    setResetKey((k) => k + 1);
    setRaw(rawOf(original));
    setTagsText(original.requiredWorkerTags.join(', '));
    setDomainsText(original.networkAllowedDomains.join(', '));
    setProblems([]);
    setError(undefined);
    setSaved(false);
  };

  const save = async () => {
    const found = validateSettingsDraft(draft);
    setProblems(found);
    if (found.length) return;
    setSaving(true);
    setError(undefined);
    try {
      if (keys.length) await put(`/projects/${projectId}/settings`, Object.fromEntries(keys.map((k) => [k, draft[k]])));
      if (idsChanged) await put(`/projects/${projectId}/agents`, { agentIds: ids });
      setOriginal(draft);
      setOriginalIds(ids);
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
      await Promise.all(['settings', 'project-agents', 'budget'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader>
        <div>
          <PageTitle>Settings</PageTitle>
          <PageDescription>Limits, budgets and approvals are enforced by the control plane, whatever an agent&apos;s prompt says.</PageDescription>
        </div>
        <PageActions className="items-center">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {saved && (
            <p role="status" className="text-sm text-ink-2">
              Saved.
            </p>
          )}
          <Button variant="secondary" size="lg" disabled={!dirty || saving} onClick={discard}>
            Discard
          </Button>
          <Button size="lg" disabled={!dirty || saving} onClick={() => void save()}>
            Save changes
          </Button>
        </PageActions>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Approval policies</CardTitle>
        </CardHeader>
        <CardContent>
          <ApprovalPolicyTable key={resetKey} policy={draft.approvalPolicy} onChange={(p) => set('approvalPolicy', p)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Execution limits</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Concurrent sessions per project" htmlFor="maxConcurrentRuns" error={problem('maxConcurrentRuns')}>
            <Input {...num('maxConcurrentRuns')} />
          </Field>
          <Field label="Task retries" htmlFor="defaultMaxAttempts" error={problem('defaultMaxAttempts')}>
            <Input {...num('defaultMaxAttempts')} />
          </Field>
          <Field label="Worker lease (seconds)" htmlFor="leaseSeconds">
            <Input id="leaseSeconds" readOnly value={runtime?.leaseSeconds ?? ''} />
          </Field>
          <Field label="Heartbeat interval (seconds)" htmlFor="heartbeatSeconds">
            <Input id="heartbeatSeconds" readOnly value={runtime?.heartbeatSeconds ?? ''} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Budgets</CardTitle>
          <CardDescription>The SDK budget is a soft limit inside a session. The scheduler checks spend before each start and stops runs that pass the hard cap.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Daily budget (USD)" htmlFor="dailyBudgetUsd" error={problem('dailyBudgetUsd')} hint={budget ? `Today ${usd(budget.spentTodayUsd)} of ${usd(budget.dailyBudgetUsd)}` : undefined}>
            <Input {...num('dailyBudgetUsd')} step="0.01" />
          </Field>
          <Field label="Default per task (USD)" htmlFor="defaultTaskBudgetUsd" error={problem('defaultTaskBudgetUsd')}>
            <Input {...num('defaultTaskBudgetUsd')} step="0.01" />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Execution settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Package manager" htmlFor="packageManager">
              <NativeSelect id="packageManager" value={draft.packageManager ?? ''} onChange={(e) => set('packageManager', (e.target.value || undefined) as ProjectSettings['packageManager'])}>
                <option value="" disabled={!!original.packageManager}>
                  Not set
                </option>
                {['npm', 'pnpm', 'yarn', 'bun'].map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Env file" htmlFor="envFile">
              <Input {...text('envFile')} />
            </Field>
            <Field label="Setup command" htmlFor="setupCommand">
              <Input {...text('setupCommand')} className="font-mono" />
            </Field>
            <Field label="Check command" htmlFor="checkCommand">
              <Input {...text('checkCommand')} className="font-mono" />
            </Field>
            <Field label="Lint command" htmlFor="lintCommand">
              <Input {...text('lintCommand')} className="font-mono" />
            </Field>
            <Field label="Approval timeout (minutes)" htmlFor="approvalTimeoutMinutes" error={problem('approvalTimeoutMinutes')}>
              <Input {...num('approvalTimeoutMinutes')} />
            </Field>
            <Field label="Check timeout (seconds)" htmlFor="checkTimeoutSeconds" error={problem('checkTimeoutSeconds')}>
              <Input {...num('checkTimeoutSeconds')} />
            </Field>
            <Field label="Required worker tags" htmlFor="requiredWorkerTags" hint="Comma-separated. Only workers with all of these tags run this project." error={problem('requiredWorkerTags')}>
              <Input
                id="requiredWorkerTags"
                value={tagsText}
                aria-invalid={!!problem('requiredWorkerTags') || undefined}
                onChange={(e) => {
                  setTagsText(e.target.value);
                  set('requiredWorkerTags', commaToList(e.target.value));
                }}
              />
            </Field>
            <Field
              label="Network access"
              htmlFor="networkAccess"
              hint="Open: mission-run commands reach any host and are not sandboxed. Allowlist: commands run in the sandbox and reach only the domains below."
            >
              <NativeSelect id="networkAccess" value={draft.networkAccess} onChange={(e) => set('networkAccess', e.target.value as ProjectSettings['networkAccess'])}>
                <option value="open">Open (default)</option>
                <option value="allowlist">Allowlist</option>
              </NativeSelect>
            </Field>
            <Field
              label="Network allowed domains"
              htmlFor="networkAllowedDomains"
              hint="Allowlist mode only. Comma-separated, e.g. example.com, *.example.com. Empty: no outbound network."
              error={problem('networkAllowedDomains')}
            >
              <Input
                id="networkAllowedDomains"
                value={domainsText}
                aria-invalid={!!problem('networkAllowedDomains') || undefined}
                onChange={(e) => {
                  setDomainsText(e.target.value);
                  set('networkAllowedDomains', commaToList(e.target.value));
                }}
              />
            </Field>
            <Field label="Committer name" htmlFor="committerName">
              <Input {...text('committerName')} />
            </Field>
            <Field label="Committer email" htmlFor="committerEmail">
              <Input {...text('committerEmail')} type="email" />
            </Field>
          </div>
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-sm font-medium">Env template</legend>
            {draft.envTemplate.map((row, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  aria-label={`Env name ${i + 1}`}
                  placeholder="NAME"
                  className="font-mono"
                  value={row.name}
                  onChange={(e) => set('envTemplate', draft.envTemplate.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
                />
                <Input
                  aria-label={`Env value ${i + 1}`}
                  placeholder="value"
                  className="font-mono"
                  value={row.value}
                  onChange={(e) => set('envTemplate', draft.envTemplate.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                />
                <Button variant="ghost" size="icon" aria-label={`Remove env row ${i + 1}`} onClick={() => set('envTemplate', draft.envTemplate.filter((_, j) => j !== i))}>
                  <X aria-hidden />
                </Button>
              </div>
            ))}
            {problems.filter((p) => p.field.startsWith('envTemplate.')).map((p) => (
              <p key={p.field} role="alert" className="text-xs text-destructive">
                {p.message}
              </p>
            ))}
            <Button variant="secondary" size="sm" onClick={() => set('envTemplate', [...draft.envTemplate, { name: '', value: '' }])}>
              <Plus data-icon="inline-start" aria-hidden />
              Add variable
            </Button>
          </fieldset>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Project agents</CardTitle>
          <CardDescription>No agents selected means every active agent may work on this project.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2">
          {agents.map((a) => (
            <label key={a.id} className="flex items-center gap-2.5 text-sm">
              <Checkbox
                checked={ids.includes(a.id)}
                onChange={(e) => {
                  setSaved(false);
                  setIds((cur) => (e.target.checked ? [...cur, a.id] : cur.filter((x) => x !== a.id)));
                }}
              />
              <AgentAvatar name={a.name} identity={a.slug} />
              {a.name}
            </label>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

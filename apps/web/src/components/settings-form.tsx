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
import { EFFORTS, EFFORT_LABEL } from '@/lib/effort';
import { useAgents, useBudget, useRuntimeSettings } from '@/lib/queries';
import { changedKeys, codexBlockedBy, commaToList, validateSettingsDraft } from '@/lib/settings';

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
  const numKeys = ['maxConcurrentRuns', 'defaultMaxAttempts', 'dailyBudgetUsd', 'defaultTaskBudgetUsd', 'defaultMissionBudgetUsd', 'approvalTimeoutMinutes', 'checkTimeoutSeconds'] as const;
  type NumKey = (typeof numKeys)[number];
  // raw text while typing, so a cleared field stays empty instead of turning into 0
  const rawOf = (s: ProjectSettings) => Object.fromEntries(numKeys.map((k) => [k, String(s[k])])) as Record<NumKey, string>;
  const [raw, setRaw] = useState(() => rawOf(settings));
  const [tagsText, setTagsText] = useState(settings.requiredWorkerTags.join(', '));
  const [domainsText, setDomainsText] = useState(settings.networkAllowedDomains.join(', '));
  const problem = (field: string) => problems.find((p) => p.field === field)?.message;

  const teamCodex = agents.some((a) => (ids.length === 0 ? a.isActive : ids.includes(a.id)) && a.currentVersion?.config.runtime === 'codex');
  const codexBlocked = codexBlockedBy(draft, teamCodex);
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
          <Field label="Cap per task run (USD, 0 = no cap)" htmlFor="defaultTaskBudgetUsd" error={problem('defaultTaskBudgetUsd')}>
            <Input {...num('defaultTaskBudgetUsd')} min={0} step="0.01" />
          </Field>
          <Field label="Default per mission (USD)" htmlFor="defaultMissionBudgetUsd" error={problem('defaultMissionBudgetUsd')} hint="Hard cap of a new mission; raise it per mission in Mission Control.">
            <Input {...num('defaultMissionBudgetUsd')} step="1" />
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
          <CardTitle>Model routing</CardTitle>
          <CardDescription>
            For each task run the first matching rule picks the runtime, model and effort; no match keeps the agent&apos;s own. A rule for Codex falls back to the
            agent&apos;s runtime while no online worker runs Codex. Every run records which rule chose it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {codexBlocked && (
            <p role="alert" className="text-sm text-destructive">
              Codex runs will be refused here: the {codexBlocked} approval policy is not auto, and Codex has no per-command gate to enforce it.
            </p>
          )}
          {draft.routing.map((rule, i) => {
            const setRule = (patch: Partial<typeof rule>) => set('routing', draft.routing.map((r, j) => (j === i ? { ...r, ...patch } : r)));
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="w-6 font-mono text-xs text-ink-3">{i + 1}</span>
                <NativeSelect
                  aria-label={`Rule ${i + 1} task kind`}
                  value={rule.taskKind ?? ''}
                  onChange={(e) => setRule({ taskKind: (e.target.value || undefined) as typeof rule.taskKind })}
                >
                  <option value="">Any kind</option>
                  {(['code', 'analysis', 'review', 'verify'] as const).map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </NativeSelect>
                <Input
                  aria-label={`Rule ${i + 1} minimum priority`}
                  type="number"
                  placeholder="Any priority"
                  className="w-32"
                  value={rule.minPriority ?? ''}
                  onChange={(e) => setRule({ minPriority: e.target.value.trim() === '' ? undefined : Number(e.target.value) })}
                />
                <NativeSelect aria-label={`Rule ${i + 1} runtime`} value={rule.runtime} onChange={(e) => setRule({ runtime: e.target.value === 'codex' ? 'codex' : 'claude' })}>
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </NativeSelect>
                <NativeSelect
                  aria-label={`Rule ${i + 1} effort`}
                  value={rule.effort ?? ''}
                  onChange={(e) => setRule({ effort: (e.target.value || undefined) as typeof rule.effort })}
                >
                  <option value="">Agent&apos;s effort</option>
                  {EFFORTS.map((x) => (
                    <option key={x} value={x}>
                      {EFFORT_LABEL[x]}
                    </option>
                  ))}
                </NativeSelect>
                <Input
                  aria-label={`Rule ${i + 1} model`}
                  placeholder="Runtime default"
                  className="w-44 font-mono"
                  value={rule.model ?? ''}
                  onChange={(e) => setRule({ model: e.target.value.trim() || undefined })}
                />
                <Button variant="ghost" size="icon" aria-label={`Remove rule ${i + 1}`} onClick={() => set('routing', draft.routing.filter((_, j) => j !== i))}>
                  <X aria-hidden />
                </Button>
              </div>
            );
          })}
          <Button variant="secondary" size="sm" onClick={() => set('routing', [...draft.routing, { runtime: 'claude' }])}>
            <Plus data-icon="inline-start" aria-hidden />
            Add rule
          </Button>
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

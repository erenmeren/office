'use client';

import { EFFORTS, EFFORT_LABEL } from '@/lib/effort';
import { useState, type FormEvent } from 'react';
import { ALWAYS_ON_TOOLS, type AgentConfigInput } from '@office/shared';
import { ModelItems } from '@/components/model-items';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ToolPicker } from '@/components/ui/tool-picker';
import { useSkill, useSkills, type AgentVersionView, type SkillMode } from '@/lib/queries';

const CHECK = 'size-4 accent-primary';

export interface AgentFormBody {
  name: string;
  slug?: string;
  role: string;
  description: string;
  isActive?: boolean;
  config: AgentConfigInput;
}
export interface AgentFormInitial {
  name: string;
  slug: string;
  role: string;
  description: string;
  isActive: boolean;
  version: AgentVersionView;
}

// versionId '' means "latest": the API then pins the skill's current version
type Pin = { mode: SkillMode; versionId: string };
type SubagentDraft = { name: string; description: string; prompt: string; model: string; tools: string[]; skills: string[]; maxTurns?: number };

const NEW_SUBAGENT: SubagentDraft = { name: '', description: '', prompt: '', model: '', tools: [...ALWAYS_ON_TOOLS], skills: [] };
const isAlwaysOn = (t: string) => (ALWAYS_ON_TOOLS as readonly string[]).includes(t);

function VersionSelect({ skillId, value, onChange }: { skillId: string; value: string; onChange: (v: string) => void }) {
  const skill = useSkill(skillId);
  const latest = skill.data?.currentVersion?.version;
  // '' (latest) is not a valid Select value; 'latest' stands in for it
  return (
    <Select value={value || 'latest'} onValueChange={(v) => onChange(v === 'latest' ? '' : String(v))}>
      <SelectTrigger size="sm" aria-label="Skill version">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="latest">latest{latest !== undefined ? ` (v${latest})` : ''}</SelectItem>
        {skill.data?.versions?.map((v) => (
          <SelectItem key={v.id} value={v.id}>
            v{v.version}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AgentForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial?: AgentFormInitial;
  submitLabel: string;
  onSubmit: (body: AgentFormBody) => Promise<void>;
}) {
  const skills = useSkills();
  const cfg = initial?.version.config;
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    slug: initial?.slug ?? '',
    role: initial?.role ?? '',
    description: initial?.description ?? '',
    systemPrompt: cfg?.systemPrompt ?? '',
    model: cfg?.model ?? 'sonnet',
    runtime: cfg?.runtime ?? 'claude',
    effort: cfg?.effort ?? 'unset',
    tools: cfg?.allowedTools.filter((t) => !isAlwaysOn(t)) ?? ['Bash', 'Edit', 'Write'],
    maxTurns: String(cfg?.maxTurns ?? 50),
    maxBudgetUsd: String(cfg?.maxBudgetUsd ?? 0),
    maxConcurrentSubagents: String(cfg?.maxConcurrentSubagents ?? 4),
    maxSubagentDepth: String(cfg?.maxSubagentDepth ?? 1),
  });
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [pins, setPins] = useState<Record<string, Pin>>(() =>
    Object.fromEntries((initial?.version.skills ?? []).map((s) => [s.skillId, { mode: s.mode, versionId: s.skillVersionId }])),
  );
  const [subagents, setSubagents] = useState<SubagentDraft[]>(() =>
    (initial?.version.subagents ?? []).map((s) => ({
      name: s.name,
      description: s.description,
      prompt: s.prompt,
      model: s.model ?? '',
      tools: s.tools ?? [],
      skills: s.skills,
      maxTurns: s.maxTurns,
    })),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const approved = skills.data?.filter((s) => s.status === 'approved') ?? [];
  const pinnedNames = approved.filter((s) => pins[s.id]).map((s) => s.name);

  const togglePin = (id: string, on: boolean) =>
    setPins((p) => {
      const next = { ...p };
      if (on) next[id] = { mode: 'on_demand', versionId: '' };
      else delete next[id];
      return next;
    });
  const setPin = (id: string, patch: Partial<Pin>) => setPins((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  const setSub = (i: number, patch: Partial<SubagentDraft>) =>
    setSubagents((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    const config: AgentConfigInput = {
      systemPrompt: form.systemPrompt,
      model: form.model,
      runtime: form.runtime,
      ...(form.effort !== 'unset' && { effort: form.effort as (typeof EFFORTS)[number] }),
      allowedTools: [...ALWAYS_ON_TOOLS, ...form.tools],
      maxTurns: Number(form.maxTurns),
      maxBudgetUsd: Number(form.maxBudgetUsd),
      maxConcurrentSubagents: Number(form.maxConcurrentSubagents),
      maxSubagentDepth: Number(form.maxSubagentDepth),
      skills: approved
        .filter((s) => pins[s.id])
        .map((s) => {
          const { mode, versionId } = pins[s.id];
          // send a version only when it differs from latest
          return versionId && versionId !== s.currentVersion?.id ? { skillId: s.id, skillVersionId: versionId, mode } : { skillId: s.id, mode };
        }),
      subagents: subagents.map((s) => {
        const tools = s.tools;
        return {
          name: s.name,
          description: s.description,
          prompt: s.prompt,
          ...(tools.length > 0 && { tools }),
          ...(s.model && { model: s.model }),
          skills: s.skills.filter((n) => pinnedNames.includes(n)),
          ...(s.maxTurns !== undefined && { maxTurns: s.maxTurns }),
        };
      }),
    };
    try {
      await onSubmit({
        name: form.name,
        ...(!initial && { slug: form.slug }),
        role: form.role,
        description: form.description,
        ...(initial && { isActive }),
        config,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      {(initial ? (['name', 'role'] as const) : (['name', 'slug', 'role'] as const)).map((k) => (
        <div key={k} className="space-y-1">
          <Label htmlFor={k} className="capitalize">
            {k}
          </Label>
          <Input id={k} required value={form[k]} onChange={set(k)} />
        </div>
      ))}
      <div className="space-y-1">
        <Label htmlFor="description">Description</Label>
        <Input id="description" value={form.description} onChange={set('description')} />
      </div>
      {initial && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className={CHECK} checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Active
        </label>
      )}
      <div className="space-y-1">
        <Label htmlFor="systemPrompt">System prompt</Label>
        <Textarea id="systemPrompt" rows={5} value={form.systemPrompt} onChange={set('systemPrompt')} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label>Runtime</Label>
          <Select
            items={[
              { value: 'claude', label: 'Claude' },
              { value: 'codex', label: 'Codex' },
            ]}
            value={form.runtime}
            onValueChange={(v) => {
              const runtime = v === 'codex' ? 'codex' : 'claude';
              // Claude aliases mean nothing to Codex: empty is the Codex CLI's own default model
              setForm({ ...form, runtime, model: runtime === 'codex' ? '' : 'sonnet' });
            }}
          >
            <SelectTrigger className="w-full" aria-label="Runtime">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="claude">Claude</SelectItem>
              <SelectItem value="codex">Codex</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="model">Model</Label>
          {form.runtime === 'codex' ? (
            <Input id="model" value={form.model} onChange={set('model')} placeholder="Codex default" />
          ) : (
            <Select value={form.model} onValueChange={(v) => setForm({ ...form, model: String(v) })}>
              <SelectTrigger className="w-full" aria-label="Model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <ModelItems current={form.model} />
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="space-y-1">
          <Label>Effort</Label>
          <Select
            items={[{ value: 'unset', label: 'Runtime default' }, ...EFFORTS.map((m) => ({ value: m, label: EFFORT_LABEL[m] }))]}
            value={form.effort}
            onValueChange={(v) => setForm({ ...form, effort: String(v) })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unset">Runtime default</SelectItem>
              {EFFORTS.map((m) => (
                <SelectItem key={m} value={m}>
                  {EFFORT_LABEL[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {form.runtime === 'codex' ? (
        <p className="text-sm text-muted-foreground">
          Codex runs task runs only, in its own workspace sandbox, without office tools (messages, memory), skills, subagents or turn and budget limits. Those
          settings are kept for when the agent goes back to Claude. A project whose destructive-command or sensitive-path policy is not auto refuses Codex runs.
        </p>
      ) : (
        <>
          <div className="space-y-1">
            <Label>Allowed tools</Label>
            <ToolPicker lockAlwaysOn value={form.tools} onChange={(tools) => setForm({ ...form, tools })} />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {(
              [
                ['maxTurns', 'Max turns', '1'],
                ['maxBudgetUsd', 'Max budget (USD, 0 = no cap)', '0.01'],
                ['maxConcurrentSubagents', 'Max concurrent subagents', '1'],
                ['maxSubagentDepth', 'Max subagent depth', '1'],
              ] as const
            ).map(([k, label, step]) => (
              <div key={k} className="space-y-1">
                <Label htmlFor={k}>{label}</Label>
                <Input id={k} type="number" min={0} step={step} required value={form[k]} onChange={set(k)} />
              </div>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Skills</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {skills.isPending && <p className="text-sm text-muted-foreground">Loading skills…</p>}
              {skills.isError && <p className="text-sm text-destructive">{String(skills.error)}</p>}
              {skills.isSuccess && approved.length === 0 && <p className="text-sm text-muted-foreground">No approved skills.</p>}
              {approved.map((s) => {
                const pin = pins[s.id];
                return (
                  <div key={s.id} className="flex flex-wrap items-center gap-3">
                    <label className="flex min-w-48 items-center gap-2 font-mono text-sm">
                      <input type="checkbox" className={CHECK} checked={!!pin} onChange={(e) => togglePin(s.id, e.target.checked)} />
                      {s.name}
                    </label>
                    {pin && (
                      <>
                        <Select value={pin.mode} onValueChange={(v) => setPin(s.id, { mode: v as SkillMode })}>
                          <SelectTrigger size="sm" aria-label="Skill mode">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="eager">eager</SelectItem>
                            <SelectItem value="on_demand">on_demand</SelectItem>
                          </SelectContent>
                        </Select>
                        <VersionSelect skillId={s.id} value={pin.versionId} onChange={(v) => setPin(s.id, { versionId: v })} />
                      </>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Subagents</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {subagents.map((s, i) => (
                <div key={i} className="space-y-2 rounded-md border p-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor={`sa-name-${i}`}>Name</Label>
                      <Input id={`sa-name-${i}`} required value={s.name} onChange={(e) => setSub(i, { name: e.target.value })} />
                    </div>
                    <div className="space-y-1">
                      <Label>Model</Label>
                      <Select value={s.model || 'inherit'} onValueChange={(v) => setSub(i, { model: v === 'inherit' ? '' : String(v) })}>
                        <SelectTrigger className="w-full" aria-label="Subagent model">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="inherit">inherit</SelectItem>
                          <ModelItems current={s.model} />
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`sa-desc-${i}`}>Description</Label>
                    <Input id={`sa-desc-${i}`} required value={s.description} onChange={(e) => setSub(i, { description: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`sa-prompt-${i}`}>Prompt</Label>
                    <Textarea id={`sa-prompt-${i}`} rows={3} required value={s.prompt} onChange={(e) => setSub(i, { prompt: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label>Tools (none = inherit from the agent)</Label>
                    <ToolPicker value={s.tools} onChange={(tools) => setSub(i, { tools })} />
                  </div>
                  <div className="space-y-1">
                    <Label>Skills (pinned only)</Label>
                    {pinnedNames.length === 0 && <p className="text-sm text-muted-foreground">Pin a skill above first.</p>}
                    <div className="flex flex-wrap gap-3">
                      {pinnedNames.map((n) => (
                        <label key={n} className="flex items-center gap-2 font-mono text-sm">
                          <input
                            type="checkbox"
                            className={CHECK}
                            checked={s.skills.includes(n)}
                            onChange={(e) =>
                              setSub(i, { skills: e.target.checked ? [...s.skills, n] : s.skills.filter((x) => x !== n) })
                            }
                          />
                          {n}
                        </label>
                      ))}
                    </div>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => setSubagents((list) => list.filter((_, j) => j !== i))}>
                    Remove
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => setSubagents((list) => [...list, { ...NEW_SUBAGENT }])}>
                Add subagent
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {error && <p className="whitespace-pre-wrap text-sm text-destructive">{error}</p>}
      {/* without the skill list the payload would drop every pin */}
      <Button type="submit" disabled={busy || !skills.isSuccess}>
        {submitLabel}
      </Button>
    </form>
  );
}

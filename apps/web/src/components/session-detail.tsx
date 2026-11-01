'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Send } from 'lucide-react';
import type { OfficeEvent } from '@office/shared';
import { subagentName } from '@/components/session-list';
import { AgentAvatar } from '@/components/ui/agent-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { KpiCard } from '@/components/ui/kpi-card';
import { Segmented } from '@/components/ui/segmented';
import { StatusDot, StatusPill } from '@/components/ui/status-pill';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, post } from '@/lib/api';
import { usd } from '@/lib/dashboard';
import { useSession, type Conversation, type SessionDetail as Detail, type SessionFile } from '@/lib/queries';
import { clockTime, commandRows, elapsed, fileRows, isLive, splitPath, type CommandRow } from '@/lib/sessions';
import { statusTone } from '@/lib/status';
import { uiSocket } from '@/lib/ws';


/** Commands, files and a way to talk to one session or one of its subagents. */
export function SessionDetail({
  runId,
  subagentId,
  projectId,
  recipients,
  onCancelled,
}: {
  runId: string;
  subagentId?: string;
  projectId: string;
  /** agents with a live session; subagents are never recipients */
  recipients: { id: string; name: string }[];
  onCancelled: () => void;
}) {
  const q = useSession(runId);
  const [events, setEvents] = useState(new Map<number, OfficeEvent>());
  const [now, setNow] = useState(() => Date.now());
  const d = q.data;
  const live = !!d && isLive(d.status);

  useEffect(
    () =>
      uiSocket().subscribe(`run:${runId}`, 0, (m) => {
        if (m.type === 'event') setEvents((prev) => (prev.has(m.event.seq) ? prev : new Map(prev).set(m.event.seq, m.event)));
        else if (m.type === 'run.status.changed') void q.refetch();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- q.refetch is stable per runId
    [runId],
  );
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  if (!d) return <p className="text-sm text-ink-3">{q.isError ? 'Could not load this session.' : 'Loading…'}</p>;

  const sub = d.subagents.find((s) => s.id === subagentId);
  const name = sub ? subagentName(sub) : d.agentName;
  const status = sub?.status ?? d.status;
  const all = [...events.values()];
  // a finished subagent inside a live session has no running commands left
  const commands = commandRows(d.commands, all, sub ? sub.status === 'running' : live).filter((c) => (sub ? c.bySubagent === sub.toolUseId : !c.bySubagent));
  const files = fileRows(d.files, all).filter((f) => !sub || f.bySubagent === sub.toolUseId);
  const startedAt = sub?.startedAt ?? d.startedAt;
  const endedAt = sub ? sub.endedAt : live ? null : undefined;
  const ran = startedAt && endedAt !== undefined ? (endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt) : undefined;
  const adds = files.reduce((n, f) => n + (f.adds ?? 0), 0);
  const dels = files.reduce((n, f) => n + (f.dels ?? 0), 0);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2.5">
            <AgentAvatar name={name} size="md" subagent={!!sub} />
            <span className="font-heading text-lg text-ink">{name}</span>
            <StatusPill status={status} />
          </CardTitle>
          <CardDescription className="flex flex-wrap gap-x-3 font-mono text-xs">
            {sub ? <span>Subagent of {d.agentName}</span> : d.taskKey && <span>{d.taskKey} · {d.taskTitle}</span>}
            <span>{sub ? sub.id.slice(0, 8) : (d.sessionId ?? d.runId).slice(0, 8)}</span>
            {d.workerName && <span>{d.workerName}</span>}
            {d.model && <span>{d.model}</span>}
          </CardDescription>
          {live && <CardAction><StopButton runId={d.runId} name={d.agentName} subagent={!!sub} onCancelled={onCancelled} /></CardAction>}
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiCard label="Commands" value={commands.length} />
          <KpiCard label="Files" value={files.length} />
          <KpiCard label="Cost" value={usd(d.costUsd)} sub={sub ? 'Whole session' : undefined} />
          <KpiCard label={endedAt === null ? 'Running' : 'Ran'} value={ran === undefined ? '—' : elapsed(ran)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Commands run by {name}</CardTitle>
          <CardDescription>
            {sub ? `Only this subagent. ${d.agentName}'s own commands are listed under its name.` : 'Its subagents’ commands are listed under their names.'}
          </CardDescription>
          {live && <CardAction><Badge variant="secondary">Streaming</Badge></CardAction>}
        </CardHeader>
        <CardContent>
          <CommandTable name={name} commands={commands} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Files changed</CardTitle>
          <CardDescription>
            {files.length} files{adds || dels ? ` · +${adds} −${dels}` : ''} · every change is attributed to the agent that made it
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FileTable files={files} detail={d} />
        </CardContent>
      </Card>

      <TalkTo key={d.agentId} detail={d} subagent={sub && subagentName(sub)} projectId={projectId} recipients={recipients} />
    </div>
  );
}

/** Commands with status, duration and exit code; `name` labels the table. */
export function CommandTable({ name, commands }: { name: string; commands: CommandRow[] }) {
  return commands.length === 0 ? (
    <p className="text-[13px] text-ink-3">No commands yet.</p>
  ) : (
    <Table aria-label={`Commands run by ${name}`}>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Command</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Exit</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {commands.map((c) => (
          <TableRow key={c.seq}>
            <TableCell className="font-mono text-xs text-ink-3">{clockTime(c.ts)}</TableCell>
            <TableCell>{c.status ? <span className="inline-flex items-center gap-1.5 text-xs"><StatusDot tone={statusTone(c.status)} />{c.status}</span> : '—'}</TableCell>
            <TableCell className="max-w-[420px] truncate font-mono text-xs text-ink" title={c.command ?? undefined}>{c.command ?? '(redacted)'}</TableCell>
            <TableCell className="font-mono text-xs">{c.durationMs === undefined ? '—' : elapsed(c.durationMs)}</TableCell>
            <TableCell className="font-mono text-xs">{c.exitCode ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Changed files, each attributed to the agent or subagent that changed it. */
export function FileTable({ files, detail: d }: { files: SessionFile[]; detail: Detail }) {
  const authorOf = (bySubagent?: string) => {
    const s = bySubagent && d.subagents.find((x) => x.toolUseId === bySubagent);
    return s ? { name: subagentName(s), subagent: true } : { name: d.agentName, subagent: false };
  };
  return files.length === 0 ? (
    <p className="text-[13px] text-ink-3">No files changed yet.</p>
  ) : (
    <Table aria-label="Files changed">
      <TableHeader>
        <TableRow>
          <TableHead>File</TableHead>
          <TableHead>Directory</TableHead>
          <TableHead>+/−</TableHead>
          <TableHead>Author</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.map((f) => {
          const [dir, file] = splitPath(f.path);
          const a = authorOf(f.bySubagent);
          return (
            <TableRow key={f.path}>
              <TableCell className="font-mono text-xs text-ink">{file}</TableCell>
              <TableCell className="font-mono text-xs text-ink-3">{dir || '—'}</TableCell>
              <TableCell className="font-mono text-xs">{f.adds === undefined && f.dels === undefined ? '—' : <><span className="text-mint">+{f.adds ?? 0}</span> <span className="text-rose">−{f.dels ?? 0}</span></>}</TableCell>
              <TableCell><span className="inline-flex items-center gap-1.5 text-xs" title={a.name}><AgentAvatar name={a.name} subagent={a.subagent} />{a.name}</span></TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function StopButton({ runId, name, subagent, onCancelled, label = 'Stop' }: { runId: string; name: string; subagent: boolean; onCancelled: () => void; label?: string }) {
  const [error, setError] = useState('');
  const stop = async () => {
    if (!window.confirm(subagent ? `Stop ${name}'s session? Its subagents end with it.` : `Stop ${name}'s session?`)) return;
    setError('');
    try {
      await post(`/runs/${runId}/cancel`);
      onCancelled();
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409)) return setError(String(err));
      // run_not_live: it ended on its own meanwhile; refresh so the list and detail catch up
      setError('Session already ended');
      onCancelled();
    }
  };
  return (
    <span className="flex items-center gap-2">
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
      <Button variant="destructive" onClick={() => void stop()}>
        {label}
      </Button>
    </span>
  );
}

type Kind = 'message' | 'question';

/** Writes to the agent's human conversation; delivery happens at the next run boundary (no streaming input). */
function TalkTo({ detail, subagent, projectId, recipients }: { detail: Detail; subagent?: string; projectId: string; recipients: { id: string; name: string }[] }) {
  const list = recipients.some((r) => r.id === detail.agentId) ? recipients : [{ id: detail.agentId, name: detail.agentName }, ...recipients];
  const [to, setTo] = useState(detail.agentId);
  const [type, setType] = useState<Kind>('message');
  const [body, setBody] = useState('');
  const [state, setState] = useState<{ busy?: boolean; sent?: string; error?: string }>({});
  const toName = list.find((r) => r.id === to)?.name ?? detail.agentName;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setState({ busy: true });
    try {
      const conv = await post<Conversation>('/conversations', { projectId, kind: 'human', agentIds: [to] });
      await post(`/conversations/${conv.id}/messages`, { type, body: body.trim() });
      setBody('');
      setState({ sent: toName });
    } catch (err) {
      setState({ error: String(err) });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Talk to {toName}</CardTitle>
        <CardDescription>
          {subagent ? `${subagent} is a subagent and cannot take messages. ` : ''}Subagents are reached through their parent agent.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={send} className="flex flex-col gap-2">
          <Segmented label="Recipient" value={to} onChange={setTo} options={list.map((r) => ({ value: r.id, label: r.name }))} />
          <Textarea
            aria-label="Message"
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={`Message to ${toName}`}
            variant="well"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented
              label="Message type"
              value={type}
              onChange={setType}
              options={[
                { value: 'message', label: 'Note' },
                { value: 'question', label: 'Question' },
              ]}
            />
            <Button type="submit" size="lg" disabled={state.busy || !body.trim()}>
              <Send data-icon="inline-start" aria-hidden />
              Send
            </Button>
          </div>
          <p className="text-xs text-ink-3">Delivered at the next run boundary</p>
          {state.sent && <p className="text-xs text-mint">Saved for {state.sent}.</p>}
          {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}

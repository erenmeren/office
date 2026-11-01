import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { lstat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { runCheck } from './checks.js';
import {
  collectResult,
  createWorktree,
  ensureMissionBranch,
  excludeFromGit,
  fastForward,
  git,
  installTrailerHook,
  removeWorktree,
  sweepWorktrees,
} from './git.js';
import { ensureClone } from './repos.js';
import { removeRunRoot, materializeSkills } from './skills.js';
import { buildChildEnv, redactSecrets, type RuntimeAdapter, type ToolBridge } from '@office/runtime';
import type {
  ApprovalDecision,
  EventBody,
  IntegrationStatus,
  OfficeEvent,
  OfficeToolName,
  RunResult,
  RunSpec,
  ToolCallResult,
  WorkerToApi,
} from '@office/shared';

const TOOL_TIMEOUT_MS = 30_000;
// message type of each messaging tool; send_message takes it from its args
const SENT_TYPES: Partial<Record<OfficeToolName, string>> = {
  send_message: 'message',
  reply_message: 'reply',
  request_help: 'help_request',
  handoff_task: 'handoff',
  escalate_to_chief: 'escalation',
};

/** The event recorded after a successful office tool call, if any. */
function derivedEvent(name: OfficeToolName, args: Record<string, unknown>, result: unknown): EventBody | null {
  const r = (result ?? {}) as Record<string, unknown>;
  const sentType = SENT_TYPES[name];
  if (sentType) {
    const to = typeof args.to === 'string' ? args.to : undefined;
    const type = typeof args.type === 'string' ? args.type : sentType;
    return { type: 'agent.message.sent', payload: { messageId: r.messageId, conversationId: r.conversationId, to, type } };
  }
  if (name === 'read_inbox') {
    return { type: 'agent.message.received', payload: { count: Array.isArray(r.messages) ? r.messages.length : 0 } };
  }
  if (name === 'propose_memory') return { type: 'memory.proposed', payload: { entryId: r.entryId } };
  return null;
}

type MissionGit = NonNullable<RunSpec['git']>;
interface Worktree {
  // the repository the worktree belongs to: the local repoPath or the worker's clone
  repo: string;
  path: string;
  baseCommit: string;
  branch: string;
}

interface WarnLog {
  warn(obj: object, msg: string): void;
}

/** What a worker needs to clone from the API's git endpoint; `credential` is read when a run needs it. */
export interface CloneConfig {
  apiUrl: string;
  canClone: boolean;
  credential: () => string | null;
}

/** Writes the owner's dummy env template into the worktree, mode 0600, never over a tracked file or through a symlink. */
async function writeEnvTemplate(worktree: string, env: NonNullable<RunSpec['env']>, log: WarnLog) {
  const file = resolve(worktree, env.file);
  if (!isUnderRoot(file, worktree) || file === worktree) throw new Error(`env file outside the worktree: ${env.file}`);
  const rel = relative(worktree, file);
  const tracked = await git(worktree, 'ls-files', '--error-unmatch', rel).then(() => true, () => false);
  if (tracked) return;
  // a checked-out symlink could redirect the write outside the worktree
  const isLink = await lstat(file).then((s) => s.isSymbolicLink(), () => false);
  const parent = realCwd(dirname(file));
  if (isLink || (parent && !isUnderRoot(parent, realpathSync(worktree)))) {
    log.warn({ file: rel }, 'env template not written: the path resolves outside the worktree');
    return;
  }
  await writeFile(file, env.vars.map((v) => `${v.name}=${v.value}\n`).join(''), { mode: 0o600 });
  // never committed by an agent's `git add -A`
  await excludeFromGit(worktree, '/' + rel);
}

const NO_USAGE: RunResult['usage'] = { inputTokens: 0, outputTokens: 0, costUsd: 0, numTurns: 0, durationMs: 0 };

/** True if `path` is `root` or inside it, compared by path segment (`/a/bc` is not under `/a/b`). */
function isUnderRoot(path: string, root: string): boolean {
  const p = resolve(path);
  const r = resolve(root);
  return p === r || p.startsWith(r.endsWith('/') ? r : r + '/');
}

function realCwd(cwd: string): string | null {
  try {
    return realpathSync(cwd);
  } catch {
    return null;
  }
}

export class RunExecutor {
  private active = new Map<string, AbortController>();
  private pendingTools = new Map<string, { runId: string; resolve: (r: ToolCallResult) => void; timer: NodeJS.Timeout }>();
  // the API's approval timeout answers first; the worker's own timer is a backstop for a lost answer
  private pendingApprovals = new Map<string, { runId: string; resolve: (d: ApprovalDecision) => void; timer: NodeJS.Timeout }>();
  private worktreesDir: string;
  private reposDir: string;

  constructor(
    private adapter: RuntimeAdapter,
    private send: (msg: WorkerToApi) => void,
    private workspaceRoots: string[],
    private runsDir: string,
    private toolTimeoutMs = TOOL_TIMEOUT_MS,
    private log: WarnLog = { warn: () => {} },
    private clone?: CloneConfig,
  ) {
    // <home>/runs -> <home>/worktrees, <home>/repos
    this.worktreesDir = join(dirname(runsDir), 'worktrees');
    this.reposDir = join(dirname(runsDir), 'repos');
  }

  private credential(): string {
    const credential = this.clone?.credential();
    if (!credential) throw new Error('no worker credential for the API git endpoint');
    return credential;
  }

  /** Settles a pending office tool call with the API's answer; unknown or late call ids are ignored. */
  resolveTool(callId: string, result: ToolCallResult): void {
    const pending = this.pendingTools.get(callId);
    if (!pending) return;
    this.pendingTools.delete(callId);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  /** The socket closed: every pending call fails now, its answer could no longer arrive. */
  failPendingTools(): void {
    for (const callId of [...this.pendingTools.keys()]) {
      this.resolveTool(callId, { ok: false, code: 'disconnected', error: 'worker disconnected' });
    }
  }

  /** Settles a pending approval; unknown or already resolved request ids (the API may resend) are ignored. */
  resolveApproval(runId: string, decision: ApprovalDecision): void {
    const pending = this.pendingApprovals.get(decision.requestId);
    if (!pending || pending.runId !== runId) return;
    this.pendingApprovals.delete(decision.requestId);
    clearTimeout(pending.timer);
    pending.resolve(decision);
  }

  activeRunIds(): string[] {
    return [...this.active.keys()];
  }

  /** Aborts the run and settles its pending tool calls and approvals, so the adapter can wind down. */
  cancel(runId: string): void {
    this.active.get(runId)?.abort();
    for (const [callId, p] of [...this.pendingTools]) {
      if (p.runId === runId) this.resolveTool(callId, { ok: false, code: 'cancelled', error: 'run cancelled' });
    }
    for (const [requestId, p] of [...this.pendingApprovals]) {
      if (p.runId === runId) this.resolveApproval(runId, { requestId, decision: 'deny', message: 'run cancelled' });
    }
  }

  accept(spec: RunSpec): void {
    if (this.active.has(spec.runId)) return;
    if (spec.git?.remote) {
      // the run happens in a worktree of the worker's own clone; spec.cwd is not a path
      if (!this.clone?.canClone) {
        this.send({ type: 'run.rejected', runId: spec.runId, reason: 'worker cannot clone' });
        return;
      }
    } else {
      // symlinks are resolved so a link inside a root cannot point the run outside it
      const cwd = realCwd(spec.cwd);
      const repo = spec.git ? realCwd(spec.git.repoPath!) : cwd;
      const allowed = (p: string | null) => !!p && this.workspaceRoots.some((r) => isUnderRoot(p, r));
      if (!allowed(cwd) || !allowed(repo)) {
        this.send({ type: 'run.rejected', runId: spec.runId, reason: 'cwd outside allowed roots' });
        return;
      }
    }
    const controller = new AbortController();
    this.active.set(spec.runId, controller);
    this.send({ type: 'run.accepted', runId: spec.runId });
    void this.execute(spec, controller.signal).finally(() => this.active.delete(spec.runId));
  }

  private async execute(spec: RunSpec, signal: AbortSignal) {
    // one session per run; a resumed run continues the session's seq after the API's startSeq
    let seq = spec.startSeq ?? 0;
    const emit = (body: EventBody) => {
      const event: OfficeEvent = {
        ...body,
        seq: ++seq,
        ts: new Date().toISOString(),
        sessionId: spec.sessionId,
        runId: spec.runId,
        agentId: spec.agentId,
        projectId: spec.projectId,
      };
      this.send({ type: 'run.event', event: redactSecrets(event) });
    };
    const tools: ToolBridge = {
      call: async (name, args) => {
        const callId = randomUUID();
        const result = await new Promise<ToolCallResult>((resolve) => {
          const timer = setTimeout(
            () => this.resolveTool(callId, { ok: false, code: 'timeout', error: 'tool call timed out' }),
            this.toolTimeoutMs,
          );
          this.pendingTools.set(callId, { runId: spec.runId, resolve, timer });
          this.send({ type: 'tool.call', runId: spec.runId, sessionId: spec.sessionId, callId, name, args });
        });
        const derived = result.ok ? derivedEvent(name, args, result.result) : null;
        if (derived) emit(derived);
        return result;
      },
      askApproval: (request) =>
        new Promise<ApprovalDecision>((resolve) => {
          const minutes = spec.approvalTimeoutMinutes + 5;
          const timer = setTimeout(
            () =>
              this.resolveApproval(spec.runId, {
                requestId: request.requestId,
                decision: 'deny',
                message: `No decision reached the worker within ${minutes} minutes`,
              }),
            minutes * 60_000,
          );
          this.pendingApprovals.set(request.requestId, { runId: spec.runId, resolve, timer });
          this.send({ type: 'approval.request', runId: spec.runId, sessionId: spec.sessionId, request });
        }),
    };
    let result: RunResult;
    let worktree: Worktree | undefined;
    let keepWorktree = false;
    try {
      try {
        let cwd = spec.cwd;
        if (spec.git) {
          worktree = await this.createRunWorktree(spec, spec.git);
          cwd = worktree.path;
          await this.prepareWorktree(spec, spec.git, cwd);
        }
        // summary runs need no skills, so no run root is created for them
        const skillsDir = spec.kind === 'summary' ? undefined : await materializeSkills(this.runsDir, spec.runId, spec.skills);
        result = await this.adapter.run({ ...spec, cwd, ...(skillsDir && { skillsDir }) }, { emit }, signal, tools);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        emit({ type: 'agent.failed', payload: { error } });
        result = { status: 'failed', error, usage: NO_USAGE };
      } finally {
        await removeRunRoot(this.runsDir, spec.runId).catch(() => {});
      }
      if (worktree) {
        try {
          result = await this.finishWorktree(spec, spec.git!, worktree, result);
          keepWorktree = !!result.git?.worktreePath;
        } catch (err) {
          // the outcome is unknown: keep the worktree for inspection
          keepWorktree = true;
          const error = 'git: ' + (err instanceof Error ? err.message : String(err));
          result = { ...result, status: 'failed', error };
        }
      }
    } finally {
      if (worktree && !keepWorktree) {
        await removeWorktree(worktree.repo, worktree.path, { run: worktree.branch, mission: spec.git!.missionBranch });
      }
    }
    this.send({ type: 'run.result', runId: spec.runId, sessionId: spec.sessionId, result });
  }

  /**
   * A worktree at the mission head on its own run branch; old inactive worktrees of the repo are swept first.
   * A resumed run continues in the worktree it was suspended in.
   */
  private async createRunWorktree(spec: RunSpec, g: MissionGit): Promise<Worktree> {
    // a clone is fetched and its mission branch ensured by ensureClone
    const repo = g.remote
      ? await ensureClone({
          apiUrl: this.clone!.apiUrl,
          credential: this.credential(),
          remotePath: g.remote.path,
          reposDir: this.reposDir,
          projectId: spec.projectId,
          defaultBranch: g.defaultBranch,
          missionBranch: g.missionBranch,
        })
      : g.repoPath!;
    await sweepWorktrees(repo, this.worktreesDir, this.activeRunIds()).catch(() => {});
    if (!g.remote) await ensureMissionBranch(repo, g.missionBranch, g.defaultBranch);
    const existing = join(this.worktreesDir, spec.runId);
    if (existsSync(existing)) {
      return {
        repo,
        path: existing,
        branch: await git(existing, 'rev-parse', '--abbrev-ref', 'HEAD'),
        // the run's commits are not on the mission branch, so their fork point is the original base
        baseCommit: await git(existing, 'merge-base', 'HEAD', `refs/heads/${g.missionBranch}`),
      };
    }
    // `<mission>/<task>` would clash with the mission branch ref itself, so runs live under `<mission>-runs/`
    const branch = `${g.missionBranch}-runs/${g.taskSlug}-${spec.runId.slice(0, 8)}`;
    const wt = await createWorktree(repo, this.worktreesDir, spec.runId, g.missionBranch, branch);
    return { ...wt, repo, branch };
  }

  private async prepareWorktree(spec: RunSpec, g: MissionGit, path: string) {
    await installTrailerHook(path, { agentName: g.agentName, runId: spec.runId });
    if (spec.env) await writeEnvTemplate(path, spec.env, this.log);
    if (spec.setupCommand && !existsSync(join(path, 'node_modules'))) {
      const setup = await runCheck(path, spec.setupCommand, spec.checkTimeoutSeconds, buildChildEnv(process.env, spec));
      if (setup.status !== 'passed') throw new Error('setup failed: ' + setup.output.slice(0, 500));
    }
  }

  /** Collects the run's commits; a succeeded code run is checked, then fast-forwarded onto the mission branch. */
  private async finishWorktree(spec: RunSpec, g: MissionGit, wt: Worktree, result: RunResult): Promise<RunResult> {
    const collected = await collectResult(wt.path, wt.baseCommit);
    let check: RunResult['check'];
    let integration: IntegrationStatus = 'none';
    if (spec.taskKind === 'code' && !spec.readOnlyCheckout && result.status === 'succeeded') {
      check = spec.checkCommand
        ? {
            command: spec.checkCommand,
            ...(await runCheck(wt.path, spec.checkCommand, spec.checkTimeoutSeconds, buildChildEnv(process.env, spec))),
          }
        : { command: '', status: 'skipped', exitCode: null, durationMs: 0, output: '' };
      if (collected.commits.length > 0 && check.status !== 'failed' && check.status !== 'timeout') {
        const remote = g.remote ? { credential: this.credential(), baseCommit: wt.baseCommit, runBranch: wt.branch } : undefined;
        integration = await fastForward(wt.repo, g.missionBranch, collected.headCommit, remote);
      }
    }
    // a suspended run resumes here; unintegrated commits stay on disk for inspection until swept
    const keep = result.status === 'suspended' || (collected.commits.length > 0 && integration !== 'fast_forwarded');
    return {
      ...result,
      git: { branch: wt.branch, baseCommit: wt.baseCommit, ...collected, integration, ...(keep && { worktreePath: wt.path }) },
      ...(check && { check }),
    };
  }
}

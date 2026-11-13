import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { API, authed, expect, expectQuiet, test } from './fixtures';

const STATIC = ['/', '/conductor', '/decisions', '/mission-control', '/sessions', '/office', '/conversations', '/agents', '/skills', '/memory', '/workers', '/audit', '/settings', '/tasks/new'];

authed.describe('every page renders without console noise', () => {
  authed('static routes', async ({ page, noise }) => {
    for (const path of STATIC) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeVisible();
    }
    expectQuiet(noise);
  });

  authed('detail routes from the API', async ({ page, request, noise }) => {
    const [tasks, agents, skills] = await Promise.all(
      ['/tasks', '/agents', '/skills'].map((p) => request.get(`${API}${p}`).then((r) => r.json() as Promise<{ id: string }[]>)),
    );
    const paths = [tasks[0] && `/tasks/${tasks[0].id}`, agents[0] && `/agents/${agents[0].id}`, skills[0] && `/skills/${skills[0].id}`].filter(Boolean) as string[];
    for (const path of paths) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('main')).toBeVisible();
    }
    expectQuiet(noise);
  });

  authed('fonts are self-hosted', async ({ page, noise }) => {
    await page.goto('/mission-control');
    await page.waitForLoadState('networkidle');
    const family = await page.getByRole('heading', { level: 1 }).evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family).toContain('bricolageGrotesque');
    const loaded = await page.evaluate(() => document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status === 'loaded').length));
    expect(loaded).toBeGreaterThan(0);
    expectQuiet(noise);
  });

  authed('mission control: pick a task, composer gates on input', async ({ page, request, noise }) => {
    await page.goto('/mission-control');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { level: 1, name: 'Mission Control' })).toBeVisible();
    const send = page.getByRole('button', { name: 'Send to Chief' });
    await expect(send).toBeDisabled();
    await page.getByLabel('Request to Chief').fill('Hello');
    await expect(send).toBeEnabled();

    // task picking applies to the `Tasks without a mission` graph
    const all = (await (await request.get(`${API}/tasks`)).json()) as { id: string; title: string; missionId: string | null }[];
    const tasks = all.filter((t) => !t.missionId);
    if (tasks.length >= 2) {
      const node = page.getByRole('button', { name: new RegExp(tasks[0].id.slice(0, 8)) });
      await node.click();
      await expect(node).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByText(tasks[0].id.slice(0, 8), { exact: true }).first()).toBeVisible();
    }
    expectQuiet(noise);
  });

  authed('mission control: submit a request creates a mission', async ({ page, request: api, noise }) => {
    await page.goto('/mission-control');
    await page.waitForLoadState('networkidle');
    const request = `E2E mission ${Date.now()}`;
    try {
      await page.getByLabel('Request to Chief').fill(request);
      await page.getByRole('button', { name: 'Send to Chief' }).click();
      // no worker runs during e2e, so the mission stays in planning
      await expect(page.getByLabel('Mission', { exact: true }).locator('option:checked')).toContainText(request);
      await expect(page.getByText(`Plan v0 · ${request}`)).toBeVisible();
      await expect(page.getByText('Chief is writing the plan…')).toBeVisible();
      expectQuiet(noise);
    } finally {
      // cancel the mission so a worker that connects later never plans it
      const missions = (await (await api.get(`${API}/missions`)).json()) as { id: string; request: string }[];
      for (const m of missions.filter((x) => x.request === request)) {
        expect((await api.post(`${API}/missions/${m.id}/cancel`)).ok()).toBe(true);
      }
    }
  });

  authed('mission control: a done mission shows its summary and links to the review evidence', async ({ page, request: api, noise }) => {
    const [project] = (await (await api.get(`${API}/projects`)).json()) as { id: string }[];
    const created = await api.post(`${API}/missions`, { data: { projectId: project.id, request: `E2E verdict ${Date.now()}` } });
    expect(created.ok()).toBe(true);
    const { id } = (await created.json()) as { id: string };
    // cancelled at once so no worker ever plans it; the detail is then served as a done mission fixture
    expect((await api.post(`${API}/missions/${id}/cancel`)).ok()).toBe(true);
    await page.route(`${API}/missions/${id}`, async (route) => {
      const real = await (await route.fetch()).json();
      await route.fulfill({
        json: { ...real, status: 'done', summary: 'E2E verdict: all tasks done', reviewRunId: 'run-fixture', reviewArtifactId: 'artifact-fixture' },
      });
    });
    await page.goto('/mission-control');
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Mission', { exact: true }).selectOption(id);
    await expect(page.getByText('E2E verdict: all tasks done')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review run events' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'mission-review.md' })).toBeVisible();

    // handoff to a manual session: the terminal opens with the mission's summary beside it
    const term = { id: 'term-handoff', projectId: project.id, dir: '/tmp/office-e2e/p', workerId: 'w', claudeSessionId: 'cli-eeee-5555', status: 'running', pid: 7, startedAt: new Date().toISOString() };
    await page.route(`${API}/terminals`, (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 201, json: term }) : route.fulfill({ json: [term] })));
    await page.route(`${API}/claude-sessions`, (route) => route.fulfill({ json: { sessions: [] } }));
    await page.getByRole('button', { name: 'Open a manual session here' }).click();
    await page.waitForURL(`**/sessions?terminal=term-handoff&mission=${id}`);
    await expect(page.getByText('From mission:')).toBeVisible();
    await expect(page.getByText('E2E verdict: all tasks done')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy summary' })).toBeVisible();
    await expect(page.getByRole('application', { name: 'Terminal' })).toBeVisible();
    expectQuiet(noise);
  });

  authed('dashboard: KPIs, team, attention and the 7-day cost chart from the API', async ({ page, request: api, noise }) => {
    const [project] = (await (await api.get(`${API}/projects`)).json()) as { id: string }[];
    const now = new Date().toISOString();
    const days = [...Array(7)].map((_, i) => new Date(Date.now() - (6 - i) * 86_400_000).toISOString().slice(0, 10));
    await page.route(`${API}/projects/${project.id}/overview`, (route) =>
      route.fulfill({
        json: {
          agentsAvailable: 1, agentsTotal: 2, runningSessions: 1, maxConcurrentRuns: 8, pendingTasks: 4, awaitingApproval: 1,
          costTodayUsd: 18.42, dailyBudgetUsd: 50,
          team: [
            { agentId: 'a-fe', name: 'E2E Frontend Dev', role: 'Frontend Developer', status: 'needs_approval', currentWork: 'Login form + validation', workerName: 'dev-laptop', costTodayUsd: 3.31 },
            { agentId: 'a-qa', name: 'E2E QA Engineer', role: 'QA Engineer', status: 'idle', currentWork: null, workerName: null, costTodayUsd: 0 },
          ],
          attention: [{ kind: 'skill_review', id: 'skill-fixture', title: 'e2e-testing', detail: 'Imported from git', createdAt: now }],
        },
      }),
    );
    await page.route(new RegExp(`${API}/projects/${project.id}/costs\\?days=7&groupBy=day`), (route) =>
      route.fulfill({ json: { totalUsd: 77.62, buckets: days.map((key, i) => ({ key, label: key, costUsd: i === 6 ? 18.42 : 9.86, inputTokens: 0, outputTokens: 0 })) } }),
    );
    await page.route(`${API}/projects/${project.id}/activity?limit=50`, (route) =>
      route.fulfill({ json: [{ id: 'ev-1', key: 's-fixture:1', ts: now, type: 'agent.tool.completed', agentId: 'a-fe', agentName: 'E2E Frontend Dev', runId: 'r', taskKey: null, detail: 'Edit LoginForm.tsx' }] }),
    );
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    for (const label of ['Active projects', 'Agents available', 'Running sessions', 'Pending tasks', 'Cost today']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('37% of $50.00 daily budget')).toBeVisible();
    const fe = page.getByRole('row').filter({ hasText: 'E2E Frontend Dev' });
    await expect(fe.getByText('Needs approval')).toBeVisible();
    await expect(fe.getByText('$3.31')).toBeVisible();
    const attention = page.getByRole('list', { name: 'Needs your attention' }).getByRole('listitem');
    await expect(attention.filter({ hasText: 'e2e-testing' }).getByRole('link', { name: 'Decide' })).toHaveAttribute('href', '/decisions');
    const chart = page.getByRole('img', { name: /Cost per day, last 7 days/ });
    await expect(chart.locator('[data-slot="bar"]')).toHaveCount(7);
    await expect(chart.locator('[data-slot="bar"][data-partial]')).toHaveCount(1);
    await expect(page.getByText('$77.62 total')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Recent activity' }).getByText('Edit LoginForm.tsx')).toBeVisible();
    expectQuiet(noise);
  });

  authed('live sessions: a subagent shows only its commands; Stop cancels the run; the composer explains delivery', async ({ page, request: api, noise }) => {
    const [project] = (await (await api.get(`${API}/projects`)).json()) as { id: string }[];
    const [agent] = (await (await api.get(`${API}/agents`)).json()) as { id: string; name: string }[];
    const now = Date.now();
    const at = (s: number) => new Date(now - 60_000 + s * 1000).toISOString();
    const sub = { id: 'sub-fixture-41c', toolUseId: 'tu-sub', subagentType: 'Test Writer', description: 'write tests', status: 'running', startedAt: at(10), endedAt: null, commands: 1, files: 1 };
    const item = {
      runId: 'run-fixture', sessionId: 'ses-fixture', agentId: agent.id, agentName: agent.name, kind: 'task', status: 'running', taskId: 't', taskKey: 'T-104',
      taskTitle: 'Login form', workerName: 'dev-laptop', startedAt: at(0), costUsd: 0.09, waitingFor: null, commands: 2, files: 2, subagents: [sub],
    };
    await page.route(`${API}/sessions?projectId=${project.id}&status=live`, (route) => route.fulfill({ json: [item] }));
    await page.route(`${API}/sessions/run-fixture`, (route) =>
      route.fulfill({
        json: {
          ...item, model: 'sonnet', agentVersion: 1, maxBudgetUsd: 5, usage: { inputTokens: 10, outputTokens: 5 }, skills: [], approval: null,
          commands: [
            { seq: 1, ts: at(5), command: 'pnpm lint', exitCode: 0, durationMs: 1200 },
            { seq: 2, ts: at(20), command: 'pnpm --filter web vitest run LoginForm', bySubagent: 'tu-sub' },
          ],
          files: [{ path: 'apps/web/components/LoginForm.tsx', adds: 96, dels: 3 }, { path: 'apps/web/components/LoginForm.test.tsx', adds: 62, dels: 0, bySubagent: 'tu-sub' }],
        },
      }),
    );
    let cancels = 0;
    await page.route(`${API}/runs/run-fixture/cancel`, (route) => {
      if (route.request().method() === 'POST') cancels++;
      // first Stop: the run ended meanwhile (409); second: cancelled
      return cancels === 1
        ? route.fulfill({ status: 409, json: { error: 'run_not_live' } })
        : route.fulfill({ json: { id: 'run-fixture', status: 'cancelled' } });
    });
    await page.goto('/sessions');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('1 agent · 1 subagent')).toBeVisible();
    await expect(page.getByRole('table', { name: `Commands run by ${agent.name}` }).getByText('pnpm lint')).toBeVisible();

    await page.getByRole('list', { name: `Subagents of ${agent.name}` }).getByRole('button').click();
    const commands = page.getByRole('table', { name: 'Commands run by Test Writer' });
    await expect(commands.getByText('pnpm --filter web vitest run LoginForm')).toBeVisible();
    await expect(commands.getByText('pnpm lint')).toHaveCount(0);
    await expect(page.getByText(`Subagent of ${agent.name}`)).toBeVisible();
    await expect(page.getByRole('table', { name: 'Files changed' }).getByText('LoginForm.test.tsx')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Files changed' }).getByText('LoginForm.tsx', { exact: true })).toHaveCount(0);

    await expect(page.getByText('Reaches a running session within seconds, otherwise its next run.')).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Recipient' }).getByRole('radio')).toHaveText([agent.name]);

    // the in-app confirm dialog replaces window.confirm
    const stop = async () => {
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Stop', exact: true }).click();
    };
    const refetch = page.waitForRequest((r) => r.url() === `${API}/sessions/run-fixture`);
    await stop();
    await expect(page.getByRole('alert').filter({ hasText: 'Session already ended' })).toBeVisible();
    await refetch;
    await stop();
    await expect.poll(() => cancels).toBe(2);
    // the browser logs the stubbed 409 itself; anything else is noise
    noise.console = noise.console.filter((m) => !m.includes('status of 409 (Conflict)'));
    expectQuiet(noise);
  });

  authed('agent inspector: header metrics, live approval event, approval and skills in the rail, previous tasks', async ({ page, request: api, noise }) => {
    const [project] = (await (await api.get(`${API}/projects`)).json()) as { id: string }[];
    const [agent] = (await (await api.get(`${API}/agents`)).json()) as { id: string; name: string }[];
    const at = (s: number) => new Date(Date.now() - 226_000 + s * 1000).toISOString();
    const detail = {
      runId: 'run-inspect', sessionId: 'ses8f2a91xx', projectId: project.id, agentId: agent.id, agentName: agent.name, kind: 'task', status: 'waiting_approval',
      taskId: 'task-fixture', taskKey: 'T-104', taskTitle: 'Login form + validation', workerName: 'dev-laptop', startedAt: at(0), finishedAt: null,
      costUsd: 3.31, model: 'claude-sonnet-5-5', agentVersion: 4, maxBudgetUsd: 5, usage: { inputTokens: 184_000, outputTokens: 21_000 },
      commands: [], files: [],
      subagents: [{ id: 'sub41cxx', toolUseId: 'tu-1', subagentType: 'Test Writer', description: 'Write tests for LoginForm validation', status: 'running', startedAt: at(95), endedAt: null, commands: 0, files: 0 }],
      skills: [
        { skillId: 's1', skillVersionId: 'sv1', name: 'test-driven-development', version: 2, checksum: 'x', mode: 'eager' },
        { skillId: 's2', skillVersionId: 'sv2', name: 'debugging', version: 1, checksum: 'y', mode: 'on_demand' },
      ],
      approval: {
        id: 'appr-fixture', projectId: project.id, missionId: null, taskId: 'task-fixture', runId: 'run-inspect', type: 'destructive_command', status: 'pending', scope: null,
        toolName: 'Bash', input: { command: 'rm -rf .next node_modules' }, reason: 'destructive command', createdAt: at(222), decidedAt: null, expiresAt: null, deliveredAt: null,
      },
    };
    await page.route(`${API}/sessions/run-inspect`, (route) => route.fulfill({ json: detail }));
    await page.route(`${API}/agents/${agent.id}/runs?limit=20`, (route) =>
      route.fulfill({ json: [{ runId: 'run-old', taskKey: 'T-088', taskTitle: 'Settings form validation', status: 'succeeded', durationMs: 720_000, costUsd: 2.1, headCommit: '3be91f0aa' }] }),
    );
    // the run's socket replay comes from the fixture; every other topic goes to the real API
    await page.routeWebSocket(`${API.replace('http', 'ws')}/ws/ui`, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((raw) => {
        const m = JSON.parse(String(raw)) as { type: string; topic: string };
        if (m.topic !== 'run:run-inspect') return server.send(raw);
        if (m.type !== 'subscribe') return;
        const event = { type: 'agent.waiting_approval', seq: 48_213, ts: at(222), sessionId: detail.sessionId, runId: 'run-inspect', agentId: agent.id, projectId: project.id, payload: { tool: 'Bash' } };
        ws.send(JSON.stringify({ type: 'event', topic: m.topic, event }));
        ws.send(JSON.stringify({ type: 'replay.done', topic: m.topic, lastSeq: 48_213 }));
      });
    });

    await page.goto('/sessions/run-inspect');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { level: 1, name: 'Agent Inspector' })).toBeVisible();
    await expect(page.getByText('205k', { exact: true })).toBeVisible();
    await expect(page.getByText('184k in · 21k out')).toBeVisible();
    await expect(page.getByText('$3.31', { exact: true })).toBeVisible();
    await expect(page.getByText('cap $5.00')).toBeVisible();
    await expect(page.getByText('Running for')).toBeVisible();
    await expect(page.getByText('config v4')).toBeVisible();

    await expect(page.getByText('agent.waiting_approval', { exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Following live · seq 48,213' })).toBeVisible();
    await page.getByRole('button', { name: 'Pause following' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Paused · seq 48,213' })).toBeVisible();

    await expect(page.getByText('Waiting for you')).toBeVisible();
    await expect(page.getByText('rm -rf .next node_modules')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve once' })).toBeVisible();
    const skills = page.getByRole('list', { name: 'Skills in this session' });
    await expect(skills.getByText('Eager', { exact: true })).toBeVisible();
    await expect(skills.getByText('On demand', { exact: true })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Subagents of this session' }).getByText('Test Writer')).toBeVisible();
    await expect(page.getByText('Depth 1 of 1', { exact: false })).toBeVisible();

    await page.getByRole('radio', { name: 'History' }).click();
    const row = page.getByRole('table', { name: 'Previous tasks' }).getByRole('row').filter({ hasText: 'T-088' });
    await expect(row.getByText('Settings form validation')).toBeVisible();
    await expect(row.getByText('12m 0s')).toBeVisible();
    await expect(row.getByText('$2.10')).toBeVisible();
    await expect(row.getByText('3be91f0', { exact: true })).toBeVisible();
    expectQuiet(noise);
  });

  authed('workers: a pending worker shows no mode; a remote worker shows its mode and tag', async ({ page, request: api, noise }) => {
    const name = `e2e-worker-${Date.now()}`;
    expect((await api.post(`${API}/workers`, { data: { name } })).ok()).toBe(true);
    await page.route(`${API}/workers`, async (route) => {
      const real = (await (await route.fetch()).json()) as Record<string, unknown>[];
      const fixture = { id: 'w-fixture', name: 'e2e-remote', status: 'online', capacity: 2, allowedRoots: [], tags: ['gpu'], canClone: true, lastHeartbeatAt: new Date().toISOString(), online: true, activeRuns: 1, runtimes: ['claude', 'codex'] };
      await route.fulfill({ json: [...real, fixture] });
    });
    await page.goto('/workers');
    const pending = page.getByRole('row').filter({ hasText: name });
    await expect(pending.getByText('Pending')).toBeVisible();
    const remote = page.getByRole('row').filter({ hasText: 'e2e-remote' });
    await expect(remote.getByText('remote', { exact: true })).toBeVisible();
    await expect(remote.getByText('gpu', { exact: true })).toBeVisible();
    await expect(remote.getByText('1/2')).toBeVisible();
    await expect(remote.getByText('Runs claude, codex')).toBeVisible();
    // Delete removes the row for good (and this test's worker with it)
    await pending.getByRole('button', { name: `Delete ${name}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(pending).toHaveCount(0);
    expectQuiet(noise);
  });

  authed('owner messages an agent', async ({ page, noise }) => {
    // a dedicated inactive agent: never woken and never listed to agents, so no real chat run reads this e2e mail
    const agentName = 'E2E Inbox';
    const agents = (await (await page.request.get(`${API}/agents`)).json()) as { id: string; slug: string; isActive: boolean }[];
    let inbox = agents.find((a) => a.slug === 'e2e-inbox');
    if (!inbox) {
      const res = await page.request.post(`${API}/agents`, {
        data: { name: agentName, slug: 'e2e-inbox', role: 'e2e', config: { systemPrompt: 'e2e', model: 'haiku', allowedTools: [], maxBudgetUsd: 0.01 } },
      });
      expect(res.status()).toBe(201);
      inbox = await res.json();
    }
    if (inbox!.isActive) expect((await page.request.put(`${API}/agents/${inbox!.id}`, { data: { isActive: false } })).ok()).toBe(true);
    await page.goto('/conversations');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Message an agent' }).click();
    await page.getByLabel('Agent', { exact: true }).selectOption({ label: agentName });
    await page.getByRole('button', { name: 'Start conversation' }).click();
    // the thread switch resets the composer; fill only once the new thread is shown
    await expect(page.getByRole('heading', { name: `You and ${agentName}` })).toBeVisible();
    // type `message` (the composer default) wakes no agent: nothing for a worker to run later
    const body = `Hello from e2e ${Date.now()}`;
    await page.getByLabel('Message', { exact: true }).fill(body);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('article').filter({ hasText: body })).toBeVisible();
    await expect(page.getByText('Saved · delivers at the next session boundary').first()).toBeVisible();
    expectQuiet(noise);
  });

  authed('owner adds and verifies memory', async ({ page, noise }) => {
    await page.goto('/memory');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Add memory' }).click();
    const title = `E2E decision ${Date.now()}`;
    await page.getByLabel('Title', { exact: true }).fill(title);
    await page.getByLabel('Content', { exact: true }).fill('Use Postgres for everything.');
    await page.getByRole('button', { name: 'Save memory' }).click();
    const row = page.getByRole('button').filter({ hasText: title }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText('Verified', { exact: true })).toBeVisible();
    // Proposed entries come from agents only and are real data: show them, never verify them.
    const review = page.getByRole('button', { name: 'Review now' });
    if (await review.isVisible()) {
      await review.click();
      await expect(page.getByRole('button').filter({ hasText: 'Needs review' }).first()).toBeVisible();
    }
    expectQuiet(noise);
  });

  authed('compact nav below the sidebar breakpoint', async ({ page, noise }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeHidden();
    await expect(page.getByRole('navigation', { name: 'Primary (compact)' })).toBeVisible();
    expectQuiet(noise);
  });
});

test('login page is quiet when logged out', async ({ page, noise }) => {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button', { name: /log in|create the owner account/i })).toBeVisible();
  expectQuiet(noise);
});

authed('a new browser gets the simple view: the assistant as home and four pages, until the owner asks for all of them', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.getItem('e2e.simple') ?? (localStorage.setItem('office.simple', '1'), sessionStorage.setItem('e2e.simple', '1')));
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Primary', exact: true });
  await expect(page.getByRole('heading', { name: 'What would you like to get done?' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Assistant' })).toBeVisible();
  // one place to ask: the page with a request box of its own is not in the menu, and the team is a page, not a list under it
  await expect(nav.getByRole('link', { name: 'My work' })).toHaveCount(0);
  await expect(page.getByRole('complementary').locator('a[href^="/agents/"]')).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Workers' })).toBeHidden();
  await page.getByRole('button', { name: 'Show all pages' }).click();
  await expect(nav.getByRole('link', { name: 'Workers' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

authed('the office page switches between floor, list and timeline', async ({ page, noise }) => {
  await page.goto('/office');
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.getByRole('button', { name: 'Reset zoom' })).toHaveText('125%');
  await page.getByRole('button', { name: 'Reset zoom' }).click();
  await expect(page.getByRole('button', { name: 'Reset zoom' })).toHaveText('100%');
  await page.getByRole('radio', { name: 'List' }).click();
  await expect(page.getByRole('table', { name: 'Team' })).toBeVisible();
  await page.getByRole('radio', { name: 'Timeline' }).click();
  await expect(page.getByRole('heading', { name: 'Timeline' }).or(page.getByText('Timeline', { exact: true }).first())).toBeVisible();
  await page.getByRole('radio', { name: 'Floor' }).click();
  await expect(page.getByRole('table', { name: 'Team' })).toBeHidden();
  expectQuiet(noise);
});

authed('with no project left, the tab row still opens a folder as a project', async ({ page }) => {
  await page.route(`${API}/projects`, (route) => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
  await page.goto('/workers');
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Open folder…' }).click();
  await expect(page.getByRole('dialog').getByText('Choose a folder', { exact: true })).toBeVisible();
});

authed('a folder of this computer is opened as a project from the tab row; opening it again only brings its tab back', async ({ page, request }) => {
  const dir = mkdtempSync(join(tmpdir(), 'office-e2e-open-'));
  const name = basename(dir);
  const mine = async () => ((await (await request.get(`${API}/projects`)).json()) as { id: string; repoPath: string }[]).filter((p) => p.repoPath === dir);
  try {
    await page.route(`${API}/browse**`, (route) => route.fulfill({ json: { path: dir, parent: null, isRepo: false, dirs: [], roots: [] } }));
    await page.goto('/conductor');
    const tabs = page.getByRole('navigation', { name: 'Projects' });
    const pick = async () => {
      await tabs.getByRole('button', { name: 'Open folder…' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Use this folder' }).click();
    };
    await pick();
    // the project is named by its folder and its tab comes to the front
    const tab = tabs.getByRole('button', { name, exact: true });
    await expect(tab).toHaveAttribute('aria-current', 'true');
    expect(await mine()).toHaveLength(1);
    // closed, then the same folder again: its tab comes back and no second project is made
    await tabs.getByRole('button', { name: `Close ${name}` }).click();
    await expect(tab).toHaveCount(0);
    await pick();
    await expect(tab).toHaveAttribute('aria-current', 'true');
    expect(await mine()).toHaveLength(1);
  } finally {
    for (const p of await mine()) await request.delete(`${API}/projects/${p.id}`);
    rmSync(dir, { recursive: true, force: true });
  }
});

authed('a folder that does not exist yet is named in the folder picker, made, and opened as a project', async ({ page, request }) => {
  const dir = mkdtempSync(join(tmpdir(), 'office-e2e-new-'));
  const made = join(dir, 'fresh-idea');
  const mine = async () => ((await (await request.get(`${API}/projects`)).json()) as { id: string; repoPath: string }[]).filter((p) => p.repoPath === made);
  try {
    await page.route(`${API}/browse**`, (route) => route.fulfill({ json: { path: dir, parent: null, isRepo: false, dirs: [], roots: [] } }));
    await page.goto('/conductor');
    const tabs = page.getByRole('navigation', { name: 'Projects' });
    await tabs.getByRole('button', { name: 'Open folder…' }).click();
    const dialog = page.getByRole('dialog');
    // with a name typed, the button makes that folder inside the one shown
    await expect(dialog.getByRole('button', { name: 'Use this folder' })).toBeVisible();
    await dialog.getByLabel('New folder name').fill('fresh-idea');
    await dialog.getByRole('button', { name: 'Make new folder' }).click();
    await expect(tabs.getByRole('button', { name: 'fresh-idea', exact: true })).toHaveAttribute('aria-current', 'true');
    expect(await mine()).toHaveLength(1);
    // a repository of its own, with the starter notes every agent reads first
    expect(existsSync(join(made, '.git'))).toBe(true);
    expect(existsSync(join(made, 'CLAUDE.md'))).toBe(true);
    // the name is not kept for the next folder
    await tabs.getByRole('button', { name: 'Open folder…' }).click();
    await expect(dialog.getByLabel('New folder name')).toHaveValue('');
  } finally {
    for (const p of await mine()) await request.delete(`${API}/projects/${p.id}`);
    rmSync(dir, { recursive: true, force: true });
  }
});

authed('projects are tabs: + opens a new tab with a talk of its own, × closes a tab, and a closed project or talk comes back from a new tab', async ({ page, request, noise }) => {
  const [project] = (await (await request.get(`${API}/projects`)).json()) as { id: string; name: string }[];
  await page.goto('/conductor');
  const tabs = page.getByRole('navigation', { name: 'Projects' });
  const thread = page.getByRole('region', { name: 'Thread' });
  const projectTab = tabs.getByRole('button', { name: project.name, exact: true });
  const newTab = tabs.getByRole('button', { name: 'New', exact: true });
  // every project has its tab; the selected one is in front, with the work asked there
  await expect(projectTab).toHaveAttribute('aria-current', 'true');
  await expect(page.getByText('Missions it opened')).toBeVisible();
  // the owner names a tab: a project's tab gives the project that name
  const rename = async (from: string, to: string) => {
    await tabs.getByRole('button', { name: `Rename ${from}` }).click();
    await page.getByLabel('Tab name').fill(to);
    await page.getByLabel('Tab name').press('Enter');
  };
  await rename(project.name, 'Renamed by e2e');
  await expect(tabs.getByRole('button', { name: 'Renamed by e2e', exact: true })).toHaveAttribute('aria-current', 'true');
  expect(((await (await request.get(`${API}/projects`)).json()) as { id: string; name: string }[]).find((p) => p.id === project.id)?.name).toBe('Renamed by e2e');
  await rename('Renamed by e2e', project.name);
  await expect(projectTab).toHaveAttribute('aria-current', 'true');

  // + opens a new tab in front: no project yet, and a talk that starts empty
  const opened = () => page.waitForResponse((r) => r.url() === `${API}/conductor/tabs` && r.request().method() === 'POST').then((r) => r.json() as Promise<{ conversationId: string }>);
  const talk = (id: string) => request.get(`${API}/conductor?conversation=${id}`).then((r) => r.status());
  const first = opened();
  await tabs.getByRole('button', { name: 'New tab' }).click();
  await expect(newTab).toHaveAttribute('aria-current', 'true');
  await expect(projectTab).not.toHaveAttribute('aria-current', 'true');
  await expect(page.getByText('Or open a project')).toBeVisible();
  const said = `Only in the new tab ${Date.now()}`;
  await page.getByLabel('Message').fill(said);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(thread.getByText(said)).toBeVisible();
  // once something is said in it, the tab is named by how the owner began
  const talkTab = tabs.getByRole('button', { name: said, exact: true });
  await expect(talkTab).toHaveAttribute('aria-current', 'true');
  await expect(newTab).toHaveCount(0);
  // the project's tab has its own talk: what was said in the new tab is not there
  await projectTab.click();
  await expect(page.getByText('Missions it opened')).toBeVisible();
  await expect(thread.getByText(said)).toHaveCount(0);
  await talkTab.click();
  await expect(thread.getByText(said)).toBeVisible();
  // every other page shows the selected project, so there its tab is the one in front; the new tab leads back to the assistant
  await page.goto('/workers');
  await expect(projectTab).toHaveAttribute('aria-current', 'true');
  await talkTab.click();
  await expect(page).toHaveURL(/\/conductor$/);
  await expect(talkTab).toHaveAttribute('aria-current', 'true');

  // × closes the project's tab, and it stays closed after a reload; the project itself is still there
  // (the row counts the closed tabs; talks left by earlier runs are among them)
  const closedTabs = tabs.getByRole('button', { name: /^Closed tabs \(\d+\)$/ });
  const closedCount = async () => ((await closedTabs.count()) ? Number(/\((\d+)\)/.exec((await closedTabs.getAttribute('aria-label'))!)![1]) : 0);
  const before = await closedCount();
  await tabs.getByRole('button', { name: `Close ${project.name}` }).click();
  await expect(projectTab).toHaveCount(0);
  await expect.poll(closedCount).toBe(before + 1);
  await page.reload();
  await expect(talkTab).toHaveAttribute('aria-current', 'true');
  await expect(projectTab).toHaveCount(0);
  expect(((await (await request.get(`${API}/projects`)).json()) as { id: string }[]).map((p) => p.id)).toContain(project.id);
  // the tab row says how many tabs are closed and lists them: picking one brings its tab back, in front
  await closedTabs.click();
  await page.getByRole('dialog').getByRole('button', { name: project.name, exact: true }).click();
  await expect(projectTab).toHaveAttribute('aria-current', 'true');
  await expect.poll(closedCount).toBe(before);

  // × on the talk closes its tab; what was said is kept, and the next new tab lists it, to open it again
  await tabs.getByRole('button', { name: `Close ${said}` }).click();
  await expect(talkTab).toHaveCount(0);
  await expect(projectTab).toHaveAttribute('aria-current', 'true');
  const unused = opened();
  await tabs.getByRole('button', { name: 'New tab' }).click();
  await expect(newTab).toHaveAttribute('aria-current', 'true');
  await page.getByRole('button', { name: said, exact: true }).click();
  await expect(talkTab).toHaveAttribute('aria-current', 'true');
  await expect(thread.getByText(said)).toBeVisible();
  expect(await talk((await first).conversationId)).toBe(200);
  // a new tab can be named too, and keeps the name after a reload; nothing was said in it, so closing it leaves nothing behind
  await newTab.click();
  await rename('New', 'My idea');
  const named = tabs.getByRole('button', { name: 'My idea', exact: true });
  await expect(named).toHaveAttribute('aria-current', 'true');
  await page.reload();
  await expect(named).toHaveAttribute('aria-current', 'true');
  await tabs.getByRole('button', { name: 'Close My idea' }).click();
  await expect.poll(async () => talk((await unused).conversationId)).toBe(404);
  await tabs.getByRole('button', { name: `Close ${said}` }).click();
  await expect(talkTab).toHaveCount(0);
  expectQuiet(noise);
});

authed('while the project list loads, the assistant waits instead of saying no tab is open, and + already opens a tab', async ({ page }) => {
  await page.route(`${API}/projects`, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.goto('/conductor');
  await expect(page.getByText('Loading…').first()).toBeVisible();
  await expect(page.getByText('No tab is open')).toHaveCount(0);
  await page.getByRole('button', { name: 'New tab' }).click();
  await expect(page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'New', exact: true })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByText('Or open a project')).toBeVisible();
  await page.getByRole('button', { name: 'Close New' }).click();
});

authed('in a phone-width window the example requests of a new tab stay inside their card', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('office.simple', '1'));
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New tab' }).click();
  const example = page.getByRole('button', { name: /^Make a simple web page/ });
  await expect(example).toBeVisible();
  const [box, card] = [(await example.boundingBox())!, (await page.getByLabel('Message').boundingBox())!];
  expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 1);
  await page.getByRole('button', { name: 'Close New' }).click();
});

authed('skill library: every skill says who it comes from, and the filter finds a plugin by its name', async ({ page, noise }) => {
  const at = new Date().toISOString();
  const skill = (name: string, source: string, sourceRef: string | null) => ({
    id: name, name, description: `does ${name}`, source, sourceRef, status: 'approved', currentVersionId: `${name}-v1`, createdAt: at,
    currentVersion: { id: `${name}-v1`, version: 1, checksum: 'x', createdAt: at }, model: null, usedBy: [],
  });
  await page.route(`${API}/skills`, (route) =>
    route.fulfill({
      json: [
        skill('brainstorming', 'local', '/home/o/.claude/plugins/cache/claude-plugins-official/superpowers/7.0.0/skills/brainstorming'),
        skill('graphify', 'local', '/home/o/.claude/skills/graphify'),
        skill('house-style', 'ui', null),
      ],
    }),
  );
  await page.goto('/skills');
  const row = (name: string) => page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });
  await expect(page.getByRole('columnheader', { name: 'By', exact: true })).toBeVisible();
  await expect(row('brainstorming').getByRole('cell', { name: 'superpowers', exact: true })).toBeVisible();
  await expect(row('graphify').getByRole('cell', { name: 'Your Claude skills', exact: true })).toBeVisible();
  await expect(row('house-style').getByRole('cell', { name: 'You', exact: true })).toBeVisible();
  await page.getByLabel('Filter skills').fill('superpowers');
  await expect(page.getByRole('link', { name: 'brainstorming', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'graphify', exact: true })).toHaveCount(0);
  expectQuiet(noise);
});

authed('owner changes the check command and sees it saved', async ({ page, noise }) => {
  await page.goto('/settings');
  const input = page.getByLabel('Check command');
  const value = `node --test # e2e ${Date.now()}`;
  await input.fill(value);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Check command')).toHaveValue(value);
  expectQuiet(noise);
});

authed('audit: rows render, action filter narrows, load older appends', async ({ page, noise }) => {
  const row = (i: number, action: string) => ({
    id: `a${i}`,
    createdAt: new Date(Date.UTC(2026, 10, 1, 12, 0, 59 - i)).toISOString(),
    userId: null,
    action,
    targetType: 'task',
    targetId: `t${i}`,
    detail: { n: i, html: '<b>x</b>' },
  });
  // a full page (50 rows) so the cursor is offered; two actions alternate
  const first = Array.from({ length: 50 }, (_, i) => row(i, i % 2 ? 'task.cancel' : 'task.create'));
  const older = [row(50, 'task.create')];
  await page.route(`${API}/audit*`, (route) => {
    const q = new URL(route.request().url()).searchParams;
    const rows = q.get('before') ? older : first;
    return route.fulfill({ json: rows.filter((r) => !q.get('action') || r.action === q.get('action')) });
  });
  await page.goto('/audit');
  const rows = page.getByRole('row');
  await expect(rows).toHaveCount(51); // header + 50
  await expect(page.getByText('<b>x</b>').first()).toBeVisible(); // detail is text, not HTML
  await page.getByLabel('Action').selectOption('task.cancel');
  await expect(rows).toHaveCount(26);
  await page.getByLabel('Action').selectOption('');
  await expect(rows).toHaveCount(51);
  await page.getByRole('button', { name: 'Load older' }).click();
  await expect(rows).toHaveCount(52);
  await expect(page.getByRole('button', { name: 'Load older' })).toHaveCount(0);
  expectQuiet(noise);
});

authed('claude cli sessions: grouped by project and folder, read-only transcript, open in terminal', async ({ page, request: api, noise }) => {
  const [project] = (await (await api.get(`${API}/projects`)).json()) as { id: string; name: string; repoPath: string }[];
  const now = Date.now();
  const w = { workerId: 'w-fixture', workerName: 'dev-laptop', local: true };
  const mine = { ...w, sessionId: 'cli-aaaa-1111', title: 'Fix the login form', cwd: project.repoPath, gitBranch: 'main', createdAt: now - 7200_000, lastModified: now - 60_000, projectId: project.id };
  const other = { ...w, sessionId: 'cli-bbbb-2222', title: 'Scratch notes', cwd: '/tmp/office-e2e/elsewhere', lastModified: now - 300_000, live: { pid: 4242, kind: 'interactive', status: 'busy' }, projectId: null };
  const bg = { ...w, sessionId: 'cli-dddd-4444', title: 'Nightly refactor', cwd: project.repoPath, lastModified: now - 120_000, live: { pid: 4343, kind: 'background', state: 'running', id: 'cli-dddd', name: 'nightly' }, projectId: project.id };
  await page.route(`${API}/claude-sessions`, (route) => route.fulfill({ json: { sessions: [mine, other, bg] } }));
  await page.route(`${API}/claude-sessions/cli-aaaa-1111/messages?**`, (route) =>
    route.fulfill({ json: { kind: 'messages', entries: [{ uuid: 'u1', role: 'user', text: 'please fix the login form', tools: [] }, { uuid: 'a1', role: 'assistant', text: 'On it.', tools: ['Read', 'Edit'] }], nextOffset: null } }),
  );
  await page.route(`${API}/claude-sessions/cli-bbbb-2222/messages?**`, (route) => route.fulfill({ json: { kind: 'messages', entries: [], nextOffset: null } }));
  await page.route(`${API}/claude-sessions/cli-dddd-4444/messages?**`, (route) => route.fulfill({ json: { kind: 'messages', entries: [], nextOffset: null } }));
  await page.route(`${API}/claude-sessions/background/cli-dddd/stop`, (route) => route.fulfill({ json: { kind: 'background', output: 'stopped cli-dddd\n' } }));
  await page.route(`${API}/claude-sessions/background/cli-dddd/logs`, (route) => route.fulfill({ json: { kind: 'background', output: 'Claude Code v2\n❯ refactor the nightly job' } }));
  let renamed = '';
  await page.route(`${API}/claude-sessions/cli-aaaa-1111/rename`, async (route) => {
    renamed = (route.request().postDataJSON() as { title: string }).title;
    await route.fulfill({ json: { kind: 'rename' } });
  });
  await page.route(`${API}/claude-sessions/cli-bbbb-2222?**`, (route) => route.fulfill({ json: { kind: 'delete' } }));
  await page.route(`${API}/claude-sessions/cli-aaaa-1111/open`, (route) => route.fulfill({ json: { kind: 'open', terminal: 'kitty' } }));
  await page.goto('/sessions');
  await page.waitForLoadState('networkidle');

  const card = page.getByRole('region', { name: project.name });
  await expect(card.getByRole('button', { name: /Fix the login form/ })).toBeVisible();
  const folder = page.getByRole('region', { name: '/tmp/office-e2e/elsewhere' });
  await expect(folder.getByText('running')).toBeVisible();
  await expect(folder.getByRole('button', { name: 'Add as project' })).toBeVisible();

  await card.getByRole('button', { name: /Fix the login form/ }).click();
  const transcript = page.getByRole('list', { name: 'Transcript' });
  await expect(transcript.getByText('please fix the login form')).toBeVisible();
  await expect(transcript.getByText('Edit', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0); // no message box for an external session
  await page.getByRole('button', { name: 'Open in terminal' }).click();
  await expect(page.getByRole('status')).toHaveText('Opened in kitty.');

  await folder.getByRole('button', { name: /Scratch notes/ }).click();
  await expect(page.getByRole('button', { name: 'Open in terminal' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Resume here' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Fork here' })).toBeEnabled();

  // a background session: attach and stop instead of resume; the filter and the search narrow the list
  const cliFilter = page.getByRole('radiogroup', { name: 'Filter Claude sessions' });
  await cliFilter.getByRole('radio', { name: 'Background' }).click();
  await expect(card.getByRole('button', { name: /Nightly refactor/ })).toBeVisible();
  await expect(card.getByRole('button', { name: /Fix the login form/ })).toHaveCount(0);
  await card.getByRole('button', { name: /Nightly refactor/ }).click();
  await expect(page.getByRole('button', { name: 'Attach here' })).toBeVisible();
  await page.getByRole('button', { name: 'Logs' }).click();
  await expect(page.getByText('refactor the nightly job')).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('stopped cli-dddd');
  await cliFilter.getByRole('radio', { name: 'All' }).click();
  await page.getByLabel('Search sessions').fill('scratch');
  await expect(card).toHaveCount(0);
  await expect(folder.getByRole('button', { name: /Scratch notes/ })).toBeVisible();
  await page.getByLabel('Search sessions').fill('');
  await folder.getByRole('button', { name: 'Add as project' }).click();
  await expect(page.getByRole('dialog').getByLabel('Repository path')).toHaveValue('/tmp/office-e2e/elsewhere');
  await expect(page.getByRole('dialog').getByLabel('Slug')).toHaveValue('elsewhere');
  expectQuiet(noise);
});

authed('manual sessions: an exited Office terminal is listed and shown, with its session resumable', async ({ page, request: api, noise }) => {
  const [project] = (await (await api.get(`${API}/projects`)).json()) as { id: string; name: string; repoPath: string }[];
  const term = { id: 'term-fixture', projectId: project.id, dir: project.repoPath, workerId: 'w', claudeSessionId: 'cli-cccc-3333', status: 'exited', exitCode: 0, startedAt: new Date(Date.now() - 600_000).toISOString(), exitedAt: new Date().toISOString() };
  await page.route(`${API}/terminals`, (route) => route.fulfill({ json: [term] }));
  await page.route(`${API}/claude-sessions`, (route) => route.fulfill({ json: { sessions: [] } }));
  await page.goto('/sessions');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button', { name: 'New manual session' })).toBeVisible();
  const manual = page.getByRole('region', { name: 'Manual sessions' });
  await manual.getByRole('button', { name: new RegExp(project.name) }).click();
  await expect(page.getByText('Manual session', { exact: true })).toBeVisible();
  await expect(page.getByText('exited · exit 0')).toBeVisible();
  await expect(page.getByRole('application', { name: 'Terminal' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  expectQuiet(noise);
});

// a real manual session through the local worker: only with a worker connected (OFFICE_E2E_REAL_TERMINAL=1)
authed('manual sessions: a real claude runs in the Office terminal and its exit is shown', async ({ page }) => {
  authed.skip(!process.env.OFFICE_E2E_REAL_TERMINAL, 'needs a local worker with claude; set OFFICE_E2E_REAL_TERMINAL=1');
  await page.goto('/sessions');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'New manual session' }).click();
  const manual = page.getByRole('region', { name: 'Manual sessions' });
  await expect(manual.getByText('running')).toBeVisible({ timeout: 15_000 });
  const term = page.getByRole('application', { name: 'Terminal' });
  await expect(term.locator('.xterm-rows')).toContainText(/Claude|trust|❯|>/, { timeout: 30_000 });
  await term.click();
  // whatever Claude asks first (folder trust or the prompt), Ctrl+C twice ends it
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+C');
  await expect(manual.getByText('exited')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(manual).toHaveCount(0);
});

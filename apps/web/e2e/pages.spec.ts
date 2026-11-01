import { API, authed, expect, expectQuiet, test } from './fixtures';

const STATIC = ['/', '/mission-control', '/sessions', '/conversations', '/agents', '/skills', '/memory', '/workers', '/audit', '/settings', '/tasks/new'];

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
    await expect(attention.filter({ hasText: 'e2e-testing' }).getByRole('link', { name: 'Review import' })).toBeVisible();
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
      taskTitle: 'Login form', workerName: 'dev-laptop', startedAt: at(0), costUsd: 0.09, commands: 2, files: 2, subagents: [sub],
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

    await expect(page.getByText('Delivered at the next run boundary')).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Recipient' }).getByRole('radio')).toHaveText([agent.name]);

    page.on('dialog', (d) => void d.accept());
    const refetch = page.waitForRequest((r) => r.url() === `${API}/sessions/run-fixture`);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Session already ended' })).toBeVisible();
    await refetch;
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
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
      const fixture = { id: 'w-fixture', name: 'e2e-remote', status: 'online', capacity: 2, allowedRoots: [], tags: ['gpu'], canClone: true, lastHeartbeatAt: new Date().toISOString(), online: true, activeRuns: 1 };
      await route.fulfill({ json: [...real, fixture] });
    });
    await page.goto('/workers');
    const pending = page.getByRole('row').filter({ hasText: name });
    await expect(pending.getByText('Pending')).toBeVisible();
    const remote = page.getByRole('row').filter({ hasText: 'e2e-remote' });
    await expect(remote.getByText('remote', { exact: true })).toBeVisible();
    await expect(remote.getByText('gpu', { exact: true })).toBeVisible();
    await expect(remote.getByText('1/2')).toBeVisible();
    expectQuiet(noise);
  });

  authed('owner messages an agent', async ({ page, noise }) => {
    await page.goto('/conversations');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Message an agent' }).click();
    const select = page.getByLabel('Agent', { exact: true });
    await select.selectOption({ index: 0 });
    const agentName = (await select.locator('option').first().textContent())?.trim();
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

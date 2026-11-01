import { API, authed, expect, expectQuiet, test } from './fixtures';

const STATIC = ['/', '/mission-control', '/conversations', '/agents', '/skills', '/memory', '/workers', '/settings', '/tasks/new'];

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

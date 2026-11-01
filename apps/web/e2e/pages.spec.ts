import { API, authed, expect, expectQuiet, test } from './fixtures';

const STATIC = ['/', '/mission-control', '/conversations', '/agents', '/skills', '/memory', '/workers', '/tasks/new'];

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

    const tasks = (await (await request.get(`${API}/tasks`)).json()) as { id: string; title: string }[];
    if (tasks.length >= 2) {
      const node = page.getByRole('button', { name: new RegExp(tasks[0].id.slice(0, 8)) });
      await node.click();
      await expect(node).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByText(tasks[0].id.slice(0, 8), { exact: true }).first()).toBeVisible();
    }
    expectQuiet(noise);
  });

  authed('owner messages an agent', async ({ page, noise }) => {
    await page.goto('/conversations');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Message an agent' }).click();
    const select = page.getByLabel('Agent', { exact: true });
    await select.selectOption({ index: 0 });
    await page.getByRole('button', { name: 'Start conversation' }).click();
    await page.getByLabel('Message', { exact: true }).fill('Hello from e2e');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('article').filter({ hasText: 'Hello from e2e' })).toBeVisible();
    await expect(page.getByText('Saved · delivers at the next session boundary').first()).toBeVisible();
    expectQuiet(noise);
  });

  authed('owner adds and verifies memory', async ({ page, noise }) => {
    await page.goto('/memory');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Add memory' }).click();
    await page.getByLabel('Title', { exact: true }).fill('E2E decision');
    await page.getByLabel('Content', { exact: true }).fill('Use Postgres for everything.');
    await page.getByRole('button', { name: 'Save memory' }).click();
    const row = page.getByRole('button').filter({ hasText: 'E2E decision' }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText('Verified', { exact: true })).toBeVisible();
    // Proposed entries come from agents only; exercise the review flow when one exists.
    const review = page.getByRole('button', { name: 'Review now' });
    if (await review.isVisible()) {
      await review.click();
      await page.getByRole('button').filter({ hasText: 'Needs review' }).first().click();
      await page.getByRole('button', { name: 'Verify', exact: true }).click();
      await expect(page.getByText('Verified by you')).toBeVisible();
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

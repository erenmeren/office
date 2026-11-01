import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/app.js';
import { createRun, createRunForTask } from '../src/services/run-service.js';
import { makeApp } from './helpers.js';

const md = (name: string, body = 'body') => `---\nname: ${name}\ndescription: does ${name}\n---\n${body}\n`;

describe('run spec skills and subagents', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let cookie: string;
  let projectId: string;
  let workerId: string;
  const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL_TEST });
  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    t.app.inject({ method, url, headers: { cookie }, payload });

  beforeAll(async () => {
    t = await makeApp();
    cookie = await t.login();
    projectId = (await req('POST', '/projects', { name: 'P', slug: 'p', repoPath: '/tmp/office-ws/p' })).json().id;
    workerId = (await req('POST', '/workers', { name: 'w' })).json().id;
  });
  afterAll(() => t.close());

  const setup = async (slug: string) => {
    const eager = (await req('POST', '/skills', { name: `${slug}-eager`, files: { 'SKILL.md': md(`${slug}-eager`) } })).json();
    const lazy = (await req('POST', '/skills', { name: `${slug}-lazy`, files: { 'SKILL.md': md(`${slug}-lazy`), 'ref.md': 'r' } })).json();
    const base = { systemPrompt: 'be nice', model: 'sonnet', allowedTools: ['Read'] };
    const agent = (
      await req('POST', '/agents', {
        name: slug, slug, role: 'dev',
        config: {
          ...base,
          // reverse name order on input: the spec and snapshot are ordered by skill name
          skills: [{ skillId: lazy.id }, { skillId: eager.id, mode: 'eager' }],
          subagents: [{ name: 'helper', description: 'helps', prompt: 'help', skills: [`${slug}-lazy`] }],
        },
      })
    ).json();
    const task = await t.prisma.task.create({
      data: { projectId, agentId: agent.id, title: 'Do it', description: 'details', status: 'ready' },
    });
    const { spec, session } = await createRunForTask(t.prisma, t.app.hub, task, { workerId, local: () => true }, config);
    return { eager, lazy, agent, base, spec, session };
  };

  it('run spec carries pinned skill files, subagents and the skill prompt section; session snapshot matches the pins', async () => {
    const { eager, lazy, spec, session } = await setup('s1');
    expect(spec.systemPrompt).toMatch(
      'be nice\n\nBefore doing anything else, invoke the Skill tool for each of these skills and follow them: s1-eager.' +
        '\n\nThese skills are available when relevant: s1-lazy.',
    );
    expect(spec.skills.map((s) => [s.name, s.version, s.mode])).toEqual([
      ['s1-eager', 1, 'eager'],
      ['s1-lazy', 1, 'on_demand'],
    ]);
    expect(spec.skills[1]!.files).toEqual({ 'SKILL.md': md('s1-lazy'), 'ref.md': 'r' });
    expect(spec.skills[0]!.checksum).toBe(eager.currentVersion.checksum);
    expect(spec.subagents).toEqual([{ name: 'helper', description: 'helps', prompt: 'help', skills: ['s1-lazy'] }]);
    const stored = await t.prisma.agentSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(stored.skillsSnapshot).toEqual([
      {
        skillId: eager.id, skillVersionId: eager.currentVersion.id, name: 's1-eager',
        version: 1, checksum: eager.currentVersion.checksum, mode: 'eager',
      },
      {
        skillId: lazy.id, skillVersionId: lazy.currentVersion.id, name: 's1-lazy',
        version: 1, checksum: lazy.currentVersion.checksum, mode: 'on_demand',
      },
    ]);
  });

  it('editing the agent after the run was created does not change the run spec or the snapshot', async () => {
    const { agent, base, session } = await setup('s2');
    const before = await t.prisma.agentSession.findUniqueOrThrow({ where: { id: session.id } });
    const put = await req('PUT', `/agents/${agent.id}`, { config: base });
    expect(put.json().currentVersion).toMatchObject({ version: 2, skills: [], subagents: [] });
    const after = await t.prisma.agentSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(after.skillsSnapshot).toEqual(before.skillsSnapshot);
    expect((after.skillsSnapshot as Array<{ name: string }>).map((s) => s.name)).toEqual(['s2-eager', 's2-lazy']);
    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: session.runId } });
    expect(run.agentVersionId).toBe(agent.currentVersion.id);
  });

  it('every run kind carries the project approval policy and timeout', async () => {
    await req('PUT', `/projects/${projectId}/settings`, {
      approvalTimeoutMinutes: 7,
      approvalPolicy: { destructivePatterns: ['rm -rf', 'git commit'], sensitivePaths: ['.env.local'] },
    });
    const agent = (
      await req('POST', '/agents', { name: 'pol', slug: 'pol', role: 'dev', config: { systemPrompt: 'x', model: 'sonnet', allowedTools: ['Read'] } })
    ).json();
    const task = await t.prisma.task.create({ data: { projectId, agentId: agent.id, title: 'T', description: 'd', status: 'ready' } });
    const specs = [(await createRunForTask(t.prisma, t.app.hub, task, { workerId, local: () => true }, config)).spec];
    for (const kind of ['chat', 'inbox', 'plan', 'review'] as const) {
      specs.push((await createRun(t.prisma, t.app.hub, config, { kind, agentId: agent.id, projectId, prompt: 'p', worker: { workerId } })).spec);
    }
    expect(specs.map((s) => s.kind)).toEqual(['task', 'chat', 'inbox', 'plan', 'review']);
    for (const s of specs) {
      expect(s.approvalPolicy).toMatchObject({ destructivePatterns: ['rm -rf', 'git commit'], sensitivePaths: ['.env.local'] });
      expect(s.approvalTimeoutMinutes).toBe(7);
    }
  });
});

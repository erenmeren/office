import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ models: undefined as unknown, closed: 0, calls: [] as { prompt: unknown; options: Record<string, unknown> }[] }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: unknown; options: Record<string, unknown> }) => {
    h.calls.push(params);
    return {
      supportedModels: () => (h.models instanceof Error ? Promise.reject(h.models) : h.models === undefined ? new Promise(() => undefined) : Promise.resolve(h.models)),
      close: () => void h.closed++,
    };
  },
}));

const { claudeModels } = await import('./models.js');

beforeEach(() => {
  h.models = undefined;
  h.closed = 0;
  h.calls = [];
});

describe('claudeModels', () => {
  it("lists what this login's Claude offers, without the nameless default, and closes the session", async () => {
    h.models = [
      { value: 'default', displayName: 'Default (recommended)', description: 'Fable 5.2' },
      { value: 'claude-fable-5-2', displayName: 'Fable 5.2', description: 'For your toughest challenges' },
      { value: 'fable', displayName: 'Fable 5.1', description: 'Most capable' },
    ];
    expect(await claudeModels({ OFFICE_SECRET: 'x', PATH: '/bin' })).toEqual([
      { value: 'claude-fable-5-2', label: 'Fable 5.2', description: 'For your toughest challenges' },
      { value: 'fable', label: 'Fable 5.1', description: 'Most capable' },
    ]);
    expect(h.closed).toBe(1);
    // no prompt is sent, and the session gets neither Office's secrets nor a project's settings
    expect(h.calls[0]!.options).toMatchObject({ settingSources: [], env: { PATH: '/bin' } });
    expect((h.calls[0]!.options.env as Record<string, string>).OFFICE_SECRET).toBeUndefined();
  });

  it('answers with no models when the CLI fails or does not answer in time', async () => {
    h.models = new Error('not logged in');
    expect(await claudeModels({}, 50)).toEqual([]);
    h.models = undefined; // never answers
    expect(await claudeModels({}, 50)).toEqual([]);
    expect(h.closed).toBe(2);
  });
});

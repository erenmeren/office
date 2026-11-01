/** The FakeAdapter's plan: a developer commits a passing node:test file, QA reviews it. */
export const FAKE_PLAN = {
  summary: 'fake plan',
  tasks: [
    {
      key: 'a',
      title: 'Write the sum test',
      description:
        "COMMIT:sum.test.js:import test from 'node:test'; import assert from 'node:assert'; test('sum', () => assert.equal(1 + 1, 2));",
      kind: 'code',
      agent: 'developer',
      requirements: ['a passing node:test file'],
      acceptanceCriteria: ['node --test passes'],
    },
    {
      key: 'b',
      title: 'Review the sum test',
      description: 'review',
      kind: 'review',
      agent: 'qa-engineer',
      requirements: ['review a'],
      acceptanceCriteria: ['reviewed'],
      dependsOn: ['a'],
    },
  ],
  risks: [],
};

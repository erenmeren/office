import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  PLAN_JSON_SCHEMA,
  PlanSchema,
  PlanTaskSchema,
  REVIEW_JSON_SCHEMA,
  ReviewDecisionSchema,
  SAMPLE_PLAN,
  validatePlan,
  type Plan,
} from './plan.js';

const roster = [
  { slug: 'architect', active: true, system: false, allowed: true },
  { slug: 'developer', active: true, system: false, allowed: true },
  { slug: 'qa-engineer', active: true, system: false, allowed: true },
];
const task = (key: string, dependsOn: string[] = [], agent = 'developer') =>
  PlanTaskSchema.parse({
    key,
    title: key,
    description: key,
    kind: 'code',
    agent,
    requirements: ['r'],
    acceptanceCriteria: ['a'],
    dependsOn,
  });
const plan = (...tasks: ReturnType<typeof task>[]): Plan => ({ summary: 's', tasks, risks: [] });

describe('validatePlan', () => {
  it('accepts the sample plan', () => {
    expect(PlanSchema.parse(SAMPLE_PLAN)).toBeTruthy();
    const r = validatePlan(SAMPLE_PLAN, roster);
    expect(r.ok).toBe(true);
  });
  it('orders a chain topologically', () => {
    const r = validatePlan(plan(task('c', ['b']), task('b', ['a']), task('a')), roster);
    expect(r).toEqual({ ok: true, order: ['a', 'b', 'c'] });
  });
  it('reports a cycle path', () => {
    const r = validatePlan(plan(task('a', ['b']), task('b', ['a'])), roster);
    expect(r).toEqual({ ok: false, errors: ['dependency cycle: a -> b -> a'] });
  });
  it('reports duplicate keys and unknown dependencies', () => {
    const r = validatePlan(plan(task('a'), task('a', ['zz'])), roster);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) {
      expect(r.errors).toContain('duplicate task key a');
      expect(r.errors).toContain('task a depends on unknown task zz');
    }
  });
  it('reports agent problems', () => {
    const r = validatePlan(
      {
        ...plan(task('a', [], 'ghost'), task('b', [], 'off'), task('c', [], 'sys'), task('d', [], 'nope')),
      },
      [
        ...roster,
        { slug: 'off', active: false, system: false, allowed: true },
        { slug: 'sys', active: true, system: true, allowed: true },
        { slug: 'nope', active: true, system: false, allowed: false },
      ],
    );
    expect(r).toEqual({
      ok: false,
      errors: [
        'task a: unknown agent ghost',
        'task b: agent off is inactive',
        'task c: agent sys is a system agent',
        'task d: agent nope is not allowed in this project',
      ],
    });
  });
  it('reports unknown consultation agent', () => {
    const t = { ...task('a'), requiredConsultations: [{ agent: 'ghost', topic: 't' }] };
    expect(validatePlan(plan(t), roster)).toEqual({
      ok: false,
      errors: ['task a: consultation agent ghost unknown'],
    });
  });
});

describe('validatePlan edge cases', () => {
  it('tolerates duplicate dependsOn entries', () => {
    expect(validatePlan(plan(task('b', ['a', 'a']), task('a')), roster)).toEqual({ ok: true, order: ['a', 'b'] });
  });
  it('reports a self-dependency', () => {
    expect(validatePlan(plan(task('a', ['a'])), roster)).toEqual({ ok: false, errors: ['dependency cycle: a -> a'] });
  });
});

const requiredKeys = (shape: Record<string, unknown>) =>
  Object.entries(shape)
    .filter(([, v]) => !(v instanceof z.ZodDefault) && !(v instanceof z.ZodOptional))
    .map(([k]) => k)
    .sort();

describe('JSON schemas', () => {
  it('PLAN_JSON_SCHEMA is object-shaped and matches PlanTaskSchema keys', () => {
    expect(PLAN_JSON_SCHEMA.type).toBe('object');
    expect(PLAN_JSON_SCHEMA.required).toContain('tasks');
    const keys = Object.keys(PLAN_JSON_SCHEMA.properties.tasks.items.properties).sort();
    expect(keys).toEqual(Object.keys(PlanTaskSchema.shape).sort());
  });
  it('required lists equal the non-optional, non-defaulted Zod keys', () => {
    expect([...PLAN_JSON_SCHEMA.properties.tasks.items.required].sort()).toEqual(requiredKeys(PlanTaskSchema.shape));
    expect([...PLAN_JSON_SCHEMA.required].sort()).toEqual(requiredKeys(PlanSchema.shape));
    const reviewTask = ReviewDecisionSchema.shape.tasks.element;
    expect([...REVIEW_JSON_SCHEMA.properties.tasks.items.required].sort()).toEqual(requiredKeys(reviewTask.shape));
    expect([...REVIEW_JSON_SCHEMA.required].sort()).toEqual(requiredKeys(ReviewDecisionSchema.shape));
  });
  it('REVIEW_JSON_SCHEMA matches ReviewDecisionSchema keys', () => {
    expect(Object.keys(REVIEW_JSON_SCHEMA.properties).sort()).toEqual(Object.keys(ReviewDecisionSchema.shape).sort());
      });
});

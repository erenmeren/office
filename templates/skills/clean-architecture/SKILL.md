---
name: clean-architecture
description: Keep code organized by responsibility with dependencies pointing inward, without adding layers nobody needs.
---

# Clean architecture

Structure is there to make change cheap. Follow the structure the codebase already has;
improve it only where the task requires.

## When to use

- Designing where new code goes (module, layer, package).
- Reviewing a change that crosses module boundaries or adds dependencies between them.
- A change is hard because responsibilities are tangled.

## Steps

1. Map the existing structure. Use `Glob` to list packages and top-level folders, then
   `Read` entry points, package manifests and any architecture document. Write down the
   layers (for example: routes, services, data access, shared types) and which may import
   which.
2. Check dependency direction with `Grep` on import statements. Domain logic must not import
   from frameworks, transport or UI. Shared packages must not import from applications.
3. Place new code in the existing layer that owns the responsibility:
   - input parsing and validation at the boundary (route, handler, CLI);
   - business rules in services or domain modules, free of I/O where practical;
   - persistence behind the existing data access layer;
   - types and schemas shared across packages in the shared package.
4. One module, one reason to change. If a file mixes HTTP handling, business rules and SQL,
   separate them only as far as the task needs.
5. Prefer plain functions and data over classes and patterns. Introduce an interface only
   when there are two real implementations today (including a test fake).
6. Avoid speculative layers: no repository, factory or adapter that only forwards calls.
7. Keep side effects at the edges; pass dependencies (database client, clock, config) in as
   parameters so the core is testable.
8. When you must break a rule, do it in one place and note why in a one-line comment.
9. Run typecheck and tests with `Bash`; a cyclic import or a broken build is an
   architecture bug.

## Review checklist

- Does any import point from a lower layer to a higher one, or from shared code to an app?
- Is validation done once at the trust boundary?
- Is there a new abstraction with a single implementation and a single caller?
- Could a reader find this code by following the existing conventions?

## Done when

- New code sits in the layer that owns its responsibility, following existing conventions.
- No new upward or cyclic dependencies.
- No abstraction without a current second use.
- The report states where code was placed and why, and any boundary concerns found.

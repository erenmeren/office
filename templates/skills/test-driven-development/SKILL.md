---
name: test-driven-development
description: Write a failing test first, make it pass with the minimum code, then clean up, using the project's own test setup.
---

# Test-driven development

A test you did not see fail proves nothing. Red, green, refactor.

## When to use

- Implementing a feature or behavior change with non-trivial logic.
- Fixing a bug: reproduce it with a test before fixing it.
- Writing tests for code under review or for a QA verification.

## Steps

1. Find the test setup. `Glob` for `**/*.test.*`, `**/*.spec.*`, `tests/`, and read the
   test script in `package.json` (or `pyproject.toml`, `Makefile`). Read two nearby tests to
   copy their structure, helpers, fixtures and naming.
2. Write down the behaviors to cover as a short list: the main case, edge cases (empty,
   boundary, invalid input), and error paths that matter.
3. Red: write one test for the first behavior. Assert on observable behavior (return value,
   HTTP response, database row, rendered text), not on private internals.
4. Run only that test with `Bash` (for example `pnpm vitest run path -t "name"`,
   `pytest path::test_name`). Confirm it fails for the expected reason, not because of a
   typo or import error. Keep the failure output for your report.
5. Green: write the minimum production code that makes it pass. Run the test again.
6. Refactor: remove duplication in code and tests while staying green.
7. Repeat for the next behavior on the list.
8. Run the full test suite and the typecheck with `Bash` before finishing.

## Test quality rules

- One behavior per test; the test name states it ("rejects an expired token").
- Arrange, act, assert, in that order, with minimal setup.
- Use real collaborators where cheap (in-memory or test database, temp directories);
  mock only slow, external or non-deterministic boundaries (network, clock, randomness).
- Tests are independent: no order dependence, no shared mutable state, clean up what
  they create or scope assertions to what they created.
- No sleeps for synchronization; wait on conditions.
- A bug fix test fails on the old code and passes on the new.
- Do not weaken or delete an existing test to make a change pass; if a test is wrong,
  say why in the report.

## Done when

- Each new behavior has a test that you saw fail, then pass.
- The full suite and typecheck pass, and you ran them.
- The report includes the red and green evidence (command and the key output lines).

---
name: code-review
description: Review a change for correctness, safety, tests and unnecessary code, reading the connected code, and report findings by severity.
---

# Code review

Review the change and the code it touches, not only the diff lines.

## When to use

- Reviewing a task's diff before it is accepted.
- Reviewing your own change before reporting it done.
- Assessing a pull request or a branch against its requirements.

## Steps

1. Read the requirements and acceptance criteria first. Write down what the change must do.
2. Get the diff with `Bash`: `git diff <base>...HEAD --stat`, then the full diff. Read every
   changed file in full with `Read`, not just the hunks.
3. Follow the connections: `Grep` for callers of changed functions, implementations of
   changed interfaces, and uses of changed types or configuration.
4. Check, in this order:
   - Correctness: does it meet every requirement? Edge cases: empty, null, boundary,
     concurrency, error paths, partial failure.
   - Safety: input validation at trust boundaries, injection (SQL, shell, path), secrets in
     code or logs, authorization checks, data loss on failure.
   - Tests: do tests cover the new behavior and the bug being fixed? Would they fail on the
     old code? Were existing tests weakened?
   - Breakage: callers, migrations, public APIs, configuration and docs updated?
   - Necessity: code, options, abstractions or dependencies nobody asked for; dead code
     left behind; duplication of an existing helper.
   - Readability: names, structure, comments that explain why.
   - Performance: obviously quadratic loops, N+1 queries, unbounded memory on real data.
5. Run the checks yourself with `Bash` (test, typecheck, lint, build). Do not trust a
   claim of passing tests without output.
6. Write each finding as: `path:line`, severity (blocker, major, minor, nit), the problem,
   and a concrete fix. Do not pad with praise or restate the diff.
7. Distinguish facts from suspicions; say what you did not check.

## Severity guide

- Blocker: wrong behavior, data loss, security hole, failing checks, missing requirement.
- Major: missing test for non-trivial logic, broken caller, risky edge case.
- Minor: unneeded code, unclear naming, small duplication.
- Nit: style the linter does not enforce. Keep these few.

## Done when

- Every requirement is marked met or not met with evidence.
- Checks were run and their results quoted.
- Findings are listed by severity with locations and fixes, or the change is explicitly
  approved with the reasons.

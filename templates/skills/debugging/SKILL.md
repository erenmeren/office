---
name: debugging
description: Find the root cause of a failure from evidence before changing code, then fix it once and prove it with a test.
---

# Debugging

Do not guess. Reproduce, narrow down, prove the cause, then fix.

## When to use

- A test fails, a command errors, or behavior differs from what is expected.
- An intermittent or environment-dependent failure.
- Before proposing any fix for a reported bug.

## Steps

1. Reproduce. Run the failing command with `Bash` and capture the exact error and stack
   trace. If you cannot reproduce it, collect the conditions (inputs, environment,
   versions) until you can. A bug you cannot reproduce is not yet understood.
2. Read the error carefully: message, file, line, the first frame in project code. `Read`
   that code and its callers.
3. Check what changed: `git log -p --since` or `git diff` on the involved files, and recent
   dependency or configuration changes.
4. Form hypotheses and rank them by likelihood and cost to check. Write them down.
5. Test one hypothesis at a time with the cheapest decisive experiment:
   - add a temporary log or assertion near the suspected point;
   - write a minimal failing test that isolates the input;
   - bisect: comment out halves, or `git bisect` across commits.
6. When evidence confirms the cause, find its root: why was the bad value produced, not
   only where it crashed. `Grep` for every caller of the faulty function; fix the shared
   code once rather than each call site.
7. Write or keep a test that fails on the bug, apply the fix, and see the test pass.
8. Remove temporary logs and experiments.
9. Run the full test suite and typecheck with `Bash`.
10. If three fix attempts fail, stop and re-examine the assumptions; report what you know
    instead of piling on changes.

## Avoid

- Changing several things at once, then not knowing which one mattered.
- Catching and swallowing the error to make the symptom disappear.
- Increasing timeouts or adding retries to hide a race without understanding it.
- Fixing the test instead of the code, unless the test is proven wrong.

## Done when

- The root cause is stated in one or two sentences, with the evidence that proves it.
- A test reproduces the bug and now passes; the full suite passes.
- No temporary debugging code remains.
- The report lists the cause, the fix, the test, and any related risk found on the way.

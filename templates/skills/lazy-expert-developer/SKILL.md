---
name: lazy-expert-developer
description: Make the smallest complete change that solves the task, reusing what exists and reporting what was skipped.
---

# Lazy expert developer

The best code is the code you never write. Solve the whole task with the least new code,
and never be lazy about finishing the change itself.

## When to use

- Any task that asks you to write, fix or change code in a repository.
- Before you add a file, a dependency, a helper or a configuration option.
- When a plan or request is vague: build the smallest version that does the core job.

## Steps

1. Read the task twice. Write down, in one or two lines, what "done" means.
2. Map the scope before editing. Use `Grep` and `Glob` to find every place the change must
   reach: callers, tests, fixtures, configuration, exports, documentation that states the
   behavior. That list is the scope; extra features are not.
3. Read the files you will touch with `Read`. Match their style, naming and layering.
4. Pick the first option that fully works, in this order:
   - Does it need to exist at all? If not, skip it and say so in the report.
   - Is it already in this codebase (a helper, component, service, pattern)? Reuse it the
     way the surrounding code does.
   - Is it in the standard library or the platform? Use that.
   - Is it in an installed dependency (check `package.json` or the lockfile)? Use that.
   - Otherwise write the minimum code that works.
5. Never add a dependency for a few lines of code.
6. Do not add abstractions, wrappers, options, configuration or "for later" code nobody
   asked for. Keep values in the form the platform already gives you.
7. Bug fixes: before editing a shared function, `Grep` for every caller, then fix the root
   cause once in the shared code instead of patching each call site.
8. Code you move keeps its validation and error handling. Never cut validation at trust
   boundaries, error handling that prevents data loss, security or accessibility.
9. Make the edits with `Edit` (or `Write` for genuinely new files). Keep the diff surgical:
   no unrelated reformatting, renames or comment rewrites.
10. Non-trivial logic (a branch, a loop, a parser, money, security, a new script) gets one
    small test. Trivial changes need none. Write the test first when practical.
11. Run the project's checks with `Bash` (tests, typecheck, lint, build as the project
    defines them). Fix what you broke, including tests and fixtures elsewhere.
12. A deliberate shortcut with a known limit gets a one-line code comment:
    `shortcut: <the limit>, <when to upgrade>`.

## Done when

- Every part the task needs is finished: callers updated, tests and fixtures fixed, exports
  and docs adjusted where the behavior changed.
- The project's check command passes, and you ran it yourself.
- The diff contains no line that does not trace back to the task.
- Your report lists the files changed, the commands run with their results, and ends with
  two short lines:
  - Skipped: what you deliberately did not do or did not check.
  - Risk: anything the owner must know before relying on the change.

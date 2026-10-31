---
name: planning
description: Turn a request into a small set of verifiable tasks with acceptance criteria, owners, dependencies and approval points.
---

# Planning

A good plan is the shortest list of tasks that, when all are done, provably satisfies the
request.

## When to use

- A mission or request must be broken into tasks for the team.
- A request is ambiguous and needs scoping before anyone writes code.
- Re-planning after a task failed or new information arrived.

## Steps

1. Restate the request in two or three sentences: the goal, the user-visible outcome, and
   what is explicitly out of scope.
2. Inspect the repository read-only before planning. Use `Glob` for the layout, `Read` for
   the README, architecture docs and package manifests, `Grep` for the code areas the
   request touches, and `git log --oneline -20` with `Bash` for recent direction.
3. List the assumptions and open questions. If an ambiguity would make the work useless if
   guessed wrong, raise it as an approval point instead of guessing.
4. Split the work into tasks. Each task:
   - has one owner role (architect, developer, designer, qa-engineer);
   - is small enough for one focused session (a few files, one behavior);
   - has a title in the imperative ("Add expiry check to session tokens");
   - has a description naming the files or areas to touch;
   - has acceptance criteria that can be verified by running something or reading a
     specific result, not "works well";
   - lists required consultations only when another role's knowledge is truly needed.
5. Order the tasks: add dependencies only where one task needs another's output. Group
   independent tasks so they can run in parallel.
6. Put verification in the plan: tests with the implementation tasks, and a QA task for
   behavior that crosses components.
7. Mark approval points for anything risky or irreversible: schema migrations, deleting
   data, new dependencies, external services, security-sensitive changes, deployment.
8. Remove tasks that do not serve the stated goal. Prefer fewer, complete tasks over many
   partial ones.
9. Check the plan: no cycles, every task has an owner and acceptance criteria, the union of
   acceptance criteria covers the request.

## Done when

- The plan has a goal statement, assumptions, tasks with owners, acceptance criteria,
  dependencies, parallel groups and approval points.
- Every acceptance criterion is verifiable.
- Nothing in the plan exceeds the request; open questions are listed for the owner.

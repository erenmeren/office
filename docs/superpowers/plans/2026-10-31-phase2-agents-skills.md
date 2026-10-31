# Phase 2 — Agents and Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents carry pinned, versioned skills and native subagent definitions; a run materializes exactly those skill versions outside the repository, the Claude session loads them, invocations and subagent runs are recorded, and the owner manages all of it in the UI (Skill Library, Agent Studio).

**Architecture:** Everything stays inside the Phase 1 shape. `packages/shared` gains skill validation, subagent and extended run-spec schemas. `packages/db` gains `Skill`, `SkillVersion`, `AgentSkill`, `AgentSubagent`, `SubagentRun`. `apps/api` gains the skill registry (import from a local directory, a git repository or the UI editor; `pending_review → approved`), per-version skill pins and subagent definitions, run specs that carry the pinned skill files, and `SubagentRun` recording from events. `apps/worker` writes the pinned skills to `<OFFICE_WORKER_HOME>/runs/<runId>/.office/.claude/skills/<name>/` and the Claude adapter passes that directory via `additionalDirectories`, the skill names via `skills` and the subagents via `agents`. `apps/web` gains the Skill Library and Agent Studio pages. `templates/skills` and `templates/agents` ship the default team and are seeded.

**Tech Stack:** Unchanged from Phase 1: Node 26, pnpm 12, TypeScript 5.9, Fastify 5, Prisma 7, Zod 4, `@anthropic-ai/claude-agent-sdk` 0.3.x, Next.js 16, shadcn/ui, TanStack Query 5, vitest 5. No new runtime dependencies (frontmatter is parsed with a small function, checksums with `node:crypto`, git with `execFile`).

**Spec:** `docs/superpowers/specs/2026-10-31-agent-office-design.md` (§5.3 versions, §5.4 specialists vs subagents, §6 agents and default team, §7 skills, §10 events, §12 screens, §14 untrusted content, §15 entities, §17 Phase 2 acceptance). Phase 1 plan for conventions: `docs/superpowers/plans/2026-10-31-phase1-foundation.md`.

## Global Constraints

- Everything in the Phase 1 plan's Global Constraints still applies (Node `>=26`, ESM, strict TS, `permissionMode: 'default'`, event envelope, redaction in worker and API, no secrets to the browser, commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, English code and docs).
- Work on branch `phase2-agents-skills` from `main`; merge to `main` only after the final whole-branch review.
- Skills are never written into the target repository (§7.2). They live under the worker home, in a per-run directory that is removed when the run ends.
- `AgentVersion` stays immutable: skill pins and subagent definitions belong to a version. Editing creates a new version; running sessions keep theirs (§5.3).
- Imported skills, skill content, subagent definitions and agent prompts are untrusted input: validated, stored, rendered as text in the UI, never executed by the API or the web app (§14).
- A skill can be assigned only when its status is `approved` (§7.1).
- No new runtime dependency in any package. YAML frontmatter support is limited to single-line `key: value` pairs; this limit is documented in `docs/development.md`.
- Every task ends with its tests passing (`pnpm --filter <pkg> test`) and a commit.

## Review Focus

1. **Skill files with hostile paths.** An import or editor payload whose file path is absolute, contains `..` or a backslash, or whose frontmatter `name` is not `^[a-z0-9][a-z0-9-]{0,63}$`, must be rejected with 400 and must write nothing (API) or create no directory (worker). Tests in Task 1 (`validateSkillFiles`), Task 3 (import route) and Task 6 (`materializeSkills` throws before writing).
2. **Assigning a skill that is not approved, or a version of another skill.** `POST /agents` or `PUT /agents/:id` with a `pending_review` or `rejected` skill → 409 `skill_not_approved`; with a `skillVersionId` that belongs to a different skill → 400. Nothing is created. Test in Task 4.
3. **Editing an agent while a run is in flight.** The run's `RunSpec`, the session's `skillsSnapshot` and the materialized files come from the version the run started with, not the new current version. Test in Task 4 (snapshot equals version N after a `PUT` creates N+1).
4. **Subagent events out of order or duplicated.** `agent.subagent.completed` for an unknown `toolUseId` is ignored without error; a duplicated `agent.subagent.spawned` (worker resend) leaves one `SubagentRun` row. Test in Task 4.
5. **Run directory cleanup.** `<home>/runs/<runId>` is removed after a succeeded, failed or cancelled run, and stale directories from a crashed worker are removed at worker start. Test in Task 6.

---

### Task 1: Shared schemas — skill files, subagents, run spec, skill event

**Files:**
- Create: `packages/shared/src/skill.ts`, `packages/shared/src/subagent.ts`
- Modify: `packages/shared/src/enums.ts` (EventType), `packages/shared/src/run-spec.ts`, `packages/shared/src/agent-config.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/skill.test.ts`, `packages/shared/src/run-spec.test.ts`

**Interfaces:**
- Produces (`skill.ts`):
  - `SkillFilesSchema = z.record(z.string(), z.string())` — path → UTF-8 content; `type SkillFiles`.
  - `SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/`; `SKILL_FILE_MAX_BYTES = 65_536`; `SKILL_TOTAL_MAX_BYTES = 524_288`; `SKILL_MAX_FILES = 50`.
  - `parseSkillFrontmatter(markdown: string): { name?: string; description?: string }` — reads the block between a leading `---` line and the next `---` line; single-line `key: value` pairs; surrounding single or double quotes stripped; everything else ignored.
  - `class SkillValidationError extends Error { constructor(public readonly code: 'missing_skill_md' | 'bad_path' | 'bad_name' | 'missing_description' | 'name_mismatch' | 'too_large' | 'too_many_files', message: string) }`.
  - `validateSkillFiles(files: SkillFiles, expectedName?: string): { name: string; description: string }` — throws `SkillValidationError` when: no `SKILL.md` key; any path is absolute, contains `..` segments, a backslash or an empty segment (`bad_path`); frontmatter `name` missing or not matching `SKILL_NAME_RE` (`bad_name`); `description` missing or empty (`missing_description`); `expectedName` given and different (`name_mismatch`); any file over `SKILL_FILE_MAX_BYTES` or total over `SKILL_TOTAL_MAX_BYTES` (`too_large`); more than `SKILL_MAX_FILES` (`too_many_files`).
  - `skillChecksum(files: SkillFiles): string` — sha256 hex over the files sorted by path, each as `path + '\0' + content + '\0'`.
  - `SkillModeSchema = z.enum(['eager', 'on_demand'])`; `SkillStatusSchema = z.enum(['pending_review', 'approved', 'rejected'])`; `SkillSourceSchema = z.enum(['local', 'git', 'ui'])`.
  - `RunSkillSchema = z.object({ name: z.string(), version: z.number().int().positive(), checksum: z.string(), mode: SkillModeSchema, files: SkillFilesSchema })`; `type RunSkill`.
  - `skillPromptSection(skills: Pick<RunSkill, 'name' | 'mode'>[]): string` — empty string when none; otherwise two optional paragraphs: `Before doing anything else, invoke the Skill tool for each of these skills and follow them: a, b.` for eager names and `These skills are available when relevant: c, d.` for on-demand names, joined by a blank line.
- Produces (`subagent.ts`): `SubagentDefinitionSchema = z.object({ name: z.string().regex(SKILL_NAME_RE), description: z.string().min(1), prompt: z.string().min(1), tools: z.array(z.string()).optional(), model: z.string().optional(), skills: z.array(z.string()).default([]), maxTurns: z.number().int().positive().optional() })`; `type SubagentDefinition`.
- Modifies (`enums.ts`): `EventType` gains `'agent.skill.invoked'` (payload `{ toolUseId, skill }`), emitted alongside `agent.tool.started` for the `Skill` tool, the way `agent.command.executed` accompanies `Bash`.
- Modifies (`run-spec.ts`): `RunSpecSchema` gains `skills: z.array(RunSkillSchema).default([])`, `subagents: z.array(SubagentDefinitionSchema).default([])`, `skillsDir: z.string().optional()` (worker-filled: the directory passed to `additionalDirectories`; never set by the API).
- Modifies (`agent-config.ts`): `AgentConfigSchema` unchanged (it is the stored `AgentVersion.config` JSON). Add `AgentSkillPinSchema = z.object({ skillId: z.string(), skillVersionId: z.string().optional(), mode: SkillModeSchema.default('on_demand') })` and `AgentConfigInputSchema = AgentConfigSchema.extend({ skills: z.array(AgentSkillPinSchema).default([]), subagents: z.array(SubagentDefinitionSchema).default([]) })`; `type AgentConfigInput`.

- [ ] **Step 1: Write failing tests**

`skill.test.ts`:
```ts
const ok = { 'SKILL.md': '---\nname: tdd\ndescription: "Write the test first"\n---\n# TDD\n', 'reference/a.md': 'x' };
it('accepts a valid skill and returns name and description', () =>
  expect(validateSkillFiles(ok)).toEqual({ name: 'tdd', description: 'Write the test first' }));
it('rejects a missing SKILL.md', () => expect(() => validateSkillFiles({ 'a.md': 'x' })).toThrow(/missing_skill_md|SKILL.md/));
it.each(['../x.md', '/etc/passwd', 'a\\b.md', 'a//b.md'])('rejects path %s', (p) =>
  expect(() => validateSkillFiles({ ...ok, [p]: 'x' })).toThrowError(expect.objectContaining({ code: 'bad_path' })));
it('rejects a bad name, a missing description and a name mismatch', () => { /* codes bad_name, missing_description, name_mismatch */ });
it('rejects a file over 64 KiB', () =>
  expect(() => validateSkillFiles({ ...ok, 'big.md': 'x'.repeat(65_537) })).toThrowError(expect.objectContaining({ code: 'too_large' })));
it('checksum is order independent and content sensitive', () => {
  expect(skillChecksum({ a: '1', b: '2' })).toBe(skillChecksum({ b: '2', a: '1' }));
  expect(skillChecksum({ a: '1' })).not.toBe(skillChecksum({ a: '2' }));
});
it('skillPromptSection names eager skills to invoke and lists on-demand ones', () => {
  const s = skillPromptSection([{ name: 'a', mode: 'eager' }, { name: 'b', mode: 'on_demand' }]);
  expect(s).toContain('invoke the Skill tool for each of these skills and follow them: a.');
  expect(s).toContain('available when relevant: b.');
  expect(skillPromptSection([])).toBe('');
});
```
`run-spec.test.ts`: `RunSpecSchema.parse(<Phase 1 spec without skills>)` fills `skills: []` and `subagents: []`; a spec with one `RunSkill` and one `SubagentDefinition` round-trips; `EventType.options` contains `'agent.skill.invoked'`.

- [ ] **Step 2: Run tests, verify fail**

Run: `pnpm --filter @office/shared test`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the files and signatures above; re-export from `index.ts`**

- [ ] **Step 4: Run tests and typecheck everything**

Run: `pnpm --filter @office/shared test && pnpm --filter @office/shared build && pnpm typecheck`
Expected: PASS; downstream packages still typecheck (the new `RunSpec` fields have defaults).

- [ ] **Step 5: Commit**

```bash
git add packages/shared && git commit -m "feat(shared): skill validation and checksum, subagent definitions, run spec skills, agent.skill.invoked"
```

---

### Task 2: Database — Skill, SkillVersion, AgentSkill, AgentSubagent, SubagentRun

**Files:**
- Modify: `packages/db/prisma/schema.prisma`, `packages/db/src/client.test.ts`
- Create: `packages/db/prisma/migrations/<timestamp>_phase2_skills/migration.sql` (generated)
- Modify: `apps/api/test/helpers.ts`, `apps/worker/test/e2e-fake.test.ts` (TRUNCATE lists)

**Interfaces:**
- Produces (schema; every model has `id String @id @default(uuid())`, `createdAt DateTime @default(now())`, every FK indexed):
  - `Skill(name String @unique, description String, source String, sourceRef String?, status String @default("pending_review"), currentVersionId String?, versions SkillVersion[])`
  - `SkillVersion(skillId, version Int, files Json, checksum String, createdBy String @default("owner"), @@unique([skillId, version]))`
  - `AgentSkill(agentVersionId, skillId, skillVersionId, mode String, @@unique([agentVersionId, skillId]))` with relations to `AgentVersion`, `Skill`, `SkillVersion`
  - `AgentSubagent(agentVersionId, name String, definition Json, @@unique([agentVersionId, name]))`
  - `SubagentRun(sessionId, toolUseId String @unique, subagentType String?, description String?, status String @default("running"), summary String?, startedAt DateTime, endedAt DateTime?)` with relation to `AgentSession`
  - `AgentVersion` gains `skills AgentSkill[]`, `subagents AgentSubagent[]`; `AgentSession` gains `subagentRuns SubagentRun[]`.
- Status and mode columns are `String` validated by the Zod enums from Task 1 (same approach as `AgentSession.status`).
- TRUNCATE list in both test helpers becomes: `"SubagentRun","SessionEvent","UsageRecord","AgentSession","TaskRun","Task","AgentSubagent","AgentSkill","AgentVersion","Agent","SkillVersion","Skill","Worker","Project","UserSession","User"`.

- [ ] **Step 1: Write failing tests**

`client.test.ts` adds:
```ts
it('enforces unique skill name, unique (skillId, version) and unique SubagentRun.toolUseId', async () => { /* three rejects.toThrow() */ });
it('an AgentSkill cannot reference a SkillVersion of another skill without an FK failure on delete', async () => {
  // create skill s1 with version v1, agent version av; create AgentSkill(av, s1, v1); deleting v1 rejects
});
```

- [ ] **Step 2: Migrate and run**

Run: `pnpm --filter @office/db generate && pnpm --filter @office/db migrate:dev --name phase2_skills && pnpm --filter @office/db migrate:test && pnpm --filter @office/db test`
Expected: migration folder created; tests PASS.

- [ ] **Step 3: Update the TRUNCATE lists and run the API and worker suites**

Run: `pnpm --filter @office/api test && pnpm --filter @office/worker test`
Expected: PASS (unchanged behavior).

- [ ] **Step 4: Commit**

```bash
git add packages/db apps/api/test/helpers.ts apps/worker/test/e2e-fake.test.ts && git commit -m "feat(db): skills, skill versions, agent skill pins, subagent definitions and runs"
```

---

### Task 3: API skill registry — create, import (local, git), versions, approval

**Files:**
- Create: `apps/api/src/services/skill-service.ts`, `apps/api/src/routes/skills.ts`
- Modify: `apps/api/src/config.ts` (`skillImportRoots`), `apps/api/src/app.ts` (register route), `.env.example`
- Test: `apps/api/test/skills.test.ts`

**Interfaces:**
- Consumes: `validateSkillFiles`, `skillChecksum`, `SkillFilesSchema`, `SkillStatusSchema` from `@office/shared`; `isUnderRoot` from `apps/api/src/lib/paths.ts`.
- Config: env `OFFICE_SKILL_IMPORT_ROOTS` (colon-separated, optional). `Config.skillImportRoots: string[]`, default `[resolve(fileURLToPath(new URL('../../../templates/skills', import.meta.url)))]` (the repo's `templates/skills`, same depth from `src/` and `dist/`). Paths are `realpath`-resolved when they exist; missing ones are kept as given.
- Produces (`skill-service.ts`):
  - `readSkillDir(dir: string): Promise<SkillFiles>` — every regular file under `dir` (recursive, relative POSIX paths, UTF-8), skipping dot-directories.
  - `createSkill(prisma, input: { name?: string; files: SkillFiles; source: 'local' | 'git' | 'ui'; sourceRef?: string; status: SkillStatus }): Promise<Skill & { currentVersion: SkillVersion }>` — validates (`validateSkillFiles(files, input.name)`), 409 `conflict` if the name exists, creates `Skill` + `SkillVersion 1` + sets `currentVersionId` in one transaction.
  - `addSkillVersion(prisma, skillId, files): Promise<SkillVersion>` — validates with `expectedName = skill.name`; if the checksum equals the current version's, returns the current version (no new row); otherwise creates version N+1 and updates `currentVersionId` and `description`.
  - `importLocal(prisma, config, path): Promise<...>` — 400 `path_outside_import_roots` unless `realpath(path)` is under a `skillImportRoots` entry; `createSkill` with `source: 'local'`, `sourceRef: path`, `status: 'pending_review'`, name from the directory basename.
  - `importGit(prisma, config, { url, ref?, path? }): Promise<...>` — `url` must start with `https://`, or `file://` pointing under an import root (tests); `execFile('git', ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', url, tmp], { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:file' } })` into `mkdtemp` under `config.dataDir`; imports the directory `path` (default repo root) with `sourceRef: \`${url}#${ref ?? 'HEAD'}:${path ?? '.'}\``; the temp clone is removed in `finally`. Only one skill per import call.
- Routes (owner cookie required, errors as Phase 1):
  - `GET /skills` → `Skill[]` each with `currentVersion: { id, version, checksum, createdAt }` (no `files`).
  - `POST /skills { name, files }` → 201, `source: 'ui'`, `status: 'approved'` (owner-authored).
  - `POST /skills/import { source: 'local', path } | { source: 'git', url, ref?, path? }` → 201 with `status: 'pending_review'`.
  - `GET /skills/:id` → skill with `versions: [{ id, version, checksum, createdAt }]` and `currentVersion` including `files`.
  - `GET /skills/:id/versions/:version` → the version with `files`.
  - `POST /skills/:id/versions { files }` → 201 new version (or 200 the unchanged current one).
  - `POST /skills/:id/approve`, `POST /skills/:id/reject` → updated skill; approving an already approved skill is a no-op 200.
  - `SkillValidationError` → 400 `{ error: 'invalid_skill', code, message }` (add a branch to the error handler in `app.ts`).

- [ ] **Step 1: Write failing tests**

`skills.test.ts` (uses `makeApp()` with `OFFICE_SKILL_IMPORT_ROOTS` set to a `mkdtemp` directory via `process.env` before `makeApp`, and `OFFICE_DATA_DIR` to another):
```ts
it('creates a UI skill as approved, versions it, and dedups identical content', ...)   // POST /skills → 201 approved v1; POST versions with changed SKILL.md → v2; same files again → still v2
it('imports a local directory as pending_review and refuses paths outside the import roots', ...) // dir under root → 201 pending_review, name = basename; /tmp/elsewhere → 400 path_outside_import_roots
it('imports from a git repository', async () => {
  // git init a repo under the import root with skills/git-skill/SKILL.md, commit, then
  // POST /skills/import { source: 'git', url: `file://${repo}`, path: 'skills/git-skill' } → 201, sourceRef ends with ':skills/git-skill'
});
it('rejects hostile file paths and bad frontmatter with 400 invalid_skill and writes nothing', ...) // '../x.md' → code bad_path; name 'Bad Name' → bad_name; prisma.skill.count() unchanged
it('approve and reject flip status; GET /skills hides files', ...)
it('rejects http:// and ssh git urls with 400', ...)
```

- [ ] **Step 2: Run tests, verify fail**

Run: `pnpm --filter @office/api test test/skills.test.ts`
Expected: FAIL (404 routes).

- [ ] **Step 3: Implement config, service, routes; register in `app.ts`; add `OFFICE_SKILL_IMPORT_ROOTS=` (commented, with the default explained) to `.env.example`**

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @office/api test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api .env.example && git commit -m "feat(api): skill registry with local, git and editor import, versions and approval"
```

---

### Task 4: API agents with skill pins and subagents; run spec, session snapshot, SubagentRun recording

**Files:**
- Modify: `apps/api/src/routes/agents.ts`, `apps/api/src/services/run-service.ts`, `apps/api/src/ws/worker-gateway.ts` (call the subagent recorder where events are persisted), `apps/api/src/routes/runs.ts`
- Create: `apps/api/src/services/agent-service.ts`, `apps/api/src/services/subagent-service.ts`
- Test: `apps/api/test/agents.test.ts` (extend), `apps/api/test/run-spec.test.ts`, `apps/api/test/subagents.test.ts`

**Interfaces:**
- Consumes: `AgentConfigInputSchema`, `AgentConfigSchema`, `RunSpecSchema`, `skillPromptSection`, `SubagentDefinitionSchema` from `@office/shared`; Task 2 models.
- Produces (`agent-service.ts`):
  - `createAgentVersion(tx, agentId, version: number, input: AgentConfigInput): Promise<AgentVersion>` — stores `AgentConfigSchema.parse(input)` (skills and subagents stripped) as `config`; for each pin loads the skill, throws `HttpError(409, 'skill_not_approved')` unless `status === 'approved'`, resolves `skillVersionId ?? skill.currentVersionId`, throws `HttpError(400, 'skill_version_mismatch')` when that version's `skillId` differs, creates `AgentSkill` rows; validates every subagent's `skills` names are a subset of the pinned skill names (`HttpError(400, 'subagent_skill_unknown')`), creates `AgentSubagent` rows with `definition = SubagentDefinitionSchema.parse(...)`.
  - `loadVersion(prisma, versionId): Promise<{ version: AgentVersion; config: AgentConfig; skills: Array<{ skillId, skillVersionId, name, version, checksum, mode, files }>; subagents: SubagentDefinition[] }>`.
  - `versionView(prisma, version)` — the API shape of a version: `{ id, version, createdAt, config, skills: [{ skillId, skillVersionId, name, version, mode }], subagents: SubagentDefinition[] }` (no files).
- Routes (`agents.ts`): `POST /agents` and `PUT /agents/:id` accept `config: AgentConfigInput`; `GET /agents`, `GET /agents/:id` return `currentVersion` and `versions` as `versionView`. `GET /agents/:id/versions/:version` → one `versionView`.
- `run-service.ts`: `createRunForTask` uses `loadVersion`; `RunSpec.systemPrompt = cfg.systemPrompt + (section ? '\n\n' + section : '')` with `section = skillPromptSection(skills)`; `RunSpec.skills = skills.map(({ name, version, checksum, mode, files }) => ...)`; `RunSpec.subagents = subagents`; `AgentSession.skillsSnapshot = skills.map(({ skillId, skillVersionId, name, version, checksum, mode }) => ...)`.
- Produces (`subagent-service.ts`): `recordSubagentEvent(prisma, event: OfficeEvent): Promise<void>` — `agent.subagent.spawned` → `upsert` by `toolUseId` (`sessionId`, `subagentType`, `description`, `status: 'running'`, `startedAt: event.ts`); `agent.subagent.completed` → `updateMany` where `toolUseId` (`status`, `summary`, `endedAt`); any other type → no-op. Called after a successful `appendEvent` with `inserted: true` in the worker gateway.
- Route: `GET /runs/:id/subagents` → `SubagentRun[]` ordered by `startedAt`.

- [ ] **Step 1: Write failing tests**

`agents.test.ts` adds (a helper creates an approved skill via `POST /skills` and a pending one via `prisma.skill.create`):
```ts
it('pins approved skills and subagents on the version and resolves the latest skill version by default', ...) // currentVersion.skills[0].version === 1 and mode 'eager'; subagents length 1
it('refuses a pending skill (409 skill_not_approved), a foreign skill version (400) and a subagent skill not pinned (400)', ...)
it('a new agent version keeps the old pins: version 1 still lists skill v1 after the skill gets v2 and the agent is re-saved pinning v2', ...)
```
`run-spec.test.ts` (no worker: call `createRunForTask` directly with a fake `{ workerId }`, as `scheduler.test.ts` does):
```ts
it('run spec carries pinned skill files, subagents and the skill prompt section; session snapshot matches the pins', ...)
it('editing the agent after the run was created does not change the run spec or the snapshot', ...) // PUT creates v2 with no skills; re-read session.skillsSnapshot → still v1 pins
```
`subagents.test.ts`: feed events through `recordSubagentEvent`: spawned → one row `running`; spawned again (same toolUseId) → still one row; completed → `status 'completed'`, `summary`, `endedAt` set; completed for unknown toolUseId → no throw, zero rows; `GET /runs/:id/subagents` lists them.

- [ ] **Step 2: Run tests, verify fail**

Run: `pnpm --filter @office/api test`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @office/api test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): skill pins and subagents per agent version, run spec skills, session snapshot, subagent runs"
```

---

### Task 5: Runtime — skill and subagent wiring in the Claude adapter, normalizer, fake adapter, smoke script

**Files:**
- Modify: `packages/runtime/src/claude/adapter.ts`, `packages/runtime/src/claude/normalize.ts`, `packages/runtime/src/fake/adapter.ts`
- Create: `packages/runtime/scripts/smoke-skills.ts`
- Test: `packages/runtime/src/claude/normalize.test.ts` (extend), `packages/runtime/src/claude/adapter.test.ts` (extend), `packages/runtime/src/fake/adapter.test.ts` (extend)

**Interfaces:**
- `normalize.ts`: a `tool_use` named `Skill` additionally emits `{ type: 'agent.skill.invoked', payload: { toolUseId, skill: str(input.skill) ?? str(input.command) } }`. The `agent.started` payload gains `slashCommands: msg.slash_commands` and `agents: msg.agents ?? []` (evidence of what the session loaded).
- `adapter.ts` (`query` options): `additionalDirectories: spec.skillsDir ? [spec.skillsDir] : undefined`; `skills: spec.skills.length ? spec.skills.map((s) => s.name) : undefined`; `agents: Object.fromEntries(spec.subagents.map((s) => [s.name, { description, prompt, tools, model, skills, maxTurns }]))` when non-empty; `allowedTools` becomes `spec.allowedTools` plus `'Skill'` when `spec.skills.length > 0` and plus `'Agent'` when `spec.subagents.length > 0` (the same list feeds `disallowedTools` and `canUseTool`). Export `effectiveAllowedTools(spec): string[]` for the test.
- `fake/adapter.ts`: after `agent.started`, for each `spec.skills` entry with `mode === 'eager'` emit `agent.tool.started { tool: 'Skill', toolUseId: 'fake-skill-<name>', input: { skill: name } }`, `agent.skill.invoked { toolUseId, skill: name }`, `agent.tool.completed`; when `spec.prompt` includes `SUBAGENT` and `spec.subagents[0]` exists, emit `agent.tool.started { tool: 'Agent', toolUseId: 'fake-sub-1', input: { subagent_type: name, description: 'fake subagent' } }`, `agent.subagent.spawned { toolUseId: 'fake-sub-1', subagentType: name, description }`, `agent.subagent.completed { toolUseId: 'fake-sub-1', status: 'completed', summary: 'done' }`.
- `scripts/smoke-skills.ts` (real Claude, opt-in, like `smoke-claude.ts`): writes a skill `office-smoke` (`SKILL.md` frontmatter plus the body `When invoked, reply with exactly: SKILL_OK`) to `<mkdtemp>/.office/.claude/skills/office-smoke/`, runs `ClaudeAdapter` with `model: 'haiku'`, `maxBudgetUsd: 0.05`, `allowedTools: []`, `skills: [{ name: 'office-smoke', mode: 'eager', ... }]`, `skillsDir: <mkdtemp>/.office`, prompt `Follow your instructions.`, system prompt from `skillPromptSection`; prints events and result; exits 1 unless an `agent.skill.invoked` with `skill: 'office-smoke'` was seen and the result contains `SKILL_OK`.

- [ ] **Step 1: Write failing tests**

`normalize.test.ts`: an assistant `tool_use` block `{ name: 'Skill', input: { skill: 'tdd' } }` yields `agent.tool.started` then `agent.skill.invoked { skill: 'tdd' }`; `system/init` with `slash_commands: ['/tdd']` yields `agent.started.payload.slashCommands` equal to it.
`adapter.test.ts`: `effectiveAllowedTools(spec)` adds `Skill` only when skills exist and `Agent` only when subagents exist; neither is duplicated when already present.
`fake/adapter.test.ts`: a spec with one eager and one on-demand skill emits exactly one `agent.skill.invoked` (the eager one) and the spec with `SUBAGENT` emits spawned then completed with the same `toolUseId`.

- [ ] **Step 2: Run tests, verify fail**

Run: `pnpm --filter @office/runtime test`
Expected: FAIL.

- [ ] **Step 3: Implement; then run the smoke script**

Run: `pnpm --filter @office/runtime exec tsx scripts/smoke-skills.ts`
Expected: `agent.skill.invoked office-smoke`, result containing `SKILL_OK`, exit 0. Paste the event list and cost into `docs/progress.md` under "Phase 2 evidence → Runtime skill smoke".

If the session does not list `/office-smoke` in `agent.started.slashCommands` and never invokes it, skills under `additionalDirectories` are not discovered by this SDK build. Then switch materialization to a local plugin: `plugins: [{ type: 'local', path: spec.skillsDir }]` with the worker writing `<skillsDir>/.claude-plugin/plugin.json` (`{ "name": "office" }`) and `<skillsDir>/skills/<name>/...` instead of `.claude/skills/<name>/...`; keep the `skills` name filter (it matches the `:name` suffix). Record which path was taken in `docs/progress.md` and `docs/architecture.md`; Task 6 follows the recorded layout.

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @office/runtime test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime docs/progress.md && git commit -m "feat(runtime): load pinned skills and subagents in the Claude adapter; skill invocation events"
```

---

### Task 6: Worker — skill materialization and per-run directory

**Files:**
- Create: `apps/worker/src/skills.ts`
- Modify: `apps/worker/src/executor.ts`, `apps/worker/src/connection.ts` (pass `runsDir`), `apps/worker/src/main.ts` or `connection.ts` start (stale sweep)
- Test: `apps/worker/test/skills.test.ts`, `apps/worker/test/executor.test.ts` (extend), `apps/worker/test/e2e-fake.test.ts` (extend)

**Interfaces:**
- Consumes: `RunSkill`, `SKILL_NAME_RE` from `@office/shared`; `WorkerConfig.home`.
- Produces (`skills.ts`):
  - `runRoot(runsDir: string, runId: string): string` → `join(runsDir, runId)`; `runId` must match `/^[A-Za-z0-9-]+$/` or it throws.
  - `materializeSkills(runsDir: string, runId: string, skills: RunSkill[]): Promise<string | undefined>` — returns `undefined` when `skills` is empty; otherwise validates every skill name against `SKILL_NAME_RE` and every file path with the same rules as `validateSkillFiles` (reuse it: call `validateSkillFiles(skill.files, skill.name)`) before writing anything; writes `<runRoot>/.office/.claude/skills/<name>/<path>` (or the plugin layout if Task 5 recorded that) with `mkdir -p` and mode 0600 files; returns `<runRoot>/.office`.
  - `removeRunRoot(runsDir, runId): Promise<void>` — `rm -rf` the run root, ignoring a missing directory.
  - `sweepRunRoots(runsDir, keep: string[]): Promise<string[]>` — removes every child of `runsDir` not in `keep`; returns the removed names.
- `executor.ts`: constructor gains `runsDir: string` (the connection passes `join(config.home, 'runs')`); `execute` calls `materializeSkills` before `adapter.run({ ...spec, skillsDir }, ...)`, and `removeRunRoot` in `finally`. A `materializeSkills` failure produces `agent.failed { error }` and a `failed` result, like an adapter throw. `sweepRunRoots(runsDir, [])` runs once at connection start (no runs are active at start).

- [ ] **Step 1: Write failing tests**

`skills.test.ts`:
```ts
it('writes the pinned files under <runsDir>/<runId>/.office/.claude/skills/<name>/ and returns the .office dir', ...)
it('returns undefined and creates nothing for no skills', ...)
it('throws before writing on a hostile path or name', ...) // files { '../x': 'y' } → throws; runsDir has no new entries
it('sweepRunRoots removes stale roots and keeps active ones', ...)
```
`executor.test.ts` adds: after a run (succeeded, `FAIL`, and cancelled via `SLOW` + `cancel`) `existsSync(join(runsDir, 'run-1'))` is false; the adapter received `spec.skillsDir` ending in `/run-1/.office` when the spec had skills.
`e2e-fake.test.ts` adds `it('a task of an agent with an eager skill and a subagent records the skill snapshot, the skill invocation and the subagent run', ...)`: create an approved skill via `POST /skills`, an agent pinning it `eager` with one subagent, a task whose description includes `SUBAGENT`; after `done`: `GET /runs/:id` → `session.skillsSnapshot` is `[{ name, version: 1, checksum, mode: 'eager', skillId, skillVersionId }]`; `GET /runs/:id/events` contains `agent.skill.invoked` with `skill === name`; `GET /runs/:id/subagents` has one row with `status 'completed'`.

- [ ] **Step 2: Run tests, verify fail**

Run: `pnpm --filter @office/worker test`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @office/worker test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker && git commit -m "feat(worker): materialize pinned skills per run outside the repository; clean run roots"
```

---

### Task 7: Templates and seed — shipped skills, default team, subagent templates

**Files:**
- Create: `templates/skills/<name>/SKILL.md` for `lazy-expert-developer`, `frontend-design`, `ui-ux-design`, `design-systems`, `accessibility`, `responsive-design`, `visual-quality-review`, `clean-architecture`, `test-driven-development`, `debugging`, `code-review`, `planning`
- Create: `templates/agents/chief.json`, `architect.json`, `developer.json`, `designer.json`, `qa-engineer.json`; `templates/subagents/debugger.json`, `test-writer.json`, `security-reviewer.json`, `ux-researcher.json`, `accessibility-reviewer.json`, `visual-reviewer.json`
- Modify: `packages/db/src/seed.ts`, `packages/db/src/seed.test.ts`, `packages/db/package.json` (depend on `@office/shared` for validation)

**Interfaces:**
- Each `SKILL.md`: frontmatter `name` (equals the directory) and a one-line `description`; body 40–120 lines, concrete, imperative, Claude Code compatible (sections "When to use", "Steps", "Done when"). `lazy-expert-developer` is the spec's description written as a skill: smallest complete change, reuse before new code, no unrequested abstractions, one small test for non-trivial logic, report what was skipped.
- `templates/agents/<slug>.json`: `{ name, slug, role, description, config: AgentConfigInput }` where `config.skills` entries use `{ skill: '<skill name>', mode }` (the seed resolves names to ids) and `config.subagents` entries are either a `SubagentDefinition` or `{ template: '<subagent file name>' }`. Models and skills per spec §6.2: Chief `opus` (`planning` eager, `code-review` on_demand); Architect `sonnet` (`clean-architecture` eager, `code-review`); Developer `sonnet` (`lazy-expert-developer` and `test-driven-development` eager; `debugging`, `code-review`, `clean-architecture` on_demand; subagents `debugger`, `test-writer`); Designer `sonnet` (`frontend-design` eager; the other five design skills on_demand; subagents `ux-researcher`, `accessibility-reviewer`, `visual-reviewer`); QA Engineer `sonnet` (`test-driven-development` eager; `code-review`, `debugging`; subagents `test-writer`, `security-reviewer`). `allowedTools` default `['Read','Glob','Grep','Bash','Edit','Write']`; Chief and Architect without `Edit`/`Write`. `maxBudgetUsd` 1 for specialists, 3 for Chief.
- `seed.ts`: `seed(prisma, workspaceRoot, templatesDir = fileURLToPath(new URL('../../../templates', import.meta.url)))`. Order: project (unchanged); every `templates/skills/*` → `createSkill`-equivalent with `source: 'local'`, `sourceRef: <dir>`, `status: 'approved'` (shipped content is owner-trusted), skipped with `exists` when the name exists; every agent template → skipped when the slug exists (the Phase 1 `developer` keeps its version 1; re-pin in Agent Studio), otherwise created with version 1 and `AgentSkill`/`AgentSubagent` rows. Skill-service functions needed by the seed (`createSkill` logic) move to `packages/shared`? No: the seed re-implements the two small inserts with `validateSkillFiles` and `skillChecksum` from `@office/shared`, so `packages/db` does not depend on `apps/api`.
- Root `pnpm seed` unchanged.

- [ ] **Step 1: Write failing tests**

`seed.test.ts` adds: after `seed`, `prisma.skill.count({ where: { status: 'approved' } }) >= 12`, agents `chief`, `architect`, `designer`, `qa-engineer` exist with `currentVersionId`, `designer`'s version has 6 `AgentSkill` rows with `frontend-design` as `eager` and 3 `AgentSubagent` rows; second run adds no rows (count every table before and after). A test iterates `templates/skills/*` and asserts `validateSkillFiles(readSkillDir(dir)).name === basename(dir)`.

- [ ] **Step 2: Run, verify fail** — `pnpm --filter @office/db test`.

- [ ] **Step 3: Write the templates and the seed; run `pnpm seed` twice against the dev database**

Expected: first run prints created lines for 12 skills and 4 agents (`developer exists`); second prints only `exists`.

- [ ] **Step 4: Run tests, verify pass** — `pnpm --filter @office/db test`.

- [ ] **Step 5: Commit**

```bash
git add templates packages/db && git commit -m "feat(templates,seed): shipped skills, default team and subagent templates"
```

---

### Task 8: Web — Skill Library

**Files:**
- Create: `apps/web/src/app/skills/page.tsx`, `apps/web/src/app/skills/[id]/page.tsx`
- Modify: `apps/web/src/lib/queries.ts` (`Skill`, `SkillVersion` types, `useSkills`, `useSkill`), `apps/web/src/components/nav.tsx` (link `Skills`)

**Interfaces:**
- Consumes Task 3 routes.
- `/skills`: table (name, description, status badge, current version, source) linking to `/skills/[id]`; per row `Approve` / `Reject` buttons when `pending_review`; card "Import skill" with a `local | git` toggle (local: path; git: url, ref, path) posting to `/skills/import`; card "New skill" with name and a `SKILL.md` textarea prefilled with a frontmatter template, posting `files: { 'SKILL.md': text }` to `/skills`. Errors show the API body (`invalid_skill` code and message).
- `/skills/[id]`: header (name, status, source, `sourceRef`), versions table (version, checksum first 12 chars, created), current `SKILL.md` rendered as plain preformatted text (never as HTML or Markdown), other files listed by path with their text, an "Edit" textarea that posts `/skills/:id/versions`, Approve/Reject.

- [ ] **Step 1: Implement pages and queries**

- [ ] **Step 2: Verify**

Run: `pnpm --filter @office/web typecheck && pnpm --filter @office/web build`
Expected: exit 0. Manual: with the API running and seeded, `/skills` lists 12 approved skills; importing `templates/skills/planning` again fails with 409; creating `my-skill` in the editor shows it approved with version 1; editing creates version 2; the SKILL.md text is shown verbatim.

- [ ] **Step 3: Commit**

```bash
git add apps/web && git commit -m "feat(web): skill library with import, editor, versions and approval"
```

---

### Task 9: Web — Agent Studio, subagent runs and skill events on the task page

**Files:**
- Create: `apps/web/src/app/agents/[id]/page.tsx`, `apps/web/src/components/agent-form.tsx`
- Modify: `apps/web/src/app/agents/page.tsx` (rows link to the editor; the create form moves into `agent-form.tsx`), `apps/web/src/lib/queries.ts` (`AgentVersionView`, `useAgent`, `useRunSubagents`), `apps/web/src/app/tasks/[id]/page.tsx`, `apps/web/src/components/event-log.tsx`

**Interfaces:**
- Consumes Task 4 routes and Task 8 `useSkills`.
- `agent-form.tsx`: `AgentForm({ initial?: AgentVersionView & { name, slug, role, description, isActive }, onSubmit(body) })` with fields: name, slug (create only), role, description, active switch, system prompt, model select (`fable`, `opus`, `sonnet`, `haiku`), effort select (unset, `low`…`max`), allowed tools, maxTurns, maxBudgetUsd, maxConcurrentSubagents, maxSubagentDepth; **Skills**: one row per approved skill (from `useSkills`) with a checkbox, a mode select (`eager` / `on_demand`) and a version select (default latest, options from `GET /skills/:id`); **Subagents**: list of cards each with name, description, prompt, model, tools (comma-separated), skills (checkboxes limited to the pinned skills), remove button, and an "Add subagent" button. Submits `config: AgentConfigInput`.
- `/agents/[id]`: `AgentForm` prefilled from `currentVersion`; "Save as new version" posts `PUT /agents/:id`; versions table (version, created, model, skills as `name@version (mode)`, subagent names) each expandable to its JSON.
- Task page: a "Subagents" card (table: type, description, status badge, started, ended, summary) from `useRunSubagents(latest.id)`, refetched on each `run.status.changed` and every 3 s while the run is active; `event-log.tsx` `summary()` shows `skill <name>` for `agent.skill.invoked` and `subagent <type>` for `agent.subagent.spawned`. The session's `skillsSnapshot` is shown under the run row as `name@version (mode)` chips.

- [ ] **Step 1: Implement**

- [ ] **Step 2: Verify**

Run: `pnpm --filter @office/web typecheck && pnpm --filter @office/web test && pnpm --filter @office/web build`
Expected: exit 0. Manual: open `/agents/<developer id>`, pin `test-driven-development` eager, save → version 2 listed with the pin; a pending skill does not appear in the list; create a subagent naming a non-pinned skill → the UI prevents it (checkboxes limited) and the API would answer 400.

- [ ] **Step 3: Commit**

```bash
git add apps/web && git commit -m "feat(web): agent studio with skill pins, subagents and versions; subagent runs and skill events on the task page"
```

---

### Task 10: Docs, real Claude acceptance, progress

**Files:**
- Modify: `docs/progress.md`, `docs/architecture.md`, `docs/worker-protocol.md`, `docs/security.md`, `docs/development.md`, `README.md`, `CLAUDE.md` (commands unchanged; add the Phase 2 standing decisions below)

**Interfaces:**
- Standing decisions to add to `CLAUDE.md` and `docs/progress.md`: skills are materialized under `<OFFICE_WORKER_HOME>/runs/<runId>/.office` and removed after the run; UI-authored skills are `approved` on creation, imported ones `pending_review`; `AgentSkill` and `AgentSubagent` rows belong to an `AgentVersion` (immutable with it); `ProjectAgent` is deferred to Phase 4 (the Chief's planning needs it; nothing in Phase 2 does); frontmatter parsing supports single-line `key: value` only.
- `docs/worker-protocol.md`: `RunSpec` now carries `skills` (name, version, checksum, mode, files), `subagents` and the worker-filled `skillsDir`.
- `docs/architecture.md`: move `Skill`, `SkillVersion`, `AgentSkill`, `AgentSubagent`, `SubagentRun` to "built"; describe materialization and the chosen layout (additional directory or plugin, per Task 5).
- `docs/security.md`: import roots, git import restrictions (`https://` only, `GIT_ALLOW_PROTOCOL`, 60 s timeout, no shell), skill content treated as untrusted text, `Skill` and `Agent` tools auto-allowed only when the version pins skills or subagents.
- `README.md`: Skill Library and Agent Studio sections; how to import a skill directory; the default team after `pnpm seed`.

- [ ] **Step 1: Real Claude acceptance run (spec §17 Phase 2)**

Start infra, API, worker (`OFFICE_RUNTIME=claude`, saved credential) and web; `pnpm seed`. In Agent Studio give the Phase 1 `developer` a new version pinning `test-driven-development` (eager) and `lazy-expert-developer` (eager). Submit two tasks on `office-sandbox`:
1. `developer`: title `Add a sum helper`, description `Create sum.js exporting function sum(a, b) and a test file sum.test.js using node:test that checks sum(2, 3) === 5; run the test with node --test and show the output.`
2. `designer`: title `Landing page`, description `Create index.html with a responsive hero section for "Agent Office" using only inline CSS; keep it accessible.`

Expected for each run in the UI and over `GET /runs/:id`: `agent.started.payload.slashCommands` lists the pinned skill names; at least one `agent.skill.invoked` whose `skill` is one of the eager pins; `session.skillsSnapshot` equals the version's pins (`skillId`, `skillVersionId`, `name`, `version`, `checksum`, `mode`) and the two sessions have different snapshots; the task reaches `done`. Record in `docs/progress.md` → "Phase 2 evidence": task, run, session ids, snapshot, the `agent.skill.invoked` events with seq and time, cost. If a skill is never invoked, record it verbatim and leave Phase 2 `in progress`.

- [ ] **Step 2: Docs**

Write the changes above. `docs/progress.md`: Phase 2 → `done` only if Step 1 met every expectation; otherwise `in progress` with the failing expectation named. Outstanding list: `ProjectAgent` (Phase 4), approvals (Phase 4), multi-line frontmatter.

- [ ] **Step 3: Full verification**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: phase 2 architecture, protocol, security, runbook; phase 2 evidence"
```

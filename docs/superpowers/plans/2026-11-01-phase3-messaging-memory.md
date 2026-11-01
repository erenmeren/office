# Phase 3 — Messaging and Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents talk to each other and to the owner through a persisted message bus with MCP tools, wait for replies by suspending their run, get woken by bounded inbox runs, leave curated memory with sources after every run, and start every session with a context pack built from verified memory; the owner reads it all in the Conversations and Project Memory screens.

**Architecture:** Everything stays inside the Phase 1 shape. `packages/shared` gains the message, delivery and memory enums, the `office` MCP tool catalogue (names and Zod input shapes, shared by the worker that serves them and the API that executes them), `tool.call`/`tool.result` worker protocol messages, `kind`, `startSeq` on `RunSpec` and the `suspended` run result. `packages/db` gains `Conversation`, `Message`, `MessageDelivery`, `MemoryEntry` (tsvector FTS, unused pgvector column), `MemorySource`; `TaskRun` becomes task-optional (inbox and chat runs belong to an agent and a project, not a task). `apps/api` executes every tool call against the session's project, enforces loop limits, suspends and resumes `waiting_reply` runs, wakes agents with inbox runs, enqueues summary runs for the hidden `office-summarizer` agent, builds the context pack. `packages/runtime` serves the tools to Claude as an in-process SDK MCP server (`createSdkMcpServer`) over a `ToolBridge` the worker provides, and the fake adapter drives the same bridge from prompt markers. `apps/worker` relays `tool.call`/`tool.result` over its socket. `apps/web` gains Conversations and Project Memory from the artboards.

**Tech Stack:** Unchanged: Node 26, pnpm 12, TypeScript 5.9, Fastify 5, Prisma 7, Zod 4, `@anthropic-ai/claude-agent-sdk` 0.3.x (`createSdkMcpServer`, `tool`, `strictMcpConfig`, `Query.interrupt`), Next.js 16, shadcn pattern, TanStack Query 5, vitest 5, Playwright 1.64. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-10-31-agent-office-design.md` (§6.3 chat as a session, §9 bus and memory, §10 events, §12 screens, §14 security, §15 entities, §16 testing, §17 Phase 3 acceptance, §19/§20 decisions). Phase 2 plan for conventions: `docs/superpowers/plans/2026-10-31-phase2-agents-skills.md`. UI artboards: artifact "Claude Agent Office — Web UI" (`project/Conversations.dc.html`, `project/ProjectMemory.dc.html`); the component kit from the Mission Control port lives in `apps/web/src/components/ui`.

## Global Constraints

- Everything in the Phase 1 and Phase 2 Global Constraints still applies (Node `>=26`, ESM, strict TS, `permissionMode: 'default'`, event envelope, redaction in worker and API, no secrets to the browser, immutable `AgentVersion`, skills and messages are untrusted text, commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, English code and docs).
- Work on branch `phase3-messaging-memory` from `main`; merge to `main` only after the final whole-branch review.
- The project of every tool call, query and write is derived from the calling session (`AgentSession.projectId`) or the owner's request, never from a tool argument alone (§14).
- Every message and memory entry is written before any delivery or notification; delivery is best-effort and the pending inbox is drained at the recipient's next session (§9.1).
- Delivery into a *live* session (streaming input) is **not** built in Phase 3: a message reaches an agent when it calls `read_inbox` itself, or at its next run; `question`, `help_request`, `handoff` and `escalation` wake an agent that has no live run through an inbox run. This matches the artboard copy ("Saved · delivers at the next session boundary") and is recorded as a Phase 3 decision.
- The hidden system agent `office-summarizer` (`Agent.isSystem = true`) never appears in the team list, cannot be assigned a task, has no inbox and never triggers another summary run (§9.3).
- Only `verified` entries enter the context pack; `task_summary` entries written by the API from a summary run are `verified` on creation; everything an agent proposes is `proposed` (§9.2).
- The `MemoryEntry.embedding` pgvector column exists and is never read or written (§9.4).
- Worker-emitted events keep the `(sessionId, seq)` contract: a resumed run continues numbering from `RunSpec.startSeq`.
- Every task ends with its tests passing (`pnpm --filter <pkg> test`) and a commit.

## Review Focus

1. **A tool call that names another project's data.** `get_conversation`, `read_memory`, `reply_message` with an id from a different project → `not_found` tool error, nothing read or written. Tests in Task 5.
2. **A reply that arrives after the waiting run was lost, cancelled or already resumed.** The reply is stored and delivered; the run is resumed at most once (`waiting_reply → queued` guarded on status), and a `lost`/`cancelled` run is not resurrected. Tests in Task 6.
3. **Loop limits.** The 21st `send_message` of a session, the 101st of a task, a self-addressed message, an escalation beyond depth 2 and a handoff chain beyond 3 → tool error with code `limit_exceeded` / `self_message`; nothing written. Tests in Task 3.
4. **Summary run output that is not what was asked.** A summary run that never calls `submit_summary`, or calls it twice, or whose proposals carry an unknown type: at most one `task_summary` is written, bad proposals are rejected with a tool error, and nothing breaks the summarized task's status. Tests in Task 5 and Task 6.
5. **Context pack size.** A project with 200 verified entries and a 50 KB task description yields a pack of at most `OFFICE_CONTEXT_PACK_MAX_CHARS` (default 12 000) that still lists ids; FTS matching uses the task text, not the whole history. Test in Task 4.

---

### Task 1: Shared schemas — messaging, memory, office tools, protocol

**Files:**
- Create: `packages/shared/src/messaging.ts`, `packages/shared/src/memory.ts`, `packages/shared/src/office-tools.ts`
- Modify: `packages/shared/src/enums.ts`, `packages/shared/src/run-spec.ts`, `packages/shared/src/protocol.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/office-tools.test.ts`, `packages/shared/src/run-spec.test.ts` (extend)

**Interfaces:**
- Produces (`messaging.ts`): `ConversationKindSchema = z.enum(['direct','group','task','human'])`; `MessageTypeSchema = z.enum(['message','question','reply','handoff','help_request','escalation','artifact'])`; `DeliveryStatusSchema = z.enum(['pending','delivered','acknowledged'])`; `WAKE_TYPES: MessageType[] = ['question','help_request','handoff','escalation']` (a `reply` to a *waiting* run resumes it; it does not create an inbox run); `MessageLimitsSchema = z.object({ perSession: z.number().int().positive().default(20), perTask: z.number().int().positive().default(100), escalationDepth: z.number().int().nonnegative().default(2), handoffChain: z.number().int().nonnegative().default(3) })`; `type MessageLimits`.
- Produces (`memory.ts`): `MemoryTypeSchema = z.enum(['decision','convention','api_contract','known_issue','lesson','task_summary'])`; `MemoryScopeSchema = z.enum(['project','agent_project','agent'])`; `MemoryStatusSchema = z.enum(['proposed','verified','rejected'])`; `MemorySourceKindSchema = z.enum(['event','message','commit','file','run','task'])`; `MemorySourceInputSchema = z.object({ kind: MemorySourceKindSchema, ref: z.string().min(1), label: z.string().optional() })`; `MemoryProposalSchema = z.object({ type: MemoryTypeSchema.exclude(['task_summary']), title: z.string().min(1).max(200), content: z.string().min(1).max(8000), scope: MemoryScopeSchema.default('project'), sources: z.array(MemorySourceInputSchema).default([]) })`.
- Produces (`office-tools.ts`): the catalogue the worker serves and the API executes:
  ```ts
  export const OFFICE_TOOLS = {
    send_message: { description: '…', input: { to: z.string(), body: z.string().min(1).max(8000), type: z.enum(['message','question','artifact']).default('message'), awaitReply: z.boolean().default(false), taskId: z.string().optional() } },
    reply_message: { description: '…', input: { messageId: z.string(), body: z.string().min(1).max(8000) } },
    read_inbox: { description: '…', input: { limit: z.number().int().positive().max(50).default(20) } },
    get_conversation: { description: '…', input: { conversationId: z.string(), limit: z.number().int().positive().max(100).default(50) } },
    list_agents: { description: '…', input: {} },
    request_help: { description: '…', input: { to: z.string(), body: z.string().min(1).max(8000), awaitReply: z.boolean().default(true) } },
    handoff_task: { description: '…', input: { to: z.string(), body: z.string().min(1).max(8000) } },
    escalate_to_chief: { description: '…', input: { body: z.string().min(1).max(8000), awaitReply: z.boolean().default(true) } },
    search_memory: { description: '…', input: { query: z.string().min(1), type: MemoryTypeSchema.optional(), limit: z.number().int().positive().max(20).default(10) } },
    read_memory: { description: '…', input: { id: z.string() } },
    propose_memory: { description: '…', input: MemoryProposalSchema.shape },
    get_task_history: { description: '…', input: { taskId: z.string().optional(), limit: z.number().int().positive().max(20).default(5) } },
    get_project_decisions: { description: '…', input: { limit: z.number().int().positive().max(50).default(20) } },
    submit_summary: { description: '…', input: { summary: z.string().min(1).max(8000), proposals: z.array(MemoryProposalSchema).max(10).default([]) } },
  } as const satisfies Record<string, { description: string; input: z.ZodRawShape }>;
  export type OfficeToolName = keyof typeof OFFICE_TOOLS;
  export const OFFICE_TOOL_NAMES = Object.keys(OFFICE_TOOLS) as OfficeToolName[];
  export const MCP_SERVER_NAME = 'office';
  export const mcpToolName = (name: OfficeToolName) => `mcp__${MCP_SERVER_NAME}__${name}`;
  export const ToolCallResultSchema = z.object({ ok: z.literal(true), result: z.unknown(), suspend: z.boolean().optional() }).or(z.object({ ok: z.literal(false), error: z.string(), code: z.string() }));
  export type ToolCallResult = z.infer<typeof ToolCallResultSchema>;
  export function parseToolArgs(name: OfficeToolName, args: unknown): Record<string, unknown> // z.object(OFFICE_TOOLS[name].input).parse(args)
  ```
  `to` is an agent **slug** (`list_agents` shows them). The `description` strings are written by the implementer (one or two sentences each; `send_message` must say that `awaitReply: true` ends the current turn and that the reply arrives as the next user message; `read_inbox` must say that reading acknowledges).
- Modifies (`enums.ts`): `EventType` gains `'agent.waiting_reply'` (payload `{ messageId, to }`) and `'agent.resumed'` (payload `{ reason: 'reply' | 'timeout', messageId? }`); `RunStatus` unchanged.
- Modifies (`enums.ts`): `RunKindSchema = z.enum(['task','inbox','plan','review','summary','chat'])`, `type RunKind`. Modifies (`run-spec.ts`): `RunSpecSchema` gains `kind: RunKindSchema.default('task')`, `startSeq: z.number().int().nonnegative().default(0)`, `tools: z.array(z.string()).default([])` (the office tool names this run may call; the worker serves exactly these). `RunResultSchema.status` gains `'suspended'` (`sdkSessionId` required for it; the implementer enforces with `superRefine`).
- Modifies (`protocol.ts`): `WorkerToApiSchema` gains `{ type: 'tool.call', runId, sessionId, callId: z.string(), name: z.string(), args: z.unknown() }`; `ApiToWorkerSchema` gains `{ type: 'tool.result', callId, result: ToolCallResultSchema }`. `UiClientMessageSchema.subscribe.topic` regex becomes `/^(global|run:.+|task:.+|conversation:.+)$/`. `UiServerMessageSchema` gains `{ type: 'message.created', topic, message: MessageViewSchema }` and `{ type: 'memory.changed', topic: z.literal('global'), entryId: z.string(), status: MemoryStatusSchema }`. `MessageViewSchema` (in `messaging.ts`): `{ id, conversationId, projectId, type: MessageTypeSchema, body, createdAt: z.iso.datetime(), senderAgentId: z.string().nullable(), senderUserId: z.string().nullable(), taskId: z.string().nullable(), inReplyToId: z.string().nullable(), deliveries: z.array(z.object({ recipientAgentId: z.string().nullable(), recipientUserId: z.string().nullable(), status: DeliveryStatusSchema })) }`.

- [ ] **Step 1: Write failing tests**

`office-tools.test.ts`: `parseToolArgs('send_message', { to: 'architect', body: 'hi' })` returns `type: 'message'`, `awaitReply: false`; `parseToolArgs('send_message', { to: 'x' })` throws; `mcpToolName('read_inbox') === 'mcp__office__read_inbox'`; `OFFICE_TOOL_NAMES` has 14 names; `ToolCallResultSchema` accepts `{ ok: false, error: 'x', code: 'limit_exceeded' }`.
`run-spec.test.ts`: `RunSpecSchema.parse(minimal)` yields `kind: 'task'`, `startSeq: 0`, `tools: []`; `RunResultSchema.parse({ status: 'suspended', usage, sdkSessionId: 's' })` ok and without `sdkSessionId` throws.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @office/shared test`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the schemas above; export all from `index.ts`**

- [ ] **Step 4: Run tests, typecheck**

Run: `pnpm --filter @office/shared test && pnpm --filter @office/shared build && pnpm typecheck`
Expected: PASS. (`apps/api` and the worker typecheck against `dist`; rebuild shared first.)

- [ ] **Step 5: Commit**

```bash
git add packages/shared && git commit -m "feat(shared): messaging, memory and office tool schemas; tool.call protocol; suspended runs"
```

---

### Task 2: Database — conversations, messages, memory, task-optional runs, summarizer seed

**Files:**
- Modify: `packages/db/prisma/schema.prisma`, `packages/db/src/seed.ts`, `apps/api/test/helpers.ts` (TRUNCATE list), `apps/worker/test/e2e-fake.test.ts` (TRUNCATE list)
- Create: migration `packages/db/prisma/migrations/<ts>_phase3_messaging_memory/migration.sql`, `templates/agents/office-summarizer.json`
- Test: `packages/db/src/seed.test.ts` (extend)

**Interfaces:**
- Schema additions (names are exact; implementers choose indexes beyond the ones listed):
  - `enum ConversationKind { direct group task human }`, `enum MessageType { message question reply handoff help_request escalation artifact }`, `enum DeliveryStatus { pending delivered acknowledged }`, `enum MemoryType { decision convention api_contract known_issue lesson task_summary }`, `enum MemoryScope { project agent_project agent }`, `enum MemoryStatus { proposed verified rejected }`, `enum MemorySourceKind { event message commit file run task }`.
  - `Conversation { id, createdAt, updatedAt @updatedAt, projectId, kind ConversationKind, title String, taskId String? , agentIds String[] , includesOwner Boolean @default(false), sdkSessionId String? , messages Message[], runs TaskRun[] }` with `@@index([projectId, updatedAt])`, `@@index([taskId])`. One `task` conversation per task (`@@unique([taskId, kind])` is not expressible with a nullable; enforce in the service).
  - `Message { id, createdAt, conversationId, projectId, type MessageType, body String, senderAgentId String?, senderUserId String?, senderSessionId String?, taskId String?, inReplyToId String?, awaitingReply Boolean @default(false), idempotencyKey String? @unique, escalationDepth Int @default(0), handoffChain Int @default(0), deliveries MessageDelivery[] }` with `@@index([conversationId, createdAt])`, `@@index([projectId, createdAt])`, `@@index([inReplyToId])`.
  - `MessageDelivery { id, createdAt, messageId, recipientAgentId String?, recipientUserId String?, status DeliveryStatus @default(pending), deliveredAt DateTime?, acknowledgedAt DateTime? }` with `@@unique([messageId, recipientAgentId])`, `@@index([recipientAgentId, status])`.
  - `MemoryEntry { id, createdAt, updatedAt @updatedAt, projectId String?, agentId String?, scope MemoryScope, type MemoryType, title, content, authorType String ('agent'|'user'|'system'), authorAgentId String?, status MemoryStatus @default(proposed), version Int @default(1), supersededById String? , supersedes MemoryEntry? ("Supersedes", fields: [supersededById]), taskId String?, runId String?, verifiedAt DateTime?, embedding Unsupported("vector(1536)")?, search Unsupported("tsvector")?, sources MemorySource[] }` with `@@index([projectId, status, type])`, `@@index([agentId])`, `@@index([taskId])`.
  - `MemorySource { id, memoryEntryId, kind MemorySourceKind, ref String, label String? }` with `@@index([memoryEntryId])`.
  - `TaskRun`: `taskId String?` (relation optional), add `agentId String` and `projectId String` (relations to `Agent` and `Project`; indexes), `conversationId String?`, `waitingSince DateTime?`, `waitingForMessageId String?`, `summaryOfRunId String?` (set on summary runs: the run they summarize), `summarizedAt DateTime?` (set on task runs once their summary run was created). `AgentSession` gains `contextPack Json?`. `Agent` gains `isSystem Boolean @default(false)`.
  - Migration SQL, hand-edited after `prisma migrate dev --create-only`: `CREATE EXTENSION IF NOT EXISTS vector;` first; `ALTER TABLE "MemoryEntry" ADD COLUMN "search" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("title",'') || ' ' || coalesce("content",''))) STORED;` and `CREATE INDEX "MemoryEntry_search_idx" ON "MemoryEntry" USING GIN ("search");`; backfill `UPDATE "TaskRun" r SET "agentId" = t."agentId", "projectId" = t."projectId" FROM "Task" t WHERE r."taskId" = t.id;` before adding the NOT NULL constraints.
- Seed: `templates/agents/office-summarizer.json` = `{ name: 'Office Summarizer', slug: 'office-summarizer', role: 'system', description: 'Writes the task summary and proposes memory after every run.', isSystem: true, config: { systemPrompt: <the summarizer prompt: it receives run evidence and must call submit_summary exactly once with a factual summary (what was asked, what was done, what was verified, what failed) and zero or more proposals typed decision, convention, api_contract, known_issue or lesson, each with the evidence refs it was given; it must not invent facts>, model: 'haiku', allowedTools: [], maxTurns: 6, maxBudgetUsd: 0.1, maxConcurrentSubagents: 0, maxSubagentDepth: 0 } }`. `AgentTemplate` gains `isSystem?: boolean`; `seed()` passes it to `agent.create`. Existing seeded agents are untouched (idempotent by slug).
- TRUNCATE lists gain, in dependency order: `"MemorySource","MemoryEntry","MessageDelivery","Message","Conversation"` before `"SubagentRun"`.

- [ ] **Step 1: Write failing test**

`seed.test.ts`: after `seed()`, `agent.findUnique({ where: { slug: 'office-summarizer' } })` has `isSystem: true` and `currentVersionId` set; the 5 team agents still have `isSystem: false`.

- [ ] **Step 2: Schema, migration, seed; regenerate and build**

Run: `pnpm --filter @office/db exec prisma migrate dev --name phase3_messaging_memory --create-only`, edit the SQL as specified, then `pnpm db:migrate && pnpm --filter @office/db build`. Apply to the test database too (`DATABASE_URL=$DATABASE_URL_TEST pnpm db:migrate`).

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @office/db test && pnpm typecheck`
Expected: PASS. (API typecheck breaks where `TaskRun.taskId` was non-null: fix only compile errors with `run.taskId!` guards where the run is known to be a task run; Task 6 restructures properly.)

- [ ] **Step 4: Commit**

```bash
git add packages/db templates apps/api/test/helpers.ts apps/worker/test/e2e-fake.test.ts && git commit -m "feat(db): conversations, messages, deliveries, memory entries with FTS; task-optional runs; summarizer agent"
```

---

### Task 3: API — message service, conversations routes, limits

**Files:**
- Create: `apps/api/src/services/message-service.ts`, `apps/api/src/routes/conversations.ts`
- Modify: `apps/api/src/config.ts` (`messageLimits: MessageLimits` from `OFFICE_MSG_PER_SESSION`, `OFFICE_MSG_PER_TASK`, `OFFICE_ESCALATION_DEPTH`, `OFFICE_HANDOFF_CHAIN`; `replyTimeoutMinutes` from `OFFICE_REPLY_TIMEOUT_MINUTES` default 60; `contextPackMaxChars` from `OFFICE_CONTEXT_PACK_MAX_CHARS` default 12000), `apps/api/src/app.ts` (register routes), `apps/api/src/services/event-hub.ts` (`HubMessage` gains the two new UI message shapes), `apps/api/src/ws/ui-gateway.ts` (`conversation:` topics are plain hub topics, like `task:`), `.env.example`
- Test: `apps/api/test/messages.test.ts`

**Interfaces:**
- Produces (`message-service.ts`), all taking `Db` (client or transaction) unless noted:
  - `class MessageError extends Error { constructor(public code: 'not_found' | 'self_message' | 'limit_exceeded' | 'unknown_recipient' | 'bad_reply' | 'forbidden', message: string) }`.
  - `findOrCreateConversation(db, { projectId, kind, agentIds, includesOwner, title, taskId? }): Promise<Conversation>` — `task` kind: one per task (find by `taskId`, else create with title = task title); `direct`: one per unordered pair of `agentIds` (and `includesOwner` false); `human`: one per `(agentIds[0], includesOwner: true)`; `group`: always create.
  - `sendMessage(db, limits, input: { projectId, conversationId?, kind?, type, body, senderAgentId?, senderUserId?, senderSessionId?, senderRunId?, taskId?, recipientAgentIds: string[], recipientUser?: boolean, inReplyToId?, awaitReply?, idempotencyKey? }): Promise<{ message: Message; deliveries: MessageDelivery[]; created: boolean }>` — resolves or creates the conversation (`kind` default: `task` when `taskId`, `human` when owner involved, else `direct`), rejects a sender who is also a recipient (`self_message`), unknown or `isSystem` recipients (`unknown_recipient`), enforces `limits.perSession` (messages with this `senderSessionId`) and `limits.perTask` (messages with this `taskId`) → `limit_exceeded`; `escalation`: `escalationDepth = (parent?.escalationDepth ?? 0) + 1`, rejected above `limits.escalationDepth`; `handoff`: `handoffChain` likewise; `reply`: `inReplyToId` must name a message in the same project whose deliveries include the sender (`bad_reply`); `idempotencyKey` present and existing → returns the existing message with `created: false`; writes one `MessageDelivery` per recipient; bumps `Conversation.updatedAt`.
  - `readInbox(db, { agentId, projectId, limit }): Promise<MessageView[]>` — pending or delivered deliveries for the agent in the project, oldest first, marks them `acknowledged` (`acknowledgedAt`).
  - `markDelivered(db, deliveryIds: string[])`.
  - `pendingWakeDeliveries(db): Promise<Array<{ agentId: string; projectId: string; conversationId: string }>>` — distinct (agent, project) with a `pending` delivery whose message `type` is in `WAKE_TYPES` and whose recipient is an agent (Task 6 uses it).
  - `conversationView(db, id)`, `listConversations(db, { projectId, kind?, agentId?, includesOwner? })` returning `{ ...conversation, lastMessage, unreadForOwner: number, activeRun?: { id, status } }`.
  - `toMessageView(message with deliveries): MessageView`; after a commit the caller publishes `{ type: 'message.created', message }` to `conversation:<id>` and `global` (helper `queueMessageCreated(outbox, view)`).
- Routes (`conversations.ts`, cookie-authenticated): `GET /conversations?projectId=&kind=` → `listConversations`; `POST /conversations { projectId, kind: 'direct'|'group'|'human', agentIds, title? }` → 201 conversation; `GET /conversations/:id` → view with `messages` (ascending, each `MessageView`) and `activeRun`; `POST /conversations/:id/messages { type: 'message'|'question', body, recipientAgentIds? }` (owner sends; recipients default to the conversation's `agentIds`) → 201 `MessageView`, publishes `message.created`; `GET /messages/search?projectId=&q=` → up to 50 `MessageView` by `ILIKE` on body. Errors: `MessageError` → 400 `{ error: code }` except `not_found` → 404 (add to the app error handler).

- [ ] **Step 1: Write failing tests** (`messages.test.ts`, with `makeApp()`; seed two agents and a project directly through Prisma)

- `owner creates a human conversation and sends a question`: 201, one message, one `pending` delivery to the agent, `GET /conversations/:id` shows it, hub `global` listener saw `message.created`.
- `direct conversations are reused per pair`: two `sendMessage` calls agent A→B and B→A land in one conversation.
- `self message, unknown recipient and system recipient are rejected`: codes `self_message`, `unknown_recipient`, `unknown_recipient`.
- `limits`: 20 messages from one `senderSessionId` ok, 21st → `limit_exceeded`; escalation depth 3 → `limit_exceeded`; handoff chain 4 → `limit_exceeded`.
- `idempotency`: same `idempotencyKey` twice → one row, second `created: false`.
- `reply must answer a message delivered to the sender`: `bad_reply` otherwise; a good reply gets `inReplyToId` and type `reply`.
- `readInbox acknowledges and returns oldest first`; a second read returns nothing.
- `pendingWakeDeliveries lists question but not message`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @office/api test -- messages`
Expected: FAIL.

- [ ] **Step 3: Implement the service, routes, config, error mapping**

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @office/api test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api .env.example && git commit -m "feat(api): message bus: conversations, deliveries, limits, owner messaging routes"
```

---

### Task 4: API — memory service, routes, context pack

**Files:**
- Create: `apps/api/src/services/memory-service.ts`, `apps/api/src/services/context-pack.ts`, `apps/api/src/routes/memory.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/memory.test.ts`

**Interfaces:**
- Produces (`memory-service.ts`):
  - `createEntry(db, input: { projectId?, agentId?, scope, type, title, content, authorType, authorAgentId?, status, taskId?, runId?, sources: MemorySourceInput[] }): Promise<MemoryEntry & { sources }>`.
  - `searchMemory(db, { projectId, q?, type?, status?, agentId?, limit = 20 }): Promise<MemoryEntryView[]>` — with `q`: raw SQL `WHERE "projectId" = $1 AND "supersededById" IS NULL AND "search" @@ plainto_tsquery('english', $2) ORDER BY ts_rank("search", plainto_tsquery('english', $2)) DESC LIMIT $n` (plus the optional filters); without `q`: Prisma query ordered by `updatedAt desc`. `MemoryEntryView` = entry + `sources` + `supersedes: { id, version } | null`.
  - `getEntry(db, id, projectId)`: entry with sources and `revisions` (the `supersedes` chain, newest first); `not_found` when the project differs.
  - `verifyEntry(db, id, projectId)`, `rejectEntry(db, id, projectId)` → status change, `verifiedAt`; `supersedeEntry(db, id, projectId, { title, content, type?, sources })` → creates version `n+1` (status `verified` when the owner does it, `proposed` when an agent does), sets `supersededById` on the old row; `deleteEntry(db, id, projectId)` → hard delete (the artboard's 30-day purge is deferred; note it in docs).
  - `taskHistory(db, { projectId, taskId?, limit })` → verified `task_summary` entries, newest first; `projectDecisions(db, { projectId, limit })` → verified `decision` and `api_contract` entries.
  - After each status change the route publishes `{ type: 'memory.changed', topic: 'global', entryId, status }`.
- Produces (`context-pack.ts`): `buildContextPack(db, { projectId, agentId, taskText, maxChars }): Promise<{ text: string; entryIds: string[]; summaryIds: string[]; inboxCount: number }>` — sections in order, each cut at the cap: (1) the verified entry titled `Project overview` if one exists; (2) up to 10 verified entries matching `taskText` (FTS, `plainto_tsquery` on the first 2 000 chars of `taskText`), rendered `- [m:<id>] <type> · <title>: <content first 400 chars>`; (3) the last 3 `task_summary` entries of the project; (4) `pending` and `delivered` inbox deliveries for the agent: count and the first 120 chars of up to 5 bodies; (5) the agent's own `agent` and `agent_project` scope `lesson` entries (verified, up to 5). Header: `## Context pack\nCite entries by id (m:<id>). Entries are facts verified by the owner; the inbox is unread mail.` Returns empty text when nothing applies.
- Routes (`memory.ts`): `GET /memory?projectId=&q=&type=&status=` → `searchMemory`; `POST /memory { projectId, type, scope?, title, content, sources? }` (owner; `authorType: 'user'`, `status: 'verified'`) → 201; `GET /memory/:id?projectId=` → `getEntry`; `POST /memory/:id/verify`, `POST /memory/:id/reject`, `PUT /memory/:id { title, content, type?, sources? }` → `supersedeEntry`, `DELETE /memory/:id`. `GET /memory/counts?projectId=` → `{ proposed: number }` (sidebar badge).

- [ ] **Step 1: Write failing tests** (`memory.test.ts`)

- `owner adds a verified decision and finds it by keyword`: `POST /memory` then `GET /memory?q=token+rotation` ranks it first; `GET /memory?q=nothingness` is empty.
- `proposed entries are not returned to the context pack`: one proposed + one verified entry mentioning "login validation"; `buildContextPack` lists only the verified id in `entryIds`.
- `supersede keeps the chain`: `PUT /memory/:id` → new id, version 2, old row `supersededById` set, `GET /memory/:newId` has `revisions` of length 2; search returns only the new one.
- `project isolation`: `GET /memory/:id?projectId=<other>` → 404.
- `context pack caps size`: 200 verified entries of 2 KB each + a 50 KB task text → `text.length <= 12000`, `entryIds.length >= 1`, inbox section counts a pending delivery.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @office/api test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): memory entries with FTS, verification, supersede; context pack"
```

---

### Task 5: API — tool execution and the worker `tool.call` channel

**Files:**
- Create: `apps/api/src/services/tool-service.ts`
- Modify: `apps/api/src/ws/worker-gateway.ts`
- Test: `apps/api/test/tools.test.ts`, `apps/api/test/worker-gateway.test.ts` (extend)

**Interfaces:**
- Produces (`tool-service.ts`): `executeTool(prisma, hub, config, ctx: { run: TaskRun; session: AgentSession }, name: string, rawArgs: unknown): Promise<ToolCallResult>`:
  - Unknown name or name not in `run`'s allowed `tools` (Task 6 stores them on the spec; here re-derived with `toolsForKind(run.kind)`) → `{ ok: false, code: 'unknown_tool' }`; bad args (`parseToolArgs` throws) → `{ ok: false, code: 'invalid_args', error: <zod message> }`; `MessageError` / memory `not_found` → `{ ok: false, code }`.
  - `toolsForKind(kind: RunKind): OfficeToolName[]`: `task` and `chat` → all messaging and memory tools except `submit_summary`; `inbox` → the same minus `awaitReply` (the service rejects `awaitReply: true` from an inbox run with code `not_allowed`); `summary` → `submit_summary` only.
  - Messaging tools call `sendMessage` with `senderAgentId = session.agentId`, `senderSessionId = session.id`, `senderRunId = run.id`, `projectId = session.projectId`, `taskId = run.taskId ?? undefined`; `to` resolves slug → agent id within active non-system agents (`unknown_recipient`). `request_help` = type `help_request`; `handoff_task` = type `handoff` plus, when `run.taskId` is set and the task's `agentId` is the sender, `task.agentId := recipient` (the task continues with the new agent on its next run; recorded as a Phase 3 decision); `escalate_to_chief` = type `escalation` to the agent with slug `chief` (`unknown_recipient` when absent).
  - `awaitReply: true` (from `send_message`, `request_help`, `escalate_to_chief`): the message is written with `awaitingReply: true`, the run row gets `waitingForMessageId = message.id`, and the result is `{ ok: true, result: { messageId, conversationId, note: 'Your turn ends now; the reply arrives as your next user message.' }, suspend: true }`. The run status change itself happens when the worker reports the `suspended` result (Task 6).
  - `read_inbox` → `readInbox`; also marks the run's session as the reader (`markDelivered` first, then acknowledge). `get_conversation` → messages of a conversation in the session's project. `list_agents` → `{ slug, name, role }` of active non-system agents.
  - Memory tools: `search_memory` → verified entries in the project (`searchMemory` with `status: 'verified'`); `read_memory` → `getEntry` (verified or the agent's own proposals); `propose_memory` → `createEntry` with `authorType: 'agent'`, `status: 'proposed'`, `runId`, `taskId`, sources from args plus `{ kind: 'run', ref: run.id }`; `get_task_history`, `get_project_decisions` → the service functions.
  - `submit_summary` (summary runs only): the summarized run is `run.summaryOfRunId` (column from Task 2). Writes one `task_summary` entry (`authorType: 'system'`, `status: 'verified'`, `taskId`, `runId: summaryOfRunId`, sources `{ run }`, `{ task }`) and the proposals (`proposed`, author the summarized run's agent, same sources); a second call in the same run → `{ ok: false, code: 'already_submitted' }`; the entry id is returned.
  - Every successful messaging call publishes `message.created`; `propose_memory` and `submit_summary` publish `memory.changed`.
- Modifies (`worker-gateway.ts`): `case 'tool.call'`: `findLeasedRun`; no live lease or session mismatch → reply `tool.result { ok: false, code: 'no_lease' }`; otherwise `executeTool` and reply `tool.result { callId, result }`. Tool calls are handled through the socket's ordered chain like other messages. `recordSubagentEvent` untouched.

- [ ] **Step 1: Write failing tests**

`tools.test.ts` (direct service tests with a leased run and session created through Prisma):
- `send_message to another agent writes the message and a pending delivery; result carries messageId`.
- `awaitReply suspends: result.suspend is true and the run has waitingForMessageId`.
- `inbox run cannot awaitReply` → `not_allowed`.
- `handoff_task reassigns the task to the recipient`.
- `tool calls cannot cross projects`: `get_conversation` with another project's conversation id → `not_found`; `read_memory` likewise.
- `propose_memory writes a proposed entry with a run source`.
- `submit_summary writes one verified task_summary; second call → already_submitted; a proposal with type task_summary → invalid_args`.
- `unknown tool → unknown_tool; summary run calling send_message → unknown_tool`.
`worker-gateway.test.ts`: a `tool.call` from a worker without a lease on that run gets `tool.result { ok: false, code: 'no_lease' }`; with a lease, `list_agents` returns the seeded agents.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @office/api test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): execute office tools for leased runs over the worker socket"
```

---

### Task 6: API — run lifecycle: kinds, suspend/resume, inbox wakes, summary runs, context pack

**Files:**
- Modify: `apps/api/src/services/run-service.ts`, `apps/api/src/services/scheduler.ts`, `apps/api/src/services/task-service.ts` (status writers tolerate task-less runs), `apps/api/src/routes/runs.ts` (`GET /runs/:id` includes `kind`, `conversationId`, `session.contextPack`), `apps/api/src/routes/tasks.ts` (`GET /tasks/:id` runs include `kind`, `session.contextPack`)
- Test: `apps/api/test/scheduler.test.ts` (extend), `apps/api/test/runs.test.ts` (new)

**Interfaces:**
- `createRunForTask` becomes `createRun(prisma, hub, config, input: { kind: RunKind; agentId; projectId; taskId?; conversationId?; prompt; worker; resumeSdkSessionId?; startSeq?; summaryOfRunId?; contextPack?: boolean })` returning `{ run, session, spec }`; keeps the Phase 2 body (version, skills, snapshot) and adds: `spec.kind`, `spec.tools = toolsForKind(kind)`, `spec.startSeq`, `systemPrompt = cfg.systemPrompt + skills section + messagingSection(kind) + contextPack.text` where `messagingSection` is a fixed paragraph per kind: for `task`/`chat`: `You can message teammates with the office tools (list_agents, send_message, read_inbox, …). Check read_inbox when you are blocked or when the context pack reports unread mail. Propose durable knowledge with propose_memory; the owner verifies it.`; for `inbox`: `You were woken to answer your inbox. Call read_inbox, reply to each question with reply_message, then stop. Do not start new work.`; for `summary`: `Call submit_summary exactly once.` The pack is stored on `AgentSession.contextPack` (`{ entryIds, summaryIds, inboxCount, chars }`). Inbox runs: `maxTurns = min(cfg.maxTurns, 8)`, `maxBudgetUsd = min(cfg.maxBudgetUsd, 0.25)`, `allowedTools = cfg.allowedTools.filter(t => ['Read','Glob','Grep'].includes(t))`. Summary runs: `allowedTools = []`, no skills, no subagents, `cwd = project.repoPath` (unused), prompt = `summaryPrompt(evidence)` where evidence = the summarized run's `resultText`, `error`, the first 200 events as `seq type summary` lines (reuse the event `summary()` rules from the web log: tool + command/path, text first 120 chars), the messages sent and received in that run, and the task title and description; capped at 20 000 chars.
  - A task run keeps the Phase 1 behaviour (attempts, `queued` task status). `kind: 'inbox' | 'chat'` runs have `taskId: null` and never touch task status.
- `completeRun`:
  - `result.status === 'suspended'` → run `waiting_reply`, `waitingSince = now`, `workerId` kept but lease cleared (`leaseExpiresAt = null`), session `status: 'waiting_reply'`, `sdkSessionId` stored, task (if any) → `waiting_reply`, `run.status.changed`; the worker slot is released by the gateway as for any result. Usage recorded as usual.
  - Summary runs are created by the scheduler, not here (runs exist only once assigned to a worker): the scheduler finds `TaskRun` rows with `kind = 'task'`, `status in (succeeded, failed)` and `summarizedAt IS NULL`; for each, when the `office-summarizer` agent exists and a worker is eligible for the project, it calls `createRun({ kind: 'summary', agentId: summarizer.id, projectId, taskId: run.taskId, summaryOfRunId: run.id, … })` and sets `summarizedAt`. Cancelled runs and runs of other kinds are never summarized.
- `Scheduler.run()` gains, after the ready-task loop, in this order: (a) **resume**: runs in `waiting_reply` where a `reply` message with `inReplyToId = waitingForMessageId` exists, or `waitingSince < now - replyTimeoutMinutes` → `resumeRun(runId, { reason })`: guarded `updateMany({ where: { id, status: 'waiting_reply' } })` to `queued` on an eligible worker with a fresh lease, `resumeSdkSessionId = session.sdkSessionId`, `startSeq = max(seq) of the session`, prompt = the reply body prefixed `Reply from <sender slug>:\n` (or `No reply was received within <n> minutes. Continue or escalate.`), `run.assign` sent; appends an `agent.resumed` event server-side (add it to `SERVER_ONLY_EVENTS`), task → `running` on `run.accepted` as today; (b) **wake**: for each `(agentId, projectId)` from `pendingWakeDeliveries` with no run of that agent in `queued|running|waiting_reply` in that project, `createRun({ kind: conversation.kind === 'human' ? 'chat' : 'inbox', … , conversationId, resumeSdkSessionId: conversation.sdkSessionId for chat, prompt: 'You have new messages. Read your inbox and answer.' })`; a chat run that completes stores its `sdkSessionId` on `Conversation.sdkSessionId`; (c) **summaries** as above. Each phase is wrapped in its own try/catch like `expireLeases`.
- `expireLeases` ignores `waiting_reply` runs (no lease). `cancelTask` also cancels `waiting_reply` runs of the task.

- [ ] **Step 1: Write failing tests**

`runs.test.ts` (uses `connectFakeWorker` and `app.scheduler.tick()`):
- `a suspended result parks the run and frees the worker`: create task, tick → assign; worker sends `run.accepted`, then `run.result { status: 'suspended', sdkSessionId: 'sdk-1' }`; run `waiting_reply`, task `waiting_reply`, `leaseExpiresAt` null, `onlineWorkers()[0].activeRuns === 0`.
- `a reply resumes the run once with the SDK session and startSeq`: insert a `reply` message to the waited message via `sendMessage`; tick → worker receives `run.assign` with `resumeSdkSessionId: 'sdk-1'`, `startSeq` = last seq, prompt containing the reply body; a second tick sends no second assign; run `queued`.
- `timeout resumes with the no-reply prompt` (`OFFICE_REPLY_TIMEOUT_MINUTES=0` in the test config).
- `a cancelled waiting run is not resumed`: cancel the task, insert the reply, tick → no assign.
- `a question to an idle agent creates an inbox run; a plain message does not`: `sendMessage` question A→B; tick → `run.assign` with `kind: 'inbox'`, `taskId` null, `tools` without… (assert `spec.kind === 'inbox'` and `spec.maxTurns <= 8`); a `message` type alone → no assign.
- `a finished task run gets one summary run for office-summarizer`: complete a task run; tick → assign with `kind: 'summary'`, `agentId` = summarizer, prompt contains the task title; `summarizedAt` set; a second tick creates none; the summary run's own completion creates none.
- `context pack reaches the spec and the session`: a verified entry whose title matches the task → `spec.systemPrompt` contains `m:<id>` and `session.contextPack.entryIds` includes it.
`scheduler.test.ts`: existing cases still pass with `createRun`.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @office/api test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): run kinds, suspend and resume on reply, inbox wakes, summary runs, context pack"
```

---

### Task 7: Runtime — tool bridge, in-process office MCP server, suspend, fake markers

**Files:**
- Modify: `packages/runtime/src/types.ts`, `packages/runtime/src/claude/adapter.ts`, `packages/runtime/src/fake/adapter.ts`, `packages/runtime/src/index.ts`
- Test: `packages/runtime/src/claude/adapter.test.ts` (extend), `packages/runtime/src/fake/adapter.test.ts` (new)

**Interfaces:**
- Produces (`types.ts`): `interface ToolBridge { call(name: OfficeToolName, args: Record<string, unknown>): Promise<ToolCallResult> }`; `RuntimeAdapter.run(spec, sink, signal, tools?: ToolBridge)`.
- `ClaudeAdapter`: when `spec.tools.length > 0` and `tools` is given, builds `createSdkMcpServer({ name: MCP_SERVER_NAME, version: '1.0.0', tools: spec.tools.map(name => tool(name, OFFICE_TOOLS[name].description, OFFICE_TOOLS[name].input, async (args) => { const r = await tools.call(name, args); if (!r.ok) return { content: [{ type: 'text', text: `Error ${r.code}: ${r.error}` }], isError: true }; if (r.suspend) suspend(); return { content: [{ type: 'text', text: JSON.stringify(r.result) }] }; })) })` and passes `mcpServers: { office: server }`, `strictMcpConfig: true`; `allowedTools` gains `mcpToolName(name)` for each served tool; `disallowedTools` drops the `'mcp__*'` wildcard (strict MCP config leaves no other server). `suspend()` sets a flag and calls `q.interrupt()` after the current tool result is returned (schedule with `setTimeout(…, 0)` so the result reaches the CLI first). When the flag is set, whatever `result` message arrives (success, `error_during_execution`, or none) maps to `{ status: 'suspended', sdkSessionId, usage }`; `sdkSessionId` comes from the `system.init` message when the result lacks it.
- `FakeAdapter` markers, each on its own line of `spec.prompt`, executed in order before the existing behaviour, with `tools` when given: `SEND:<slug>:<text>` → `send_message { to, body }`; `ASK:<slug>:<text>` → `send_message { to, body, type: 'question', awaitReply: true }` and, when the result has `suspend`, emits `agent.waiting_reply` and returns `{ status: 'suspended', sdkSessionId: 'fake-' + spec.sessionId, usage }` immediately; `INBOX` (also implied by `spec.kind === 'inbox'`) → `read_inbox`, then `reply_message { messageId, body: 'fake reply: ' + body }` for each message of type `question` or `help_request` or `escalation`; `MEMO:<title>` → `propose_memory { type: 'lesson', title, content: 'fake lesson', sources: [] }`; a prompt whose `spec.kind === 'summary'` → `submit_summary { summary: 'fake summary of ' + first prompt line, proposals: [{ type: 'lesson', title: 'fake proposal', content: 'from summary', sources: [] }] }`. A resumed run (`spec.resumeSdkSessionId` set) emits `agent.text` with the prompt and completes. Tool errors are emitted as `agent.tool.failed` with the code and do not stop the run.

- [ ] **Step 1: Write failing tests**

`fake/adapter.test.ts` with a recording bridge: `ASK` returns `suspended` after one `send_message` call with `awaitReply: true`; `INBOX` with a bridge that returns one question replies once; summary kind calls `submit_summary` once; a resumed spec completes without tool calls.
`claude/adapter.test.ts`: `effectiveAllowedTools` (or a new `toolSurface(spec)`) includes `mcp__office__read_inbox` when `spec.tools = ['read_inbox']` and the `disallowedTools` list contains no `mcp__*` entry; with `tools: []` the `office` server is not built (test the option builder, not `query`).

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @office/runtime test && pnpm --filter @office/runtime build && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime && git commit -m "feat(runtime): office tool bridge as in-process MCP server; suspend on awaitReply; fake markers"
```

---

### Task 8: Worker — tool relay, resumed numbering, Phase 3 fake end-to-end

**Files:**
- Modify: `apps/worker/src/executor.ts`, `apps/worker/src/connection.ts`
- Test: `apps/worker/test/executor.test.ts` (extend), `apps/worker/test/e2e-phase3.test.ts` (new)

**Interfaces:**
- `RunExecutor` gains `resolveTool(callId: string, result: ToolCallResult)` and builds a `ToolBridge` per run: `call(name, args)` sends `{ type: 'tool.call', runId, sessionId, callId: randomUUID(), name, args }`, waits up to 30 s for `tool.result` (`{ ok: false, code: 'timeout' }` after), rejects immediately with `{ ok: false, code: 'disconnected' }` when the socket is closed (connection calls `executor.failPendingTools()` on close). After a successful call it emits the derived event: `agent.message.sent { messageId, to, type }` for the five messaging senders, `agent.message.received { count }` for `read_inbox`, `memory.proposed { entryId }` for `propose_memory`, `agent.waiting_reply { messageId }` when `suspend` is set. `seq` starts at `spec.startSeq`. Skills are not materialized for `kind: 'summary'`.
- `WorkerConnection.onMessage` routes `tool.result` to `executor.resolveTool`.
- `e2e-phase3.test.ts` (same harness as `e2e-fake.test.ts`; two worker connections or one with capacity 2; agents seeded through `seed()` so `office-summarizer` exists; `OFFICE_REPLY_TIMEOUT_MINUTES` default):
  1. Task for `developer`: description `ASK:architect:Which database?\nMEMO:Use Postgres`. Expect: run → `waiting_reply`, task `waiting_reply`, a `question` message with a pending delivery to `architect`, event `agent.waiting_reply` persisted.
  2. Tick → an inbox run for `architect` (kind `inbox`, `taskId` null) runs with the fake `INBOX` behaviour (Task 7: `spec.kind === 'inbox'` behaves as the `INBOX` marker). Expect: delivery `acknowledged`, a `reply` message, the inbox run `succeeded`.
  3. Tick → the developer run resumes (`resumeSdkSessionId` = `fake-<sessionId>`, `startSeq` continues: the resumed events have `seq` greater than the suspended ones), completes, task `done`.
  4. Tick → summary run for `office-summarizer` runs and submits: a verified `task_summary` with sources `run` and `task`, and one proposed `lesson` from the summary plus the `MEMO` proposal from the developer.
  5. All sessions have `endedAt`; `GET /conversations/:id` lists question and reply with deliveries; `GET /memory?projectId&q=Postgres` returns the proposal; verify the summary via `POST /memory/:id/verify` is a no-op (already verified); `GET /memory/:summaryId` has sources.
  6. A new task for `developer` (`echo`): its `session.contextPack.summaryIds` includes the summary id.

- [ ] **Step 1: Write failing tests**

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @office/worker test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker && git commit -m "feat(worker): relay office tool calls; resumed seq; phase 3 fake end-to-end"
```

---

### Task 9: Web — Conversations

**Files:**
- Create: `apps/web/src/app/conversations/page.tsx`, `apps/web/src/components/conversation-list.tsx`, `apps/web/src/components/message-thread.tsx`, `apps/web/src/components/message-composer.tsx`, `apps/web/src/components/ui/message-bubble.tsx`, `apps/web/src/components/ui/segmented.tsx` (filter pills All/Direct/Task/Group/You), `apps/web/src/components/ui/search-input.tsx`
- Modify: `apps/web/src/lib/queries.ts` (types `Conversation`, `MessageView`, hooks `useConversations(projectId, kind?)`, `useConversation(id)`, `useMessageSearch`), `apps/web/src/components/app-sidebar.tsx` (nav entry `Conversations` → `/conversations`, icon `MessagesSquare`, pink count = conversations with `unreadForOwner > 0`), `apps/web/src/lib/ws.ts` (no change needed; topics are strings), `apps/web/e2e/pages.spec.ts` (add `/conversations` to `STATIC`)
- Test: `apps/web/src/lib/conversations.test.ts` (pure helpers: `conversationTitle(c, agents, me)`, `groupByDay(messages)`)

**Interfaces (from the artboard `project/Conversations.dc.html`):**
- Page header: title `Conversations`, description `Every message is saved before delivery. Agents talk to each other directly, and you can join any thread.`, actions `New group` (dialog: title + agent checkboxes → `POST /conversations { kind: 'group' }`) and `Message an agent` (agent select → `POST /conversations { kind: 'human', agentIds: [id] }`).
- Two-column layout inside one glass panel: left (`flex-[2_1_320px]`): search input, segmented filter, list rows = `AgentAvatar` of the last sender, title, time (mono), last message preview, kind tag (`Task`/`Direct`/`Group`/`You`), task code chip when `taskId`, unread dot; right (`flex-[3_1_480px]`): thread header (title, kind label, task chip, participants avatars), messages as `MessageBubble` (sender avatar, `Sender to Recipient`, time, type tag `Question`/`Reply`/`Note`/`Handoff`/`Escalation`, body as text, delivery line `Read HH:MM` or `Saved · delivers at the next session boundary` when every delivery is pending), composer with type toggle (`Note` = `message`, `Question` = `question`) and `Send` → `POST /conversations/:id/messages`. A side card `Linked task` (title, status pill, link) when `taskId`, and `Participants` (agents with role; status dot live when the conversation has `activeRun` running).
- Live updates: subscribe `conversation:<id>` on the open thread and `global` for the list; on `message.created` invalidate the queries. Owner messages appear with the `You` avatar (`senderUserId`).

- [ ] **Step 1: Write failing tests** (`conversations.test.ts`): `conversationTitle` for `human` → `You and <Agent>`, `direct` → `<A> and <B>`, `task` → task title, `group` → title; `groupByDay` splits by local date.

- [ ] **Step 2: Implement; run** `pnpm --filter @office/web test && pnpm --filter @office/web lint && pnpm --filter @office/web typecheck && pnpm --filter @office/web build`
Expected: PASS, 0 lint errors.

- [ ] **Step 3: Playwright**: with API and web up, `OFFICE_E2E_EMAIL=… OFFICE_E2E_PASSWORD=… pnpm --filter @office/web e2e` passes with `/conversations` included; add a test `owner messages an agent`: click `Message an agent`, pick the first agent, send a Note, expect the bubble and the `Saved · delivers at the next session boundary` line.

- [ ] **Step 4: Commit**

```bash
git add apps/web && git commit -m "feat(web): Conversations: list, thread, composer, live updates"
```

---

### Task 10: Web — Project Memory, context pack chips, task conversation link

**Files:**
- Create: `apps/web/src/app/memory/page.tsx`, `apps/web/src/components/memory-list.tsx`, `apps/web/src/components/memory-detail.tsx`, `apps/web/src/components/memory-form.tsx`, `apps/web/src/components/ui/type-tag.tsx` (memory type and status tags: `Decision`, `Known issue`, `Knowledge` (= convention + api_contract), `Task history`, `Agent learning` (= lesson); statuses `Verified`, `Needs review`, `Rejected`)
- Modify: `apps/web/src/lib/queries.ts` (`MemoryEntry`, `useMemory(projectId, { q, type, status })`, `useMemoryEntry(id)`, `useMemoryCounts`), `apps/web/src/components/app-sidebar.tsx` (nav `Project Memory` → `/memory`, icon `Database`, amber count = `proposed`), `apps/web/src/components/task-detail.tsx` and `apps/web/src/app/tasks/[id]/page.tsx` (a `Context pack` row under the run: `n entries · m summaries · k unread` from `session.contextPack`, linking to `/memory`; a `Conversation` link to `/conversations?taskId=` when a task conversation exists), `apps/web/e2e/pages.spec.ts` (add `/memory`)
- Test: `apps/web/src/lib/memory.test.ts` (`memoryTypeLabel`, `memoryStatusTone`)

**Interfaces (from `project/ProjectMemory.dc.html`):**
- Header: `Project Memory`, `Curated knowledge for <project>. Every entry keeps its sources, and nothing generated becomes a fact until it is verified.`, action `Add memory` (form: type, title, content → `POST /memory`).
- Search panel: search input (`q`), type pills (`All types`, `Decision`, `Task history`, `Known issue`, `Knowledge`, `Agent learning`), a review banner when `proposed > 0`: `<n> entries need review.` + `Review now` (sets status filter `proposed`).
- Two columns: list (`<x> of <y> entries`, each: type tag, status tag, `v<n> · time`, title, content preview, author avatar + name, task chip, source refs mono) and detail (type, `Verified by you` / `Needs review`, title, content, actions `Verify`/`Reject` when proposed, `Edit` (opens the form prefilled → `PUT /memory/:id` creates the next version), `Delete` (confirm); `Where this came from` list of sources by kind with labels; `Revisions` list from `revisions`; footer `Kept until superseded.`).
- Live: subscribe `global`; on `memory.changed` invalidate.

- [ ] **Step 1: Write failing tests**; **Step 2: Implement**; run `pnpm --filter @office/web test && lint && typecheck && build` → PASS.

- [ ] **Step 3: Playwright**: `/memory` in `STATIC`; test `owner adds and verifies memory`: `Add memory` → fill → appears in the list with `Verified`; with a proposed entry created through the API, `Review now` filters and `Verify` changes the tag.

- [ ] **Step 4: Commit**

```bash
git add apps/web && git commit -m "feat(web): Project Memory: search, review, sources, revisions; context pack chips"
```

---

### Task 11: Docs, real Claude acceptance, progress

**Files:**
- Modify: `docs/progress.md`, `docs/architecture.md`, `docs/worker-protocol.md`, `docs/security.md`, `docs/development.md`, `README.md`, `CLAUDE.md`
- Create: `packages/runtime/scripts/smoke-messaging.ts` (optional, only if the acceptance below needs a cheaper probe)

**Interfaces:**
- Standing decisions to add to `CLAUDE.md` and `docs/progress.md` ("Phase 3 decisions"): delivery into a live session is at session boundaries (no streaming input yet); `question`, `help_request`, `handoff`, `escalation` wake idle agents through inbox runs with `maxTurns ≤ 8` and `maxBudgetUsd ≤ 0.25`; `awaitReply` suspends the run (`waiting_reply`, lease released) and the reply resumes it with the SDK session id, `replyTimeoutMinutes` default 60; `handoff_task` reassigns the task to the recipient; the office tools are an in-process SDK MCP server fed by `tool.call`/`tool.result` over the worker socket, with `strictMcpConfig: true` replacing the `mcp__*` wildcard; `office-summarizer` is a hidden system agent (`isSystem`) on haiku; memory has FTS now, pgvector column unused; hard delete of memory (no 30-day purge yet); inbox and chat runs have no task (`TaskRun.taskId` nullable, `agentId`/`projectId` on the run).
- `docs/worker-protocol.md`: `tool.call`/`tool.result`, `suspended` result, `kind`, `startSeq`, `tools` on `RunSpec`, `conversation:` UI topic, `message.created`, `memory.changed`.
- `docs/security.md`: project scoping of every tool, limits, untrusted message and memory text, tool surface per run kind.
- `docs/architecture.md`: entities now built; the run kinds and the three scheduler phases; context pack.
- `README.md`: Conversations and Project Memory; `pnpm seed` now also creates `office-summarizer`.

- [ ] **Step 1: Real Claude acceptance (spec §17 Phase 3)**

Start infra, API, worker (`OFFICE_RUNTIME=claude`), web; `pnpm seed`. Submit on `office-sandbox` a task for `developer`: title `Pick the database`, description `Before writing anything, ask the architect (use list_agents, then send_message with type question and awaitReply true) which database this project should use and why. Wait for the answer. Then write the decision into docs/db-decision.md and propose it as a decision memory with propose_memory.` Expected, in this order, each with ids recorded in `docs/progress.md` → "Phase 3 evidence": the developer run reaches `waiting_reply` with an `agent.waiting_reply` event; an inbox run for `architect` starts, `read_inbox` and `reply_message` are visible as `agent.message.received` / `agent.message.sent`; the developer run resumes (`agent.resumed`), writes the file, calls `propose_memory`, task `done`; a summary run writes a verified `task_summary` with sources; the Conversations page shows the thread; Project Memory lists the proposed decision with its sources; after restarting the API and the worker, `GET /conversations/:id` and `GET /memory/:id` still return everything (sessions closed, history and memory retrievable with sources); a second task for `developer` shows the summary id in its `contextPack`. Record cost. If any expectation fails, record it verbatim and leave Phase 3 `in progress`.

- [ ] **Step 2: Docs** as above; `docs/progress.md` Phase 3 → `done` only if Step 1 met every expectation. Outstanding: streaming delivery into live sessions, memory purge, semantic search, Settings UI for limits, `MemoryRevision` table (versions are rows), `agent.message.received` for messages read by the owner.

- [ ] **Step 3: Full verification**

Run: `pnpm typecheck && pnpm test && pnpm build && OFFICE_E2E_EMAIL=… OFFICE_E2E_PASSWORD=… pnpm --filter @office/web e2e`
Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A docs README.md CLAUDE.md packages/runtime/scripts && git commit -m "docs: phase 3 architecture, protocol, security, runbook; phase 3 evidence"
```

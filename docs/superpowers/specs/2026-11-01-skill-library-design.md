# Skill Library: marketplace, update, delete, model (2026-11-01)

Owner request (chat, 2026-11-01): search the skill marketplace and install from it, install from git, update installed skills from the skill page, delete a skill at will, improve the skill page and its table, pick a model (badge style) when adding a skill.

Assumptions (the owner did not answer the plugin question): "marketplace" is skills.sh (the open agent-skills registry, `GET https://skills.sh/api/search?q=`); Claude Code *plugins* (`plugin@marketplace`) are out of scope, Office has skills and subagents only. Imported skills stay `pending_review` until approved (standing decision).

## API

- `GET /skills` adds `model` (the `model:` frontmatter of the current `SKILL.md`, if any) and `usedBy` (agent ids whose current version pins the skill).
- `GET /skills/market?q=` proxies skills.sh (10 s timeout; the web app never calls outside localhost). Response `{ skills: [{ id, source, skillId, name, installs }] }`; `502 market_unavailable` on failure.
- `POST /skills/import { source: 'market', id: '<owner>/<repo>/<skillId>' }` clones `https://github.com/<owner>/<repo>` (depth 1), finds the directory whose `SKILL.md` frontmatter `name` is `<skillId>` (fallback: a directory named `<skillId>` holding a `SKILL.md`; depth ≤ 5, `.git`/`node_modules` skipped), and imports it as a `git` skill with `sourceRef https://github.com/<owner>/<repo>#HEAD:<path>` so Update works like any git skill. `400 market_skill_not_found` otherwise.
- `POST /skills/:id/update` re-reads the source (`git`: clone the `sourceRef` url/ref/path again; `local`: re-read the path; `ui`: `400 not_updatable`) and adds a version through `addSkillVersion` (identical content: `200 { created: false }`, else `201`). Audit `skill.updated`.
- `DELETE /skills/:id`: `409 skill_pinned { agents: [name] }` when any `AgentSkill` row references it (agent versions are immutable); otherwise deletes the versions and the skill. Audit `skill.deleted`.

## Web (`/skills`)

Follows the Skill Library artboard: page header ("Skill Library", the immutability sentence, actions "Import from folder", "Import from Git", "Marketplace", "New skill" that open one panel at a time); a review banner per `pending_review` skill (Approve, Inspect files, Reject); the Library card: filter input, columns Skill (mono name + description), Source (Created here / Local folder / Git), Model badge, Version pill, Used by (agent avatars), Status pill, row actions Update (git/local) and Delete (confirm). Marketplace panel: search box, results with name, source and installs, Install (shows Installed when the name exists). New skill panel adds a Model select (inherit, fable, opus, sonnet, haiku) that writes `model:` into the frontmatter. The skill detail page gets Update and Delete.

Not built: plugins, a detail side panel (the detail page stays), the On/Off toggle (status pills and Approve/Reject cover it), install counts for installed skills.

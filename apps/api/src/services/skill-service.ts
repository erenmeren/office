import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseSkillFrontmatter, skillChecksum, validateSkillFiles, type SkillFiles, type SkillStatus } from '@office/shared';
import type { PrismaClient } from '@office/db';
import { redactSecrets } from '@office/runtime';
import type { Config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { isUnderRoot } from '../lib/paths.js';

const run = promisify(execFile);

/** Regular files only, relative POSIX paths; dot-directories and symlinks are skipped. */
export async function readSkillDir(dir: string): Promise<SkillFiles> {
  const files: SkillFiles = {};
  const walk = async (rel: string) => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) await walk(r);
      } else if (e.isFile()) {
        files[r] = await readFile(join(dir, r), 'utf8');
      }
    }
  };
  await walk('');
  return files;
}

type CreateInput = {
  name?: string;
  files: SkillFiles;
  source: 'local' | 'git' | 'ui';
  sourceRef?: string;
  status: SkillStatus;
};

export async function createSkill(prisma: PrismaClient, input: CreateInput) {
  const { name, description } = validateSkillFiles(input.files, input.name);
  if (await prisma.skill.findUnique({ where: { name } })) throw new HttpError(409, 'conflict');
  return prisma.$transaction(async (tx) => {
    const skill = await tx.skill.create({
      data: { name, description, source: input.source, sourceRef: input.sourceRef, status: input.status },
    });
    const currentVersion = await tx.skillVersion.create({
      data: { skillId: skill.id, version: 1, files: input.files, checksum: skillChecksum(input.files) },
    });
    const updated = await tx.skill.update({ where: { id: skill.id }, data: { currentVersionId: currentVersion.id } });
    return { ...updated, currentVersion };
  });
}

export async function addSkillVersion(prisma: PrismaClient, skillId: string, files: SkillFiles) {
  return prisma.$transaction(async (tx) => {
    const skill = await tx.skill.findUnique({ where: { id: skillId } });
    if (!skill) throw new HttpError(404, 'not_found');
    const { description } = validateSkillFiles(files, skill.name);
    const checksum = skillChecksum(files);
    const current = skill.currentVersionId
      ? await tx.skillVersion.findUnique({ where: { id: skill.currentVersionId } })
      : null;
    if (current && current.checksum === checksum) return { version: current, created: false };
    const last = await tx.skillVersion.aggregate({ where: { skillId }, _max: { version: true } });
    const version = await tx.skillVersion.create({
      data: { skillId, version: (last._max.version ?? 0) + 1, files, checksum },
    });
    await tx.skill.update({ where: { id: skillId }, data: { currentVersionId: version.id, description } });
    return { version, created: true };
  });
}

const underRoots = (config: Config, p: string) => config.skillImportRoots.some((r) => isUnderRoot(p, r));

export async function importLocal(prisma: PrismaClient, config: Config, path: string) {
  const real = await realpath(resolve(path)).catch(() => null);
  if (!real || !underRoots(config, real)) throw new HttpError(400, 'path_outside_import_roots');
  return createSkill(prisma, {
    name: basename(real),
    files: await readSkillDir(real),
    source: 'local',
    sourceRef: path,
    status: 'pending_review',
  });
}

/** The directory of the SKILL.md whose frontmatter name is `name` (fallback: a directory named `name`); depth <= 5. */
export async function findSkillDir(root: string, name: string): Promise<string | null> {
  let byDirName: string | null = null;
  const walk = async (dir: string, depth: number): Promise<string | null> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name === 'SKILL.md') {
        if (parseSkillFrontmatter(await readFile(p, 'utf8')).name === name) return dir;
        if (basename(dir) === name) byDirName ??= dir;
      } else if (e.isDirectory() && depth < 5 && e.name !== '.git' && e.name !== 'node_modules') {
        const hit = await walk(p, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return (await walk(root, 0)) ?? byDirName;
}

type GitSource = { url: string; ref?: string; path?: string; name?: string };

/** Clones `url` (depth 1) and reads the skill at `path`, or the one named `name` anywhere in the checkout. */
async function readGitSkill(config: Config, { url, ref, path, name }: GitSource): Promise<{ files: SkillFiles; path: string }> {
  if (url.startsWith('file://')) {
    const local = await realpath(url.slice('file://'.length)).catch(() => null);
    if (!local || !underRoots(config, local)) throw new HttpError(400, 'bad_git_url');
  } else if (!url.startsWith('https://')) {
    throw new HttpError(400, 'bad_git_url');
  }
  await mkdir(config.dataDir, { recursive: true });
  const tmp = await mkdtemp(join(config.dataDir, 'skill-clone-'));
  try {
    await run('git', ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', url, tmp], {
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:file' },
    }).catch((err: { stderr?: string; code?: unknown }) => {
      const cause = err.stderr?.trim().split('\n')[0] || String(err.code ?? 'unknown');
      throw new HttpError(400, 'git_clone_failed', redactSecrets(cause).slice(0, 200));
    });
    const realTmp = await realpath(tmp);
    let dir: string | null;
    if (path === undefined && name !== undefined) {
      dir = await findSkillDir(realTmp, name);
      if (!dir) throw new HttpError(400, 'market_skill_not_found', `no SKILL.md named ${name} in ${url}`);
    } else {
      dir = await realpath(resolve(tmp, path ?? '.')).catch(() => null);
      if (!dir || !isUnderRoot(dir, realTmp)) throw new HttpError(400, 'bad_git_path');
    }
    const rel = dir === realTmp ? '.' : dir.slice(realTmp.length + 1);
    return { files: await readSkillDir(dir), path: rel };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function importGit(prisma: PrismaClient, config: Config, src: GitSource) {
  const { files, path } = await readGitSkill(config, src);
  return createSkill(prisma, {
    name: src.name ?? (path === '.' ? undefined : basename(path)),
    files,
    source: 'git',
    sourceRef: `${src.url}#${src.ref ?? 'HEAD'}:${path}`,
    status: 'pending_review',
  });
}

const MARKET_ID_RE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/([a-z0-9][a-z0-9-]{0,63})$/;

/** A skills.sh id `<owner>/<repo>/<skillId>`: the GitHub repository plus the skill's frontmatter name. */
export function importMarket(prisma: PrismaClient, config: Config, id: string) {
  const m = MARKET_ID_RE.exec(id);
  if (!m) throw new HttpError(400, 'bad_market_id');
  return importGit(prisma, config, { url: `https://github.com/${m[1]}`, name: m[2] });
}

/** Re-reads a git or local skill from its sourceRef and adds a version when the content changed. */
export async function refreshSkill(prisma: PrismaClient, config: Config, skillId: string) {
  const skill = await prisma.skill.findUnique({ where: { id: skillId } });
  if (!skill) throw new HttpError(404, 'not_found');
  let files: SkillFiles;
  if (skill.source === 'git' && skill.sourceRef) {
    const m = /^(.*)#([^:]*):(.*)$/.exec(skill.sourceRef);
    if (!m) throw new HttpError(400, 'not_updatable');
    files = (await readGitSkill(config, { url: m[1]!, ref: m[2] === 'HEAD' ? undefined : m[2], path: m[3] })).files;
  } else if (skill.source === 'local' && skill.sourceRef) {
    const real = await realpath(resolve(skill.sourceRef)).catch(() => null);
    if (!real || !underRoots(config, real)) throw new HttpError(400, 'path_outside_import_roots');
    files = await readSkillDir(real);
  } else {
    throw new HttpError(400, 'not_updatable');
  }
  return addSkillVersion(prisma, skillId, files);
}

/** Hard delete; refused while any agent version pins the skill (those rows are immutable). */
export async function deleteSkill(prisma: PrismaClient, skillId: string) {
  const skill = await prisma.skill.findUnique({ where: { id: skillId } });
  if (!skill) throw new HttpError(404, 'not_found');
  const pins = await prisma.agentSkill.findMany({
    where: { skillId },
    select: { agentVersion: { select: { agent: { select: { name: true } } } } },
  });
  if (pins.length > 0) {
    const agents = [...new Set(pins.map((p) => p.agentVersion.agent.name))];
    throw new HttpError(409, 'skill_pinned', `pinned by ${agents.join(', ')}`);
  }
  await prisma.$transaction([
    prisma.skill.update({ where: { id: skillId }, data: { currentVersionId: null } }),
    prisma.skillVersion.deleteMany({ where: { skillId } }),
    prisma.skill.delete({ where: { id: skillId } }),
  ]);
}

export interface MachineSkill {
  name: string;
  description: string;
  path: string;
  /** `user` for ~/.claude/skills, else the plugin that ships it */
  origin: string;
  /** the Office skill imported from this path, if any */
  skillId: string | null;
}

const PLUGIN_DEPTH = 3; // cache/<marketplace>/<plugin>/<version>/skills/<name>

/** The owner's own Claude Code skills on this machine: `~/.claude/skills/*` and every installed plugin's `skills/*`. */
export async function machineSkills(prisma: PrismaClient, home = homedir()): Promise<MachineSkill[]> {
  const found: Omit<MachineSkill, 'skillId'>[] = [];
  const skillDirs = async (dir: string, origin: string) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const path = join(dir, e.name);
      const text = await readFile(join(path, 'SKILL.md'), 'utf8').catch(() => null);
      if (text === null) continue;
      const fm = parseSkillFrontmatter(text);
      found.push({ name: fm.name || e.name, description: fm.description ?? '', path, origin });
    }
  };
  await skillDirs(join(home, '.claude', 'skills'), 'user');
  const walkPlugins = async (dir: string, depth: number) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory()) continue;
      const sub = join(dir, e.name);
      if (depth === 0) await skillDirs(join(sub, 'skills'), `plugin:${basename(dirname(sub))}`);
      else await walkPlugins(sub, depth - 1);
    }
  };
  await walkPlugins(join(home, '.claude', 'plugins', 'cache'), PLUGIN_DEPTH - 1);
  const imported = await prisma.skill.findMany({ where: { source: 'local', sourceRef: { in: found.map((f) => f.path) } }, select: { id: true, sourceRef: true } });
  const byPath = new Map(imported.map((s) => [s.sourceRef, s.id]));
  // the owner's own skills first: on a name clash with a plugin's skill, theirs is the one imported
  const rank = (o: string) => (o === 'user' ? 0 : 1);
  return found.sort((a, b) => rank(a.origin) - rank(b.origin) || a.origin.localeCompare(b.origin) || a.name.localeCompare(b.name)).map((f) => ({ ...f, skillId: byPath.get(f.path) ?? null }));
}

/**
 * Keeps the owner's Claude Code skills in the library without a click: every skill found on this machine is imported
 * `approved` (they are the owner's own), an already imported one gets a new version when its files changed. A skill whose
 * name is taken by another skill is skipped and logged once per sync. Runs at API start and every few minutes.
 */
export async function syncMachineSkills(prisma: PrismaClient, log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }, home = homedir()) {
  const counts = { imported: 0, updated: 0, skipped: 0 };
  for (const found of await machineSkills(prisma, home)) {
    try {
      if (found.skillId) {
        const { created } = await addSkillVersion(prisma, found.skillId, await readSkillDir(found.path));
        if (created) counts.updated++;
        continue;
      }
      const files = await readSkillDir(found.path);
      const { name } = validateSkillFiles(files, basename(found.path));
      if (await prisma.skill.findUnique({ where: { name } })) {
        counts.skipped++;
        log.warn({ name, path: found.path }, 'machine skill not imported: a skill of that name exists');
        continue;
      }
      await createSkill(prisma, { name, files, source: 'local', sourceRef: found.path, status: 'approved' });
      counts.imported++;
    } catch (err) {
      counts.skipped++;
      log.warn({ err, path: found.path }, 'machine skill not imported');
    }
  }
  if (counts.imported || counts.updated) log.info(counts, 'machine skills synced');
  return counts;
}

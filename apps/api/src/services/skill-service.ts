import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { skillChecksum, validateSkillFiles, type SkillFiles, type SkillStatus } from '@office/shared';
import type { PrismaClient } from '@office/db';
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

export async function importGit(
  prisma: PrismaClient,
  config: Config,
  { url, ref, path }: { url: string; ref?: string; path?: string },
) {
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
    }).catch(() => {
      throw new HttpError(400, 'git_clone_failed');
    });
    const dir = resolve(tmp, path ?? '.');
    const real = await realpath(dir).catch(() => null);
    if (!real || !isUnderRoot(real, await realpath(tmp))) throw new HttpError(400, 'bad_git_path');
    return await createSkill(prisma, {
      name: path ? basename(real) : undefined,
      files: await readSkillDir(real),
      source: 'git',
      sourceRef: `${url}#${ref ?? 'HEAD'}:${path ?? '.'}`,
      status: 'pending_review',
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

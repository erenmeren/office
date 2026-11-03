import type { MessageView } from '@office/shared';
import type { Agent, LiveSession, Overview } from './queries';

/** Floor geometry of the Pixel Office (design option 3a): 300×260 rooms on a 430×390 grid, three per row. */
export const ROOM_W = 300;
export const ROOM_H = 260;
export const STEP_X = 430;
export const STEP_Y = 390;
export const COLS = 3;
export const STAGE_W = 1300;
/** Where the main worker sits in its room, and where its head projects from (z = 54). */
export const HEAD = { x: 150, y: 42, z: 54 };
export const SUBPOS: [number, number][] = [
  [76, 186],
  [164, 186],
  [252, 186],
];

export interface Point {
  x: number;
  y: number;
}
export type Project3 = (x: number, y: number, z?: number) => Point;

/** Screen position of a floor point under `rotateX(60deg) rotateZ(45deg)`, for the floor centred at (cx, cy). */
export function projector(w: number, h: number, cx: number, cy: number): Project3 {
  return (x, y, z = 0) => ({ x: cx + (x - y - (w - h) / 2) * 0.70711, y: cy + (x + y - (w + h) / 2) * 0.35355 - z * 0.86603 });
}

export interface FloorLayout {
  w: number;
  h: number;
  stageH: number;
  left: number;
  top: number;
  rows: number;
  P: Project3;
}

/** Floor size and placement for `n` rooms; the 2-row floor is the 1160×650 artboard at 1300×980. */
export function floorLayout(n: number): FloorLayout {
  const rows = Math.max(1, Math.ceil(n / COLS));
  const w = ROOM_W + STEP_X * (COLS - 1);
  const h = ROOM_H + STEP_Y * (rows - 1);
  // 165px above the floor for the top row's plates, 100px below its front corner for the bottom row's
  const top = 165;
  const cy = top + h / 2;
  const stageH = Math.round(cy + ((w + h) / 2) * 0.35355 + 100);
  return { w, h, stageH, rows, left: STAGE_W / 2 - w / 2, top, P: projector(w, h, STAGE_W / 2, cy) };
}

export const roomOrigin = (i: number) => ({ rx: (i % COLS) * STEP_X, ry: Math.floor(i / COLS) * STEP_Y });

/** Pixel-art rows as one `box-shadow` list; `.` is transparent, other letters look up the palette. */
export function sprite(rows: string[], pal: Record<string, string>, px: number): string {
  const out: string[] = [];
  rows.forEach((r, y) => {
    for (let x = 0; x < r.length; x++) {
      const ch = r[x];
      if (ch === '.') continue;
      out.push(`${x * px}px ${y * px}px 0 0 ${pal[ch] ?? BASE[ch] ?? '#1b1033'}`);
    }
  });
  return out.join(',');
}

const BASE: Record<string, string> = { k: '#1b1033', w: '#ffffff', e: '#1b1033', p: '#ff8fb1' };

export const CREATURES: Record<string, string[]> = {
  chief: ['....c.c.c...', '....ccccc...', '...kaaaaak..', '..kaaaaaaak.', '.kaaeaaaeaak', '.kaaaaaaaaak', '.kapaaaaapak', '.kaaakkkaaak', '..kaaaaaaak.', '...kaaaaak..', '..kbbk.kbbk.', '..kkk...kkk.'],
  architect: ['..kk....kk..', '.kaak..kaak.', '.kaaakkaaak.', 'kaaaaaaaaaak', 'kakkkaakkkak', 'kakekaakekak', 'kaaaaccaaaak', 'kabaaaaaabak', '.kbbaaaabbk.', '..kbbbbbbk..', '...kk..kk...', '............'],
  designer: ['.k.......k..', '.kak....kak.', '.kaak..kaak.', '.kaaakkaaak.', '.kaaaaaaaak.', '.kaeaaaaeak.', '.kaaaaaaaak.', '.kapakkapak.', '..kaaaaaak..', '..kaaaaaakkc', '..kbbkkbbk.c', '..kk....kk..'],
  developer: ['..kkk..kkk..', '.kaeak.kaeak', '.kaaakkkaaak', 'kaaaaaaaaaak', 'kaaaaaaaaaak', 'kaapaaaapaak', 'kaakkkkkkaak', '.kaaaaaaaak.', '.kbbbbbbbbk.', '.kbbbbbbbbk.', '..kbbk..kbbk', '..kk....kk..'],
  qa: ['..k......k..', '...k....k...', '..kkkkkkkk..', '.kaaaaaaaak.', 'kaaeaaaaeaak', 'kaaaaaaaaaak', 'kaakaaaakaak', 'kaaaakkaaaak', '.kaaaaaaaak.', '.kakaaaakak.', '..kkaaaakk..', '...kk..kk...'],
  summarizer: ['....kkkk....', '..kkaaaakk..', '.kaaaaaaaak.', '.kaaeaaaeak.', 'kaaaaaaaaaak', 'kaaaaaaaaaak', 'kaaaakkaaaak', 'kaaaaaaaaaak', 'kaaaaaaaaaak', 'kaakaaakaaak', 'kk.kk.kk.kk.', '............'],
};

export const PLANT = ['..gG.g..', '.gGggGg.', '.ggGGgg.', '..gggg..', '...gg...', '..pPPp..', '..pppp..', '...pp...'];
export const PLANT_PAL = { g: '#3fae6a', G: '#8fe3ad', p: '#a9613f', P: '#cf8457' };
export const LAMP = ['.llll.', 'lLLLLl', 'llllll', '..ss..', '..ss..', '..ss..', '.ssss.', 'ssssss'];
export const LAMP_PAL = { l: '#ffc96b', L: '#ffe9b0', s: '#3a3466' };
export const MONSTERA = ['..gG..Gg..', '.gGGg.gGGg', 'gGGGGgGGGG', '.gGGGGGGg.', '..ggGGgg..', '....gg....', '....gg....', '..pPPPPp..', '..pppppp..', '...pppp...'];
export const CAT = ['k........k', 'kakkkkkkak', 'kaaaaaaaak', 'kakaakaaak', 'kaaaaaaaak', '.kkkkkkkk.'];
export const CAT_PAL = { a: '#ffb15c', k: '#1b1033' };
export const BEANBAG = ['...bbbbbb...', '..bBBBBBBb..', '.bBBBBBBBBb.', 'bBBBBBBBBBBb', 'bBBBBBBBBBBb', 'bbBBBBBBBBbb', '.bbbbbbbbbb.', '..bbbbbbbb..'];
export const BEANBAG_PAL = { b: '#b8543a', B: '#e8775a' };

export type Theme = 'library' | 'aquarium' | 'garden' | 'couch' | 'board' | 'fire' | 'plain';
const THEMES: [string, Theme][] = [
  ['chief', 'library'],
  ['architect', 'aquarium'],
  ['design', 'garden'],
  ['develop', 'couch'],
  ['frontend', 'couch'],
  ['backend', 'couch'],
  ['qa', 'board'],
  ['summar', 'fire'],
];
/** Each seeded role has its own corner; other agents get the plain cozy room. */
export const themeFor = (slug: string): Theme => THEMES.find(([k]) => slug.toLowerCase().includes(k))?.[1] ?? 'plain';

/** The creature of a role; unknown roles share one by hash so a room keeps its tenant. */
export function creatureFor(slug: string): string[] {
  const k = slug.toLowerCase();
  const hit = Object.keys(CREATURES).find((name) => k.includes(name));
  if (hit) return CREATURES[hit];
  let h = 0;
  for (const c of k) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const keys = Object.keys(CREATURES);
  return CREATURES[keys[h % keys.length]];
}

export interface OfficeRoom {
  agentId: string;
  slug: string;
  name: string;
  /** run status of the live session, or `idle` */
  status: string;
  task: string;
  workerName: string | null;
  runId: string | null;
  startedAt: string | null;
  costUsd: number;
  subs: { name: string; done: boolean }[];
  /** the question this agent waits an answer to, and who it asked */
  waitingFor: { body: string; recipientAgentIds: string[] } | null;
}

/** An envelope in flight from one room to another; `until` is when a transient one disappears. */
export interface Mail {
  id: string;
  from: string;
  to: string;
  until: number;
}

/** Envelopes for a live `message.created` of this project sent by an agent to agents, shown for 3.2 s. */
export function mailFromMessage(m: MessageView, projectId: string, now: number): Mail[] {
  if (m.projectId !== projectId || !m.senderAgentId) return [];
  const from = m.senderAgentId;
  return m.deliveries.flatMap((d) => (d.recipientAgentId && d.recipientAgentId !== from ? [{ id: `${m.id}:${d.recipientAgentId}`, from, to: d.recipientAgentId, until: now + 3200 }] : []));
}

/** Envelopes that stay while a room waits for its reply. */
export const waitingMail = (rooms: OfficeRoom[]): Mail[] =>
  rooms.flatMap((r) => (r.status === 'waiting_reply' && r.waitingFor ? r.waitingFor.recipientAgentIds.map((to) => ({ id: `wait:${r.agentId}:${to}`, from: r.agentId, to, until: Infinity })) : []));

/** The first line of an agent's text, cut for a speech bubble. */
export function oneLine(text: string, max = 64): string {
  const line = text.trim().split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** One room per team member: the overview row plus its live session, if any. */
export function officeRooms(team: Overview['team'], sessions: LiveSession[], agents: Agent[]): OfficeRoom[] {
  return team.map((m) => {
    const s = sessions.find((x) => x.agentId === m.agentId);
    return {
      agentId: m.agentId,
      slug: agents.find((a) => a.id === m.agentId)?.slug ?? m.role,
      name: m.name,
      status: s?.status ?? 'idle',
      task: s ? (s.taskTitle ?? s.kind) : (m.currentWork ?? 'No assigned work'),
      workerName: s?.workerName ?? m.workerName,
      runId: s?.runId ?? null,
      startedAt: s?.startedAt ?? null,
      costUsd: s?.costUsd ?? m.costTodayUsd,
      subs: (s?.subagents ?? []).map((x) => ({ name: x.subagentType ?? x.description ?? 'subagent', done: x.status !== 'running' })),
      waitingFor: s?.waitingFor ? { body: s.waitingFor.body, recipientAgentIds: s.waitingFor.recipientAgentIds } : null,
    };
  });
}

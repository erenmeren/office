import type { MessageView } from '@office/shared';
import { isSessionRunning, type Agent, type ClaudeSession, type LiveSession, type Overview, type TerminalView } from './queries';

/** Floor geometry of the Pixel Office (design option 3a): 300×260 rooms on a 430×390 grid, three per row. */
export const ROOM_W = 300;
export const ROOM_H = 260;
export const STEP_X = 430;
export const STEP_Y = 390;
export const COLS = 3;
/** Where the main worker sits in its room, and where its head projects from (the seat at 12 plus the 58px seated sprite). */
export const HEAD = { x: 150, y: 42, z: 79 };
export const SUBPOS: [number, number][] = [
  [76, 204],
  [164, 204],
  [252, 204],
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
  stageW: number;
  stageH: number;
  left: number;
  top: number;
  rows: number;
  P: Project3;
}

/** Floor size and placement for `n` rooms; the stage is the projected floor plus the room its plates need around it. */
export function floorLayout(n: number): FloorLayout {
  const rows = Math.max(1, Math.ceil(n / COLS));
  const w = ROOM_W + STEP_X * (COLS - 1);
  const h = ROOM_H + STEP_Y * (rows - 1);
  // half the projected floor; 64px beside it, 190px above its back corner for the top row's plates, 110px below its front corner for the bottom row's
  const hw = ((w + h) / 2) * 0.70711;
  const hh = ((w + h) / 2) * 0.35355;
  const stageW = Math.round(2 * (hw + 64));
  const cy = Math.round(190 + hh);
  return { w, h, stageW, stageH: Math.round(cy + hh + 110), rows, left: stageW / 2 - w / 2, top: cy - h / 2, P: projector(w, h, stageW / 2, cy) };
}

/** Zoom of the floor, relative to the size that shows all of it. */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z || 1));

export const roomOrigin = (i: number) => ({ rx: (i % COLS) * STEP_X, ry: Math.floor(i / COLS) * STEP_Y });

/** Pixel-art rows as one `box-shadow` list; `.` is transparent, other letters look up the palette. The .3px spread overlaps the cells, so a scaled floor shows no seams between them. */
export function sprite(rows: string[], pal: Record<string, string>, px: number): string {
  const out: string[] = [];
  rows.forEach((r, y) => {
    for (let x = 0; x < r.length; x++) {
      const ch = r[x];
      if (ch === '.') continue;
      out.push(`${x * px}px ${y * px}px 0 .3px ${pal[ch] ?? BASE[ch] ?? '#1b1033'}`);
    }
  });
  return out.join(',');
}

const BASE: Record<string, string> = { k: '#1b1033', w: '#ffffff', e: '#1b1033', p: '#ff8fb1' };

/** Colours of the Matrix cast below: blacks, skins, hair, lenses, and the few bright pieces that tell them apart. */
export const CAST_PAL: Record<string, string> = {
  k: '#0d0f14',
  j: '#262b36',
  K: '#4a5262',
  s: '#f1c7a1',
  S: '#d49f7a',
  m: '#b5524a',
  d: '#8d5a3b',
  D: '#6b4029',
  b: '#a8744f',
  M: '#4a221b',
  e: '#1b1033',
  w: '#ffffff',
  y: '#aab1bd',
  h: '#6b7280',
  u: '#6b4423',
  U: '#8f6238',
  o: '#f6d55c',
  O: '#c99a2e',
  r: '#e11d2e',
  R: '#9e1220',
  t: '#3fae6a',
  T: '#1f5a3a',
  G: '#0a1410',
  g: '#8a94a6',
  c: '#d9a05b',
};

/** The cast is drawn 24×36 at 2px a cell: head to row 13, torso to row 29, legs below (the desk hides most of those). */
export const CAST_W = 24;
export const CAST_H = 36;
/** A seated tenant is drawn down to its hands; the rows below are legs, under the desk. */
export const SEAT_ROWS = 29;
/**
 * The Matrix cast: chief Morpheus (bald, mirrored pince-nez, leather coat, green tie), the Architect (white hair and beard, grey three-piece),
 * designer the woman in red, developer Trinity (slick hair, glossy black), qa the Oracle (bun, smile, a tray of cookies),
 * security Seraph (round glasses, white jacket), owner Neo (long buttoned coat), summarizer the operator (headset, knit vest).
 */
export const CREATURES: Record<string, string[]> = {
  chief: [
    '........................',
    '.........dddddd.........',
    '.......ddbbdddddd.......',
    '......ddbbdddddddd......',
    '......dddddddddddd......',
    '......dddddddddddd......',
    '......dddddddddddd......',
    '......dDDDddddDDDd......',
    '......dywyyKKywyyd......',
    '......dhhhhddhhhhd......',
    '.......ddddDDdddd.......',
    '.......dddddddddd.......',
    '........ddDMMDdd........',
    '.........dddddd.........',
    '..........dDDd..........',
    '......kkkKwttwKkkk......',
    '....kkkkKTwttwTKkkkk....',
    '...kkkkkKTTttTTKkkkkk...',
    '...kkkjkKTTttTTKkjkkk...',
    '...kkkjkKTTttTTKkjkkk...',
    '...kkkjkKTTttTTKkjkkk...',
    '...kkkjkKTTTtTTKkjkkk...',
    '...kkkjkKTTTTTTKkjkkk...',
    '...kkkjkKTTTyTTKkjkkk...',
    '...kkkjkKTTTTTTKkjkkk...',
    '...kkkjkKTTTyTTKkjkkk...',
    '...kkkjkKkkkkkkKkjkkk...',
    '...dddjkKkkkkkkKkjddd...',
    '....dd.kKkkkkkkKk.dd....',
    '......kkKkkkkkkKkk......',
    '......kkKkkkkkkKkk......',
    '......kkKkk..kkKkk......',
    '......kkKkk..kkKkk......',
    '......kk.kk..kk.kk......',
    '.........kk..kk.........',
    '........kkk..kkk........',
  ],
  architect: [
    '........................',
    '.........wwwwww.........',
    '.......wwwwwwwwww.......',
    '......wwwywwwwwwww......',
    '......wwywwwwwwwww......',
    '......wwsssssssssw......',
    '......wssssssssssw......',
    '......swwwsssswwws......',
    '......sseesssseess......',
    '......sssssSSsssss......',
    '......wsswwwwwwssw......',
    '.......wwwwmmwwww.......',
    '........wwwwwwww........',
    '.........wywwyw.........',
    '..........ywwy..........',
    '......yyyhwKKwhyyy......',
    '....yyyyhwwKKwwhyyyy....',
    '...yyyyyyhwKKwhyyyyyy...',
    '...yyyhyyhhKKhhyyhyyy...',
    '...yyyhyyhhKKhhyyhyyy...',
    '...yyyhyyhhhhhhyyhyyy...',
    '...yyyhyyhhhwhhyyhyyy...',
    '...yyyhyyhhhhhhyyhyyy...',
    '...yyyhyyhhhwhhyyhyyy...',
    '...yyyhyyyhhhhyyyhyyy...',
    '...yyyhyyyyyyyyyyhyyy...',
    '...yyyhyyyyyyyyyyhyyy...',
    '...sss.yyyyyyyyyy.sss...',
    '....ss.yyyyyyyyyy.ss....',
    '.......yyyyyyyyyy.......',
    '.......yyyy..yyyy.......',
    '.......yyyy..yyyy.......',
    '.......yyyy..yyyy.......',
    '.......yyyy..yyyy.......',
    '.......yyyy..yyyy.......',
    '......kkkkk..kkkkk......',
  ],
  designer: [
    '........................',
    '.........oooooo.........',
    '.......oooooooooo.......',
    '......ooooOooooooo......',
    '.....oooOoooooooooo.....',
    '.....oooosssssssooo.....',
    '.....oossssssssssoo.....',
    '.....oOssssssssssoo.....',
    '.....ooseesssseesoo.....',
    '.....oossssSSssssoo.....',
    '....oOossssssssssooo....',
    '....ooossssrrssssoOo....',
    '....oooossssssssoooo....',
    '....oOooossssssooooo....',
    '....oooooosSSsooooOo....',
    '....oooossssssssoooo....',
    '....ooosrssssssrsooo....',
    '....ooosrrssssrrsooo....',
    '....oOosrrrrrrrrsoOo....',
    '.....oosrrrrrrrrsoo.....',
    '.....ss.rRrrrrrr.ss.....',
    '.....ss..rRrrrr..ss.....',
    '.....ss..rrrrrr..ss.....',
    '.....ss.rrrrrrrr.ss.....',
    '.....ss.rrrrrrrr.ss.....',
    '.....ss.rrrrrrrr.ss.....',
    '........rrrrrrrr........',
    '........rrrrrrrR........',
    '........rrrrrrRR........',
    '.........rrrrrr.........',
    '.........ss..ss.........',
    '.........ss..ss.........',
    '.........ss..ss.........',
    '.........ss..ss.........',
    '.........rr..rr.........',
    '........rrr..rrr........',
  ],
  developer: [
    '........................',
    '........kkkkkkkk........',
    '......kkkKKkkkkkkk......',
    '.....kkKKkkkkkkkkkk.....',
    '.....kkkkkkkkkkkkkk.....',
    '.....kkkkkssssssskk.....',
    '.....kkkssssssssskk.....',
    '.....kksssssssssskk.....',
    '.....kksGgGKKGgGskk.....',
    '.....kksGGGssGGGskk.....',
    '.....kkssssSSsssskk.....',
    '......kssssssssssk......',
    '........sssmmsss........',
    '.........ssssss.........',
    '..........sSSs..........',
    '.......kkkkkkkkkk.......',
    '.....kyKkkkkkkkkkkk.....',
    '....kKkkkkkkkkkkkkkk....',
    '....kKk.kKkkkkkk.kkk....',
    '....kKk.kKkkkkkk.kkk....',
    '....kkk.kKkkkkkk.kkk....',
    '....kkk..kkkkkk..kkk....',
    '....kkk..kkkkkk..kkk....',
    '....kkk.kKkkkkkk.kkk....',
    '....kkk.KKKyyKKK.kkk....',
    '....kkk.kkkkkkkk.kkk....',
    '....sss.kkkkkkkk.sss....',
    '........kkkkkkkk........',
    '........kkkkkkkk........',
    '........kKk..kkk........',
    '........kKk..kkk........',
    '........kkk..kkk........',
    '........kkk..kkk........',
    '........kkk..kkk........',
    '........kkk..kkk........',
    '.......kkkk..kkkk.......',
  ],
  qa: [
    '..........kkkk..........',
    '.........kkhkkk.........',
    '.......kkkkkkkkkk.......',
    '......kkhkkkkkkhkk......',
    '......kkkkkkkkkkkk......',
    '......kkddddddddkk......',
    '......kddddddddddk......',
    '......kddddddddddk......',
    '......ddweddddewdd......',
    '......dddddDDddddd......',
    '.....oddddddddddddo.....',
    '.......dMddddddMd.......',
    '........dMMMMMMd........',
    '.........dddddd.........',
    '..........dDDd..........',
    '......tttttddttttt......',
    '....tttttttttttttttt....',
    '...ttTtttttTtttttTttt...',
    '...tttttTtttttTtttttt...',
    '...ttTtttttTtttttTttt...',
    '...tttttTtttttTtttttt...',
    '...ttTtttttTtttttTttt...',
    '...tttcUctcUctcUctttt...',
    '...tttccctccctccctttt...',
    '...dddyyyyyyyyyyyyddd...',
    '....ddhhhhhhhhhhhhdd....',
    '......tttttttttttt......',
    '......ttTtttttTttt......',
    '......tttttTtttttt......',
    '......tttttttttttt......',
    '.......tttttttttt.......',
    '.........dd..dd.........',
    '.........dd..dd.........',
    '.........dd..dd.........',
    '.........kk..kk.........',
    '........kkk..kkk........',
  ],
  security: [
    '........................',
    '.........kkkkkk.........',
    '.......kkkkkkkkkk.......',
    '......kkkkkkkkkkkk......',
    '......kkkKkkkkkkkk......',
    '......kksssssssskk......',
    '......kssssssssssk......',
    '......ssssssssssss......',
    '......sGgGKKKKGgGs......',
    '......sGGGssssGGGs......',
    '.......ssssSSssss.......',
    '.......ssssssssss.......',
    '........sssmmsss........',
    '.........ssssss.........',
    '..........sSSs..........',
    '......wwwwwyywwwww......',
    '....wwwwwwwwwwwwwwww....',
    '...wwwwwwwyyyywwwwwww...',
    '...wwwywwwwwwwwwwywww...',
    '...wwwywwwyyyywwwywww...',
    '...wwwywwwwwwwwwwywww...',
    '...wwwywwwyyyywwwywww...',
    '...wwwywwwwwwwwwwywww...',
    '...wwwywwwyyyywwwywww...',
    '...wwwywwwwwwwwwwywww...',
    '...wwwywwwwwwwwwwywww...',
    '...wwwyyyyyyyyyyyywww...',
    '...sss.wwwwwwwwww.sss...',
    '....ss.wwwwwwwwww.ss....',
    '.......wwwwwwwwww.......',
    '.......wwww..wwww.......',
    '.......wwww..wwww.......',
    '.......wwww..wwww.......',
    '.......wwww..wwww.......',
    '.......yyyy..yyyy.......',
    '......kkkkk..kkkkk......',
  ],
  owner: [
    '........................',
    '.........kkkkkk.........',
    '.......kkkkkkkkkk.......',
    '......kkkKKkkkkkkk......',
    '......kkKkkkkkkkkk......',
    '......kkkssssssskk......',
    '......kssssssssssk......',
    '......ssssssssssss......',
    '......sGgGGKKGgGGs......',
    '......sGGGGssGGGGs......',
    '.......ssssSSssss.......',
    '.......ssssssssss.......',
    '........sssmmsss........',
    '.........ssssss.........',
    '.........kKkkKk.........',
    '......kkkkkkkkkkkk......',
    '....kkkkkkkkkkkkkkkk....',
    '...kkkkkkkkkKkkkkkkkk...',
    '...kkkjkkkkkkkkkkjkkk...',
    '...kkkjkkkkkKkkkkjkkk...',
    '...kkkjkkkkkkkkkkjkkk...',
    '...kkkjkkkkkKkkkkjkkk...',
    '...kkkjkkkkkkkkkkjkkk...',
    '...kkkjkkkkkKkkkkjkkk...',
    '...kkkjkkkkkkkkkkjkkk...',
    '...kkkjkkkkkKkkkkjkkk...',
    '...kkkjkkkkkkkkkkjkkk...',
    '...sssjkkkkkKkkkkjsss...',
    '....ss.kkkkkkkkkk.ss....',
    '......kkkkkkkkkkkk......',
    '......kkkkkkKkkkkk......',
    '.....kkkkkkkkkkkkkk.....',
    '.....kkkkkk..kkkkkk.....',
    '.....kkkkk....kkkkk.....',
    '......kkkk....kkkk......',
    '.....kkkkk....kkkkk.....',
  ],
  summarizer: [
    '........................',
    '.........hhhhhh.........',
    '.......hhkkkkkkhh.......',
    '......hhkkkkkkkkhh......',
    '......hkkkkkkkkkkh......',
    '.....hhkddddddddkhh.....',
    '.....hhddddddddddhh.....',
    '.....hKddddddddddKh.....',
    '.....hhdweddddewdhh.....',
    '.....hhddddDDddddhh.....',
    '.....h.dddddddddd.......',
    '.....h.dddddddddd.......',
    '......hhKddMMddd........',
    '.........dddddd.........',
    '..........dDDd..........',
    '......dyyyyddyyyyd......',
    '....dddyyyyyyyyyyddd....',
    '...ddddyhyhyhyhyhdddd...',
    '...dDd.yyyyyyyyyy.dDd...',
    '...ddd.hyhyhyhyhy.ddd...',
    '...ddd.yyyyyyyyyy.ddd...',
    '...ddd.yhyhyhyhyh.ddd...',
    '...ddd.yyyyyyyyyy.ddd...',
    '...ddd.hyhyhyhyhy.ddd...',
    '...ddd.yyyyyyyyyy.ddd...',
    '...ddd.yyhyyDyhyy.ddd...',
    '...ddd.yKyyyKyyKy.ddd...',
    '...ddd.KKKKKKKKKK.ddd...',
    '.......KKKKKKKKKK.......',
    '.......KKKKKKKKKK.......',
    '.......KKKK..KKKK.......',
    '.......KKKK..KKKK.......',
    '.......KKKK..KKKK.......',
    '.......KKKK..KKKK.......',
    '.......KKKK..KKKK.......',
    '......kkkkk..kkkkk......',
  ],
};
/** Agent Smith (earpiece, white shirt, tie clip); every subagent is a copy of him. */
export const SMITH = [
  '........................',
  '.........uuuuuu.........',
  '.......uuuuuuuuuu.......',
  '......uuUUuuuuuuuu......',
  '......uuusssssssuu......',
  '......uusssssssssu......',
  '......ussssssssssu......',
  '......ssssssssssss......',
  '......kGgGGkkGgGGk......',
  '......sGGGGssGGGGsw.....',
  '.......ssssSSssss.y.....',
  '.......ssssssssss.y.....',
  '........ssSmmSss..y.....',
  '.........ssssss..y......',
  '..........sSSs.yy.......',
  '......kkkkwkkwkkkk......',
  '....kkkkKwwkkwwKkkkk....',
  '...kkkkkkKwkkwKkkkkkk...',
  '...kkkjkkkwkkwkkkjkkk...',
  '...kkkjkkkwyywkkkjkkk...',
  '...kkkjkkkKkkKkkkjkkk...',
  '...kkkjkkkkkkkkkkjkkk...',
  '...kkkjkkkkkKkkkkjkkk...',
  '...kkkjkkkkkkkkkkjkkk...',
  '...kkkjkkkkkKkkkkjkkk...',
  '...kkkjkkkkkkkkkkjkkk...',
  '...kkkjkkkkkkkkkkjkkk...',
  '...sss.kkkkkkkkkk.sss...',
  '....ss.kkkkkkkkkk.ss....',
  '.......kkkkkkkkkk.......',
  '.......kkkk..kkkk.......',
  '.......kkkk..kkkk.......',
  '.......kkkk..kkkk.......',
  '.......kkkk..kkkk.......',
  '.......kkkk..kkkk.......',
  '......kkkkk..kkkkk......',
];

export const PLANT = ['..gG.g..', '.gGggGg.', '.ggGGgg.', '..gggg..', '...gg...', '..pPPp..', '..pppp..', '...pp...'];
export const PLANT_PAL = { g: '#3fae6a', G: '#8fe3ad', p: '#a9613f', P: '#cf8457' };
export const LAMP = ['.llll.', 'lLLLLl', 'llllll', '..ss..', '..ss..', '..ss..', '.ssss.', 'ssssss'];
export const LAMP_PAL = { l: '#ffc96b', L: '#ffe9b0', s: '#3a3466' };
export const MONSTERA = ['..gG..Gg..', '.gGGg.gGGg', 'gGGGGgGGGG', '.gGGGGGGg.', '..ggGGgg..', '....gg....', '....gg....', '..pPPPPp..', '..pppppp..', '...pppp...'];
export const CAT = ['k........k', 'kakkkkkkak', 'kaaaaaaaak', 'kakaakaaak', 'kaaaaaaaak', '.kkkkkkkk.'];
export const CAT_PAL = { a: '#ffb15c', k: '#1b1033' };
export const BEANBAG = ['...bbbbbb...', '..bBBBBBBb..', '.bBBBBBBBBb.', 'bBBBBBBBBBBb', 'bBBBBBBBBBBb', 'bbBBBBBBBBbb', '.bbbbbbbbbb.', '..bbbbbbbb..'];
export const BEANBAG_PAL = { b: '#b8543a', B: '#e8775a' };

export type Theme = 'library' | 'aquarium' | 'garden' | 'couch' | 'board' | 'fire' | 'construct' | 'plain';
const THEMES: [string, Theme][] = [
  ['chief', 'library'],
  ['architect', 'aquarium'],
  ['design', 'garden'],
  ['develop', 'couch'],
  ['frontend', 'couch'],
  ['backend', 'couch'],
  ['qa', 'board'],
  ['summar', 'fire'],
  ['owner', 'construct'],
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
/** The owner's own room: manual sessions in Office terminals and background sessions of this project, each a creature at a desk. */
export const OWNER_ROOM = 'owner';
export function ownerRoom(terminals: TerminalView[], claude: ClaudeSession[], projectId: string): OfficeRoom {
  const manual = terminals.filter((t) => t.projectId === projectId && t.status !== 'exited');
  const background = claude.filter((s) => s.projectId === projectId && s.live?.kind === 'background' && isSessionRunning(s));
  const parts = [manual.length && `${manual.length} manual`, background.length && `${background.length} background`].filter(Boolean);
  const newest = [...manual].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return {
    agentId: OWNER_ROOM,
    slug: OWNER_ROOM,
    name: 'You',
    status: parts.length ? 'running' : 'idle',
    task: parts.length ? `Your Claude sessions: ${parts.join(', ')}` : 'No Claude session of your own here',
    workerName: newest ? 'Office terminal' : null,
    runId: null,
    startedAt: newest?.startedAt ?? null,
    costUsd: 0,
    subs: [
      ...manual.map((t) => ({ name: t.attachId ? `attached ${t.attachId}` : t.claudeSessionId.slice(0, 8), done: false })),
      ...background.map((s) => ({ name: s.live?.name ?? s.title, done: false })),
    ],
    waitingFor: null,
  };
}

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

/** One lane per room with its events placed on a shared axis (0 oldest, 1 now); events of agents outside the rooms are dropped. */
export function timelineLanes<T extends { agentId: string; ts: string }>(rooms: { agentId: string }[], rows: T[], now: number) {
  const known = new Set(rooms.map((r) => r.agentId));
  const times = rows.filter((r) => known.has(r.agentId)).map((r) => Date.parse(r.ts));
  const start = times.length ? Math.min(...times) : now;
  const span = Math.max(now - start, 1);
  return {
    start,
    lanes: rooms.map((room) => ({
      agentId: room.agentId,
      events: rows.filter((r) => r.agentId === room.agentId).map((event) => ({ event, at: Math.min((Date.parse(event.ts) - start) / span, 1) })),
    })),
  };
}

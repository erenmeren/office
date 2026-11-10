'use client';

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { agentGradient } from '@/lib/agent-identity';
import {
  BEANBAG,
  BEANBAG_PAL,
  CAST_H,
  CAST_PAL,
  CAST_W,
  CAT,
  CAT_PAL,
  HEAD,
  LAMP,
  LAMP_PAL,
  MONSTERA,
  PLANT,
  PLANT_PAL,
  ROOM_H,
  ROOM_W,
  SEAT_ROWS,
  SMITH,
  SUBPOS,
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  creatureFor,
  floorLayout,
  roomOrigin,
  sprite,
  themeFor,
  type Mail,
  type OfficeRoom,
} from '@/lib/office';
import { elapsed } from '@/lib/sessions';
import { statusLabel, statusTone, type Tone } from '@/lib/status';

const TONE: Record<Tone, string> = { live: '#3df5c8', decision: '#ffc247', failed: '#ff6b9a', idle: '#8d8ab3', done: '#8d8ab3' };
const SHORT: Record<string, string> = { waiting_approval: 'Approval', waiting_reply: 'Reply' };
const MARK: Record<string, string> = { waiting_approval: '!', waiting_reply: '?' };

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const abs = (left: number, top: number, width: number, height: number, more: CSSProperties = {}): CSSProperties => ({ position: 'absolute', left, top, width, height, ...more });
/** A sprite stood up on the floor: the pixel grid is rotated back to face the camera. */
const stand = (left: number, top: number, size: number, z: number, more: CSSProperties = {}): CSSProperties =>
  abs(left, top, size, size, { transformOrigin: '50% 100%', transform: `translateZ(${z}px) rotateZ(-45deg) rotateX(-60deg)`, ...more });
const Pixels = ({ shadow, px = 3 }: { shadow: string; px?: number }) => <div style={{ width: px, height: px, boxShadow: shadow }} />;

const PLANT_S = sprite(PLANT, PLANT_PAL, 3);
const LAMP_S = sprite(LAMP, LAMP_PAL, 3);
const MONSTERA_S = sprite(MONSTERA, PLANT_PAL, 3);
const CAT_S = sprite(CAT, CAT_PAL, 3);
const BEANBAG_S = sprite(BEANBAG, BEANBAG_PAL, 3);
// cell size of the cast: the room's tenant, and the smaller Smith copies in front of it
const MAIN_PX = 2;
const SUB_PX = 1.5;
const SMITH_S = sprite(SMITH.slice(0, SEAT_ROWS), CAST_PAL, SUB_PX);
// a working tenant's cycle: seated, then the walk of `om-walk`; rooms start it at different points
const WALK_S = 60;
const walkDelay = (i: number) => `-${(i * 23) % WALK_S}s`;
/** The back of a chair, standing behind whoever sits in it. */
const chair = (x: number, y: number, w: number, h: number, background = '#34306a'): CSSProperties => stand(x - w / 2, y - h, w, 0, { height: h, borderRadius: `${w / 4}px ${w / 4}px 3px 3px`, background, border: '1px solid rgba(255,255,255,.22)' });
// green code falling down the owner's wall screen: one column per entry, each at its own speed
const RAIN = [0.9, 1.6, 1.1, 1.9, 1.3, 0.8, 1.7, 1.2, 1.5, 1.0, 1.8, 1.4];
// the cast wears black on a dark floor; the green rim keeps it readable
const RIM = 'drop-shadow(0 0 2px rgba(57,255,20,.75))';
const FLOWER = { pink: sprite(PLANT, { ...PLANT_PAL, G: '#ff8fb1' }, 3), yellow: sprite(PLANT, { ...PLANT_PAL, G: '#ffe14d' }, 3), violet: sprite(PLANT, { ...PLANT_PAL, G: '#b39dff' }, 3) };
const BOOKS = 'repeating-linear-gradient(90deg,#d9534f 0 4px,#4fe3ff 4px 7px,#ffe14d 7px 10px,#b39dff 10px 14px,#3df5c8 14px 17px,#ff6ad5 17px 19px,#2a1d14 19px 21px)';

/** The themed corner of a room: library, aquarium, garden, couch, board or fireplace. */
function Corner({ theme }: { theme: ReturnType<typeof themeFor> }) {
  switch (theme) {
    case 'library':
      return (
        <>
          <div style={abs(20, 0, 90, 16, { transform: 'translateZ(52px)', background: '#3a2a1e', border: '1px solid rgba(255,255,255,.15)' })} />
          <div style={abs(20, 16, 90, 52, { transformOrigin: 'top', transform: 'rotateX(90deg)', background: `repeating-linear-gradient(0deg,#3a2a1e 0 3px,transparent 3px 13px),${BOOKS}`, border: '1px solid #241810' })} />
          <div style={abs(110, 0, 52, 16, { transformOrigin: 'left', transform: 'rotateY(-90deg)', background: '#2f2218' })} />
          <div style={abs(0, 110, 16, 90, { transform: 'translateZ(52px)', background: '#3a2a1e', border: '1px solid rgba(255,255,255,.15)' })} />
          <div style={abs(16, 110, 52, 90, { transformOrigin: 'left', transform: 'rotateY(-90deg)', background: `repeating-linear-gradient(90deg,#3a2a1e 0 3px,transparent 3px 13px),${BOOKS.replace('90deg', '0deg')}`, border: '1px solid #241810' })} />
          <div style={abs(0, 200, 16, 52, { transformOrigin: 'top', transform: 'rotateX(90deg)', background: '#2f2218' })} />
        </>
      );
    case 'aquarium':
      return (
        <>
          <div style={abs(190, 28, 84, 44, { borderRadius: '50%', transform: 'translateZ(.6px)', background: 'radial-gradient(closest-side,rgba(79,227,255,.4),transparent)', animation: 'om-glow 3s ease-in-out infinite' })} />
          <div style={abs(196, 4, 70, 24, { transform: 'translateZ(20px)', background: '#2a2456', border: '1px solid rgba(255,255,255,.15)' })} />
          <div style={abs(196, 28, 70, 20, { transformOrigin: 'top', transform: 'rotateX(90deg)', background: '#1f1b45' })} />
          <div style={abs(266, 4, 20, 24, { transformOrigin: 'left', transform: 'rotateY(-90deg)', background: '#262152' })} />
          <div style={abs(196, 4, 70, 24, { transform: 'translateZ(52px)', background: 'rgba(79,227,255,.22)', border: '1px solid rgba(255,255,255,.5)' })} />
          <div style={abs(196, 28, 70, 32, { transformOrigin: 'top', transform: 'translateZ(20px) rotateX(90deg)', background: 'linear-gradient(0deg,rgba(79,227,255,.5),rgba(79,227,255,.25))', border: '1px solid rgba(255,255,255,.55)', boxShadow: '0 0 14px rgba(79,227,255,.45)' })}>
            <i style={abs(12, 10, 7, 4, { borderRadius: 2, background: '#ffa66b', animation: 'om-bob 2.2s ease-in-out infinite' })} />
            <i style={abs(40, 18, 6, 3, { borderRadius: 2, background: '#f6f5ff', animation: 'om-bob 1.8s ease-in-out infinite .6s' })} />
            <i style={abs(26, 4, 5, 3, { borderRadius: 2, background: '#ffe14d', animation: 'om-bob 2.6s ease-in-out infinite 1.1s' })} />
            <i style={abs(6, 24, 12, 6, { borderRadius: '50% 50% 0 0', background: '#3fae6a' })} />
            <i style={abs(52, 22, 10, 8, { borderRadius: '50% 50% 0 0', background: '#2f8a52' })} />
          </div>
          <div style={abs(266, 4, 32, 24, { transformOrigin: 'left', transform: 'translateZ(20px) rotateY(-90deg)', background: 'rgba(79,227,255,.3)', border: '1px solid rgba(255,255,255,.5)' })} />
        </>
      );
    case 'garden':
      return (
        <>
          <div style={stand(21, -4, 30, 0)}><Pixels shadow={MONSTERA_S} /></div>
          <div style={stand(238, -2, 24, 0)}><Pixels shadow={FLOWER.yellow} /></div>
          <div style={stand(8, 80, 24, 0)}><Pixels shadow={FLOWER.pink} /></div>
          <div style={stand(8, 122, 24, 0)}><Pixels shadow={FLOWER.violet} /></div>
          <div style={stand(8, 164, 24, 0)}><Pixels shadow={PLANT_S} /></div>
          <div style={stand(8, 206, 24, 0)}><Pixels shadow={FLOWER.pink} /></div>
          <div style={stand(266, 212, 30, 0)}><Pixels shadow={MONSTERA_S} /></div>
          <div style={abs(10, 92, 22, 150, { borderRadius: 6, transform: 'translateZ(.6px)', background: 'rgba(63,174,106,.18)', border: '1px dashed rgba(143,227,173,.35)' })} />
        </>
      );
    case 'construct':
      // the red armchair and the table with the two pills
      return (
        <>
          <div style={abs(14, 104, 36, 42, { transform: 'translateZ(14px)', background: '#b3202a', border: '1px solid rgba(0,0,0,.3)' })} />
          <div style={abs(14, 146, 36, 14, { transformOrigin: 'top', transform: 'rotateX(90deg)', background: '#7d141c' })} />
          <div style={abs(50, 104, 14, 42, { transformOrigin: 'left', transform: 'rotateY(-90deg)', background: '#96181f' })} />
          <div style={abs(14, 104, 36, 10, { transform: 'translateZ(40px)', background: '#b3202a', border: '1px solid rgba(0,0,0,.3)' })} />
          <div style={abs(14, 114, 36, 26, { transformOrigin: 'top', transform: 'translateZ(14px) rotateX(90deg)', background: '#8a161e' })} />
          <div style={abs(50, 104, 26, 10, { transformOrigin: 'left', transform: 'translateZ(14px) rotateY(-90deg)', background: '#96181f' })} />
          <div style={abs(14, 114, 6, 32, { transform: 'translateZ(24px)', background: '#c42833' })} />
          <div style={abs(44, 114, 6, 32, { transform: 'translateZ(24px)', background: '#c42833' })} />
          <div style={abs(14, 146, 6, 10, { transformOrigin: 'top', transform: 'translateZ(14px) rotateX(90deg)', background: '#7d141c' })} />
          <div style={abs(44, 146, 6, 10, { transformOrigin: 'top', transform: 'translateZ(14px) rotateX(90deg)', background: '#7d141c' })} />
          <div style={abs(50, 114, 10, 32, { transformOrigin: 'left', transform: 'translateZ(14px) rotateY(-90deg)', background: '#96181f' })} />
          <div style={abs(58, 126, 22, 14, { borderRadius: '50%', transform: 'translateZ(.6px)', background: 'rgba(0,0,0,.3)' })} />
          <div style={abs(68, 131, 2, 18, { transformOrigin: 'top', transform: 'rotateX(90deg)', background: '#8d8ab3' })} />
          <div style={abs(60, 122, 18, 18, { borderRadius: '50%', transform: 'translateZ(18px)', background: '#e9e7f7', border: '1px solid rgba(0,0,0,.25)' })} />
          <div style={abs(63, 127, 6, 4, { borderRadius: 2, transform: 'translateZ(19px)', background: '#e11d2e' })} />
          <div style={abs(70, 132, 6, 4, { borderRadius: 2, transform: 'translateZ(19px)', background: '#2f7bff' })} />
        </>
      );
    case 'couch':
      return (
        <>
          <div style={abs(12, 126, 38, 90, { transform: 'translateZ(14px)', background: '#8a5a3c', border: '1px solid rgba(0,0,0,.3)' })} />
          <div style={abs(12, 216, 38, 14, { transformOrigin: 'top', transform: 'rotateX(90deg)', background: '#6e4530' })} />
          <div style={abs(50, 126, 14, 90, { transformOrigin: 'left', transform: 'rotateY(-90deg)', background: '#7a4f36' })} />
          <div style={abs(12, 126, 38, 14, { transform: 'translateZ(34px)', background: '#8a5a3c', border: '1px solid rgba(0,0,0,.3)' })} />
          <div style={abs(12, 140, 38, 20, { transformOrigin: 'top', transform: 'translateZ(14px) rotateX(90deg)', background: '#6e4530' })} />
          <div style={abs(50, 126, 20, 14, { transformOrigin: 'left', transform: 'translateZ(14px) rotateY(-90deg)', background: '#7a4f36' })} />
          <div style={abs(18, 148, 26, 22, { borderRadius: 4, transform: 'translateZ(15px)', background: '#d9b36b', border: '1px solid rgba(0,0,0,.2)' })} />
          <div style={abs(14, 226, 18, 18, { transform: 'translateZ(16px)', background: '#3f3870', border: '1px solid rgba(255,255,255,.18)' })} />
          <div style={abs(14, 244, 18, 16, { transformOrigin: 'top', transform: 'rotateX(90deg)', background: '#262050' })} />
          <div style={abs(32, 226, 16, 18, { transformOrigin: 'left', transform: 'rotateY(-90deg)', background: '#302a5e' })} />
          <div style={abs(18, 230, 10, 8, { transform: 'translateZ(17px)', background: '#f6f5ff', border: '1px solid rgba(0,0,0,.2)' })} />
        </>
      );
    case 'board':
      return (
        <>
          <div style={stand(26, 136, 36, 0, { height: 24 })}><Pixels shadow={BEANBAG_S} /></div>
          <div style={abs(26, 150, 40, 22, { borderRadius: '50%', transform: 'translateZ(.6px)', background: 'rgba(0,0,0,.3)' })} />
        </>
      );
    case 'fire':
      return (
        <>
          <div style={abs(30, 18, 92, 50, { borderRadius: '50%', transform: 'translateZ(.6px)', background: 'radial-gradient(closest-side,rgba(255,170,80,.5),transparent)', animation: 'om-glow 1.4s ease-in-out infinite' })} />
          <div style={abs(40, 0, 70, 18, { transform: 'translateZ(56px)', background: '#4a4470', border: '1px solid rgba(255,255,255,.2)' })} />
          <div style={abs(40, 18, 70, 56, { transformOrigin: 'top', transform: 'rotateX(90deg)', background: 'repeating-linear-gradient(0deg,rgba(0,0,0,.18) 0 1px,transparent 1px 9px),#3d3764', border: '1px solid rgba(0,0,0,.3)' })}>
            <i style={abs(14, 4, 42, 34, { background: 'radial-gradient(ellipse at 50% 100%,#ffd27a 0,#ff8a3c 30%,#7a2a2e 62%,#1a0e22 100%)', animation: 'om-glow 1.1s ease-in-out infinite' })} />
          </div>
          <div style={abs(110, 0, 56, 18, { transformOrigin: 'left', transform: 'rotateY(-90deg)', background: '#413b6b' })} />
          <div style={abs(36, 68, 42, 28, { borderRadius: '50%', transform: 'translateZ(.7px)', background: '#5a4a8a', border: '2px solid #7a6aaa' })} />
          <div style={stand(42, 70, 30, 2, { height: 18 })}><Pixels shadow={CAT_S} /></div>
        </>
      );
    default:
      return null;
  }
}

function Room({ room, i, rx, ry, selected, onSelect }: { room: OfficeRoom; i: number; rx: number; ry: number; selected: boolean; onSelect: () => void }) {
  const [c1, c2] = agentGradient(room.slug);
  const toneKey = statusTone(room.status);
  const tone = TONE[toneKey];
  const live = toneKey === 'live';
  const glow = hexA(tone, live ? 0.55 : toneKey === 'decision' ? 0.5 : 0.18);
  const theme = themeFor(room.slug);
  const rows = creatureFor(room.slug);
  const W = CAST_W * MAIN_PX;
  const walk = live ? { animationDelay: walkDelay(i) } : {};
  return (
    <div aria-hidden onClick={onSelect} style={abs(rx, ry, ROOM_W, ROOM_H, { transformStyle: 'preserve-3d', cursor: 'pointer' })}>
      <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(135deg,${hexA(c1, 0.24)},transparent 60%),repeating-linear-gradient(90deg,rgba(255,255,255,.045) 0 1px,transparent 1px 26px),repeating-linear-gradient(0deg,rgba(0,0,0,.12) 0 1px,transparent 1px 130px),#241d4a`, border: '1px solid rgba(255,255,255,.16)', boxShadow: `inset 0 0 0 2px ${selected ? tone : 'transparent'}` }} />
      <div style={abs(66, 32, 170, 112, { borderRadius: 18, transform: 'translateZ(.5px)', background: `repeating-linear-gradient(45deg,rgba(255,255,255,.06) 0 6px,transparent 6px 12px),${hexA(c1, 0.38)}`, border: '2px solid rgba(255,255,255,.12)' })} />
      {/* back wall with the night window and, in the QA room, the cork board */}
      <div style={abs(0, 0, ROOM_W, 60, { transformOrigin: 'top', transform: 'rotateX(90deg)', background: 'linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.2))', borderBottom: `2px solid ${c1}`, borderLeft: '1px solid rgba(255,255,255,.25)' })}>
        <div style={abs(206, 16, 60, 30, { background: 'radial-gradient(circle at 68% 36%,#ffe9b0 0 3px,transparent 4px),radial-gradient(circle at 30% 60%,rgba(255,255,255,.5) 0 .8px,transparent 1.5px),linear-gradient(180deg,#1b2a6b,#0d1440)', border: '2px solid rgba(255,255,255,.4)', boxShadow: '0 0 14px rgba(120,150,255,.35)' })} />
        {theme === 'construct' && (
          <div style={abs(36, 10, 136, 42, { overflow: 'hidden', background: '#020a04', border: '2px solid #1f5a3a', boxShadow: '0 0 16px rgba(57,255,20,.35)' })}>
            {RAIN.map((seconds, n) => (
              // the wall's y runs up from the floor, so the bright head of a streak is its first stop
              <i key={n} style={abs(4 + n * 11, 0, 4, 42, { background: 'repeating-linear-gradient(180deg,#d9ffe3 0 2px,#39ff14 2px 7px,rgba(57,255,20,.25) 7px 12px,transparent 12px 21px)', animation: `om-rain ${seconds}s linear infinite`, animationDelay: `-${n * 0.37}s` })} />
            ))}
          </div>
        )}
        {theme === 'board' && (
          <div style={abs(40, 12, 124, 40, { background: '#a9794f', border: '3px solid #6b4a2e' })}>
            <i style={abs(8, 6, 13, 13, { background: '#ffe14d', transform: 'rotate(-4deg)' })} />
            <i style={abs(28, 10, 13, 13, { background: '#ff8fb1', transform: 'rotate(5deg)' })} />
            <i style={abs(50, 5, 13, 13, { background: '#8fe3ad' })} />
            <i style={abs(70, 14, 13, 13, { background: '#9cc8ff', transform: 'rotate(-6deg)' })} />
            <i style={abs(92, 7, 22, 16, { background: '#f6f5ff', transform: 'rotate(3deg)' })} />
            <i style={abs(14, 26, 30, 8, { background: '#f6f5ff' })} />
          </div>
        )}
      </div>
      {/* left wall with the agent poster */}
      <div style={abs(0, 0, 60, ROOM_H, { transformOrigin: 'left', transform: 'rotateY(-90deg)', background: 'linear-gradient(90deg,rgba(255,255,255,.05),rgba(255,255,255,.16))', borderRight: `2px solid ${c1}` })}>
        <div style={abs(22, 70, 18, 26, { background: `linear-gradient(135deg,${c1},${c2})`, border: '2px solid rgba(255,255,255,.6)' })} />
      </div>
      <div style={stand(272, -6, 24, 0)}><Pixels shadow={PLANT_S} /></div>
      <Corner theme={theme} />
      {/* chair, worker (seated; a working one gets up for a walk now and then), desk, lamp, laptop, mug */}
      <div style={chair(HEAD.x, HEAD.y - 4, 48, 46, theme === 'construct' ? '#96181f' : undefined)} />
      <div style={stand(HEAD.x - W / 2, HEAD.y - SEAT_ROWS * MAIN_PX, W, 12, { height: SEAT_ROWS * MAIN_PX, filter: toneKey === 'idle' ? 'saturate(.6) brightness(.8) drop-shadow(0 0 1px rgba(57,255,20,.4))' : RIM, animation: live ? `om-sit ${WALK_S}s linear infinite` : 'none', ...walk })}>
        <Pixels shadow={sprite(rows.slice(0, SEAT_ROWS), CAST_PAL, MAIN_PX)} px={MAIN_PX} />
      </div>
      {live && (
        <div style={stand(HEAD.x - W / 2, HEAD.y - CAST_H * MAIN_PX, W, 0, { height: CAST_H * MAIN_PX, filter: RIM, visibility: 'hidden', animation: `om-walk ${WALK_S}s linear infinite`, ...walk })}>
          <div style={{ animation: 'om-step .45s linear infinite' }}>
            <Pixels shadow={sprite(rows, CAST_PAL, MAIN_PX)} px={MAIN_PX} />
          </div>
        </div>
      )}
      <div style={abs(98, 50, 104, 46, { transform: 'translateZ(22px)', background: '#3f3870', border: '1px solid rgba(255,255,255,.18)' })} />
      <div style={abs(98, 96, 104, 22, { transformOrigin: 'top', transform: 'rotateX(90deg)', background: '#262050' })} />
      <div style={abs(202, 50, 22, 46, { transformOrigin: 'left', transform: 'rotateY(-90deg)', background: '#302a5e' })} />
      <div style={abs(124, 52, 60, 28, { borderRadius: '50%', transform: 'translateZ(23px)', background: `radial-gradient(closest-side,${glow},transparent)`, animation: 'om-glow 2.4s ease-in-out infinite' })} />
      <div style={abs(94, 54, 36, 24, { borderRadius: '50%', transform: 'translateZ(23px)', background: 'radial-gradient(closest-side,rgba(255,201,107,.6),transparent)' })} />
      <div style={stand(101, 48, 18, 22, { height: 24 })}><Pixels shadow={LAMP_S} /></div>
      <div style={abs(136, 62, 28, 18, { transform: 'translateZ(23px)', background: '#15122e', border: '1px solid rgba(255,255,255,.22)' })} />
      <div style={abs(140, 66, 20, 7, { transform: 'translateZ(24px)', background: 'repeating-linear-gradient(90deg,rgba(255,255,255,.55) 0 2px,transparent 2px 4px)', animation: live ? 'om-keys .5s steps(2) infinite' : 'none' })} />
      <div style={abs(136, 80, 28, 18, { transformOrigin: 'top', transform: 'translateZ(23px) rotateX(90deg)', background: '#0d0a22', border: '1px solid rgba(255,255,255,.28)', boxShadow: `0 0 12px 2px ${glow}` })} />
      <div style={abs(180, 66, 7, 7, { borderRadius: '50%', transform: 'translateZ(23px)', background: '#ffb15c', border: '1px solid rgba(0,0,0,.3)' })} />
      {room.subs.map((s, i) => {
        const [x, y] = SUBPOS[Math.min(i, SUBPOS.length - 1)];
        return (
          // a fragment, not a div: a div in between flattens the 3D scene and lays the sprite on the floor
          <Fragment key={i}>
            <div style={chair(x, y - 1, 34, 34)} />
            <div style={stand(x - (CAST_W * SUB_PX) / 2, y + 2 - SEAT_ROWS * SUB_PX, CAST_W * SUB_PX, 8, { height: SEAT_ROWS * SUB_PX, filter: RIM, animation: s.done ? 'om-fade 1.6s ease-in-out infinite' : 'none' })}><Pixels shadow={SMITH_S} px={SUB_PX} /></div>
            <div style={abs(x - 15, y + 6, 30, 22, { transform: 'translateZ(14px)', background: '#3f3870', border: '1px solid rgba(255,255,255,.18)' })} />
            <div style={abs(x - 15, y + 28, 30, 14, { transformOrigin: 'top', transform: 'rotateX(90deg)', background: '#262050' })} />
            <div style={abs(x + 15, y + 6, 14, 22, { transformOrigin: 'left', transform: 'rotateY(-90deg)', background: '#302a5e' })} />
            <div style={abs(x - 5, y + 10, 10, 8, { transform: 'translateZ(15px)', background: '#15122e', border: '1px solid rgba(255,255,255,.25)' })} />
            <div style={abs(x - 5, y + 18, 10, 8, { transformOrigin: 'top', transform: 'translateZ(15px) rotateX(90deg)', background: '#0d0a22', border: '1px solid rgba(255,255,255,.3)', boxShadow: `0 0 8px 1px ${s.done ? 'rgba(141,138,179,.25)' : hexA(tone, 0.5)}` })} />
          </Fragment>
        );
      })}
    </div>
  );
}

const MONO: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 10 };

/** The flat layer over the floor: subagent tags, typing dots, marks, sleep, and the clickable plate. */
function Overlay({ room, i, P, now, selected, onSelect, bubble }: { room: OfficeRoom; i: number; P: ReturnType<typeof floorLayout>['P']; now: number; selected: boolean; onSelect: () => void; bubble?: string }) {
  const { rx, ry } = roomOrigin(i);
  const toneKey = statusTone(room.status);
  const tone = TONE[toneKey];
  const head = P(rx + HEAD.x, ry + HEAD.y, HEAD.z);
  const row = Math.floor(i / 3);
  const plate = row === 0 ? { l: P(rx, ry).x - 60, t: head.y - 160 } : { l: P(rx + ROOM_W, ry + ROOM_H).x - 72, t: P(rx + ROOM_W, ry + ROOM_H).y + 10 };
  const mark = MARK[room.status];
  const flip = row === 0;
  return (
    <>
      {bubble && toneKey !== 'idle' && (
        <div
          title={bubble}
          style={{ position: 'absolute', left: flip ? head.x - 22 : head.x + 22, top: head.y - 30, maxWidth: 176, padding: '5px 8px', borderRadius: flip ? '10px 10px 2px 10px' : '10px 10px 10px 2px', transform: flip ? 'translateX(-100%)' : 'none', background: '#f6f5ff', color: '#0b0820', fontSize: 11, lineHeight: 1.3, boxShadow: '0 4px 14px rgba(0,0,0,.4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {bubble}
        </div>
      )}
      {room.subs.map((s, j) => {
        const [x, y] = SUBPOS[Math.min(j, SUBPOS.length - 1)];
        const tag = P(rx + x, ry + y + 2, 62);
        return (
          <div key={j} style={{ position: 'absolute', left: tag.x, top: tag.y - 16, transform: 'translateX(-50%)', padding: '1px 6px', borderRadius: 5, background: 'rgba(7,5,20,.72)', color: '#d6d4ee', whiteSpace: 'nowrap', opacity: s.done ? 0.45 : 1, ...MONO, fontSize: 9 }}>
            {s.done ? `${s.name} ✓` : s.name}
          </div>
        );
      })}
      {toneKey === 'live' && (
        <div style={{ position: 'absolute', left: head.x - 14, top: head.y - 22, display: 'flex', gap: 3, padding: '4px 6px', borderRadius: 999, background: 'rgba(7,5,20,.7)', animation: `om-sit ${WALK_S}s linear infinite`, animationDelay: walkDelay(i) }}>
          {[0, 0.18, 0.36].map((d) => (
            <i key={d} style={{ width: 5, height: 5, borderRadius: '50%', background: '#3df5c8', animation: `om-dot 1.1s infinite ${d}s` }} />
          ))}
        </div>
      )}
      {mark && (
        <div style={{ position: 'absolute', left: head.x - 9, top: head.y - 28, width: 18, height: 18, borderRadius: '50%', background: '#ffc247', color: '#0b0820', fontWeight: 800, fontSize: 12, display: 'grid', placeItems: 'center', boxShadow: '0 0 12px rgba(255,194,71,.7)', animation: 'om-bob 1.2s ease-in-out infinite' }}>
          {mark}
        </div>
      )}
      {toneKey === 'idle' && (
        <div style={{ position: 'absolute', left: head.x + 6, top: head.y - 30, fontWeight: 700, color: '#b6b4d8', ...MONO }}>
          <span style={{ position: 'absolute', fontSize: 10, animation: 'om-zzz 2.4s infinite' }}>z</span>
          <span style={{ position: 'absolute', fontSize: 12, animation: 'om-zzz 2.4s infinite .8s' }}>z</span>
          <span style={{ position: 'absolute', fontSize: 14, animation: 'om-zzz 2.4s infinite 1.6s' }}>Z</span>
        </div>
      )}
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={onSelect}
        onKeyDown={(e) => e.key === 'Enter' && onSelect()}
        style={{ position: 'absolute', left: plate.l, top: plate.t, width: 144, boxSizing: 'border-box', pointerEvents: 'auto', cursor: 'pointer', padding: '8px 10px', borderRadius: 12, background: 'linear-gradient(145deg,rgba(28,24,66,.92),rgba(14,11,38,.88))', border: `1px solid ${selected ? tone : 'rgba(255,255,255,.18)'}`, boxShadow: '0 8px 24px rgba(3,1,18,.45),inset 0 1px 0 rgba(255,255,255,.12)', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, lineHeight: 1.3 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: tone, boxShadow: `0 0 8px ${tone}` }} />
          <span style={{ fontWeight: 600, fontSize: 12, flex: 1 }}>{room.name}</span>
          <span style={{ ...MONO, color: tone, whiteSpace: 'nowrap' }}>{SHORT[room.status] ?? statusLabel(room.status)}</span>
        </div>
        <div style={{ color: '#d6d4ee', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{room.task}</div>
        <div style={{ display: 'flex', gap: 8, color: '#b6b4d8', ...MONO }}>
          <span>{room.startedAt ? elapsed(now - Date.parse(room.startedAt)) : '—'}</span>
          <span>${room.costUsd.toFixed(2)}</span>
          <span style={{ marginLeft: 'auto' }}>{room.subs.length} sub</span>
        </div>
        <div style={{ fontSize: 10, color: '#b6b4d8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{room.workerName ?? 'no session'}</div>
      </div>
    </>
  );
}

/** The isometric floor: one themed room per team member, scaled to the width it is given. */
/** Head-to-head arc between two rooms, the envelope's track. */
function mailPath(P: ReturnType<typeof floorLayout>['P'], from: number, to: number): string {
  const head = (i: number) => {
    const { rx, ry } = roomOrigin(i);
    return P(rx + HEAD.x, ry + HEAD.y, HEAD.z);
  };
  const a = head(from);
  const b = head(to);
  return `M ${a.x.toFixed(1)} ${(a.y - 12).toFixed(1)} Q ${((a.x + b.x) / 2).toFixed(1)} ${(Math.min(a.y, b.y) - 90).toFixed(1)} ${b.x.toFixed(1)} ${(b.y - 12).toFixed(1)}`;
}

const ZOOM_KEY = 'office.zoom';

export function OfficeFloor({ rooms, selected, onSelect, now, mail = [], bubbles = {} }: { rooms: OfficeRoom[]; selected: string | null; onSelect: (agentId: string) => void; now: number; mail?: Mail[]; bubbles?: Record<string, string> }) {
  const layout = floorLayout(rooms.length);
  const index = (agentId: string) => rooms.findIndex((r) => r.agentId === agentId);
  const flights = mail.filter((m) => index(m.from) >= 0 && index(m.to) >= 0);
  const ref = useRef<HTMLDivElement>(null);
  // the scale that shows the whole floor in the viewport (0 until measured), times the owner's zoom
  const [fit, setFit] = useState(0);
  const [zoom, setZoom] = useState(() => clampZoom(Number(localStorage.getItem(ZOOM_KEY))));
  const scale = (fit || 1) * zoom;
  // the floor point (a fraction of the scroll area) to keep under a viewport point through the next scale change; the first one centres the floor
  const hold = useRef<{ fx: number; fy: number; ax?: number; ay?: number } | null>({ fx: 0.5, fy: 0.5 });
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setFit(Math.min(e.contentRect.width / layout.stageW, e.contentRect.height / layout.stageH, 1.5)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout.stageW, layout.stageH]);
  useLayoutEffect(() => {
    const el = ref.current;
    const h = hold.current;
    if (!el || !h || !fit) return;
    el.scrollTo(h.fx * el.scrollWidth - (h.ax ?? el.clientWidth / 2), h.fy * el.scrollHeight - (h.ay ?? el.clientHeight / 2));
    hold.current = null;
  }, [scale, fit]);
  const zoomTo = (next: number, ax?: number, ay?: number) => {
    const el = ref.current;
    const z = clampZoom(next);
    if (!el || z === zoom) return;
    hold.current = { fx: (el.scrollLeft + (ax ?? el.clientWidth / 2)) / el.scrollWidth, fy: (el.scrollTop + (ay ?? el.clientHeight / 2)) / el.scrollHeight, ax, ay };
    setZoom(z);
    localStorage.setItem(ZOOM_KEY, String(z));
  };
  // Ctrl or ⌘ with the wheel (a trackpad pinch too) zooms at the pointer, a plain wheel scrolls; React's onWheel is passive, so this listener is attached by hand
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomTo(zoom * Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });
  return (
    <div className="relative">
      <div
        ref={ref}
        className="flex cursor-grab overflow-auto select-none [scrollbar-width:none] active:cursor-grabbing"
        // as tall as the window leaves under the page header
        style={{ height: 'max(480px, calc(100dvh - 16.5rem))' }}
        onPointerDown={(e) => {
          drag.current = e.button === 0 && e.pointerType === 'mouse' ? { x: e.clientX, y: e.clientY, left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop, moved: false } : null;
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || !(e.buttons & 1)) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 4) return;
          if (!d.moved) e.currentTarget.setPointerCapture(e.pointerId);
          d.moved = true;
          e.currentTarget.scrollTo(d.left - dx, d.top - dy);
        }}
        // a drag is not a click on the room it ended over
        onClickCapture={(e) => {
          if (drag.current?.moved) e.stopPropagation();
        }}
      >
        <div style={{ position: 'relative', flex: 'none', margin: 'auto', overflow: 'hidden', width: layout.stageW * scale, height: layout.stageH * scale, visibility: fit ? 'visible' : 'hidden' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, width: layout.stageW, height: layout.stageH, transformOrigin: '0 0', transform: `scale(${scale})` }}>
            <div style={abs(layout.left, layout.top, layout.w, layout.h, { transformStyle: 'preserve-3d', transform: 'rotateX(60deg) rotateZ(45deg)' })}>
              <div style={{ position: 'absolute', inset: -40, transform: 'translateZ(-2px)', background: 'repeating-linear-gradient(90deg,rgba(255,255,255,.03) 0 1px,transparent 1px 28px),linear-gradient(180deg,rgba(255,170,100,.05),transparent 40%),rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 8 }} />
              {rooms.map((r, i) => (
                <Room key={r.agentId} room={r} i={i} {...roomOrigin(i)} selected={r.agentId === selected} onSelect={() => onSelect(r.agentId)} />
              ))}
            </div>
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              {flights.length > 0 && (
                <svg aria-label="Messages in flight" style={{ position: 'absolute', inset: 0, overflow: 'visible' }} width={layout.stageW} height={layout.stageH} viewBox={`0 0 ${layout.stageW} ${layout.stageH}`}>
                  {flights.map((m) => (
                    <g key={m.id}>
                      <path id={`mail-${m.id}`} d={mailPath(layout.P, index(m.from), index(m.to))} fill="none" stroke="rgba(255,106,213,.7)" strokeWidth="1.5" strokeDasharray="3 5" />
                      <g>
                        <rect x="-7" y="-5" width="14" height="10" rx="1.5" fill="#fff" stroke="#ff6ad5" />
                        <path d="M-7 -5 L0 1 L7 -5" fill="none" stroke="#ff6ad5" />
                        <animateMotion dur="3.2s" repeatCount="indefinite">
                          <mpath href={`#mail-${m.id}`} />
                        </animateMotion>
                      </g>
                    </g>
                  ))}
                </svg>
              )}
              {rooms.map((r, i) => (
                <Overlay key={r.agentId} room={r} i={i} P={layout.P} now={now} selected={r.agentId === selected} onSelect={() => onSelect(r.agentId)} bubble={bubbles[r.agentId]} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="absolute top-3 right-3 z-[2] flex items-center gap-1">
        <Button variant="secondary" size="icon-sm" aria-label="Zoom out" disabled={zoom <= ZOOM_MIN} onClick={() => zoomTo(Math.ceil(zoom * 4 - 1) / 4)}>
          <Minus />
        </Button>
        <Button variant="secondary" size="sm" aria-label="Reset zoom" className="w-14 font-mono" onClick={() => zoomTo(1)}>
          {Math.round(zoom * 100)}%
        </Button>
        <Button variant="secondary" size="icon-sm" aria-label="Zoom in" disabled={zoom >= ZOOM_MAX} onClick={() => zoomTo(Math.floor(zoom * 4 + 1) / 4)}>
          <Plus />
        </Button>
      </div>
    </div>
  );
}

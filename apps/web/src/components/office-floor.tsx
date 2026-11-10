'use client';

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { agentGradient } from '@/lib/agent-identity';
import {
  BIKE,
  BIKE_PAL,
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
  type Theme,
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
const BIKE_S = sprite(BIKE, BIKE_PAL, 2.5);
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
const RED = ['#b3202a', '#7d141c', '#96181f'];

/** A box on the floor: its top and the two faces the camera sees. A fragment, because a wrapper element would flatten the 3D scene. */
function Box({ x, y, w, d, h, z = 0, c }: { x: number; y: number; w: number; d: number; h: number; z?: number; c: string[] }) {
  return (
    <>
      <div style={abs(x, y, w, d, { transform: `translateZ(${z + h}px)`, background: c[0], border: '1px solid rgba(0,0,0,.25)' })} />
      <div style={abs(x, y + d, w, h, { transformOrigin: 'top', transform: `translateZ(${z}px) rotateX(90deg)`, background: c[1] })} />
      <div style={abs(x + w, y, h, d, { transformOrigin: 'left', transform: `translateZ(${z}px) rotateY(-90deg)`, background: c[2] })} />
    </>
  );
}

/** What stands in a room besides the desk: for the cast, something of theirs from the film. */
function Corner({ theme }: { theme: Theme }) {
  switch (theme) {
    case 'dojo':
      // Morpheus: the tatami of the sparring program
      return <div style={abs(10, 112, 54, 128, { transform: 'translateZ(.6px)', background: 'repeating-linear-gradient(0deg,rgba(0,0,0,.28) 0 1px,transparent 1px 43px),#c8b77e', border: '3px solid #4a3a22' })} />;
    case 'monitors':
      // the Architect: light falling in from the door to the Source
      return <div style={abs(2, 146, 50, 38, { borderRadius: '50%', transform: 'translateZ(.6px)', background: 'radial-gradient(closest-side,rgba(255,255,255,.45),transparent)' })} />;
    case 'bike':
      // Trinity: the motorcycle of the freeway chase
      return (
        <>
          <div style={abs(14, 14, 62, 24, { borderRadius: '50%', transform: 'translateZ(.6px)', background: 'rgba(0,0,0,.35)' })} />
          <div style={stand(13.5, 5.5, 65, 0, { height: 32.5 })}><Pixels shadow={BIKE_S} px={2.5} /></div>
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
          {/* the woman in red: a rail of red dresses, and a mirror */}
          <div style={abs(60, 12, 62, 2, { transformOrigin: 'top', transform: 'translateZ(46px) rotateX(90deg)', background: '#c9ccd6' })} />
          {[60, 120].map((x) => (
            <div key={x} style={abs(x, 12, 2, 46, { transformOrigin: 'top', transform: 'rotateX(90deg)', background: '#8d8ab3' })} />
          ))}
          {['#e11d2e', '#b3202a', '#ff4d5e', '#9e1220', '#e11d2e'].map((c, n) => (
            // a face stood up on its top edge is drawn bottom up: the wide end of the polygon is the hem
            <div key={n} style={abs(65 + n * 11, 13, 9, 28, { transformOrigin: 'top', transform: 'translateZ(17px) rotateX(90deg)', background: c, clipPath: 'polygon(0 0,100% 0,72% 100%,28% 100%)' })} />
          ))}
          <div style={stand(27, 22, 18, 0, { height: 34, borderRadius: '50% 50% 20% 20%', background: 'linear-gradient(135deg,#eaf6ff,#9fc3e6 55%,#dfefff)', border: '2px solid #d9a93a' })} />
        </>
      );
    case 'kitchen':
      // the Oracle: cookies in the oven, and the vase
      return (
        <>
          <Box x={24} y={2} w={40} d={28} h={30} c={['#d9d6e8', '#bdb9d1', '#a9a5c0']} />
          <div style={abs(27, 6, 14, 10, { borderRadius: '50%', transform: 'translateZ(30.6px)', background: '#2a2438' })} />
          <div style={abs(44, 6, 17, 12, { transform: 'translateZ(31px)', background: 'radial-gradient(circle at 25% 30%,#c98b4a 0 2px,transparent 2.5px),radial-gradient(circle at 70% 35%,#c98b4a 0 2px,transparent 2.5px),radial-gradient(circle at 45% 75%,#c98b4a 0 2px,transparent 2.5px),#aab1bd' })} />
          <div style={abs(30, 30.5, 28, 16, { transformOrigin: 'top', transform: 'translateZ(6px) rotateX(90deg)', background: 'radial-gradient(ellipse at 50% 30%,#ffd27a,#ff8a3c 45%,#7a2a2e)', border: '2px solid #2a2438', animation: 'om-glow 1.6s ease-in-out infinite' })} />
          <div style={abs(30, 30.5, 28, 2, { transformOrigin: 'top', transform: 'translateZ(25px) rotateX(90deg)', background: '#6b7280' })} />
          <Box x={20} y={140} w={16} d={16} h={14} c={['#7a5230', '#4a2f18', '#5e3d22']} />
          <div style={stand(21, 126, 14, 14, { height: 22, borderRadius: '45% 45% 50% 50% / 30% 30% 60% 60%', background: 'linear-gradient(90deg,#f1f6ff,#9db8e8)', border: '1px solid #4a67a8' })} />
        </>
      );
    case 'teahouse':
      // Seraph: the tea table where he tests his guests
      return (
        <>
          <div style={abs(20, 146, 30, 14, { borderRadius: 5, transform: 'translateZ(2px)', background: '#b3202a', border: '1px solid rgba(0,0,0,.3)' })} />
          <div style={abs(62, 116, 14, 24, { borderRadius: 5, transform: 'translateZ(2px)', background: '#d9a93a', border: '1px solid rgba(0,0,0,.3)' })} />
          <Box x={18} y={112} w={40} d={30} h={9} c={['#5a3a22', '#3f2815', '#4a2f1a']} />
          <div style={abs(24, 118, 5, 5, { borderRadius: '50%', transform: 'translateZ(9.6px)', background: '#f6f5ff' })} />
          <div style={abs(47, 131, 5, 5, { borderRadius: '50%', transform: 'translateZ(9.6px)', background: '#f6f5ff' })} />
          <div style={stand(32, 118, 12, 9, { height: 10, borderRadius: '50% 50% 40% 40%', background: '#f6f5ff', border: '1px solid #8d8ab3' })} />
        </>
      );
    case 'construct':
      // Neo: the red armchair and the table with the two pills
      return (
        <>
          <Box x={14} y={104} w={36} d={42} h={14} c={RED} />
          <Box x={14} y={104} w={36} d={10} h={26} z={14} c={RED} />
          <Box x={14} y={114} w={6} d={32} h={10} z={14} c={RED} />
          <Box x={44} y={114} w={6} d={32} h={10} z={14} c={RED} />
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

/** What hangs on a room's back wall. The wall is stood up on its top edge, so its y runs up from the floor. */
function WallArt({ theme }: { theme: Theme }) {
  switch (theme) {
    case 'construct':
      // Neo: green code falling down a screen
      return (
        <div style={abs(36, 10, 136, 42, { overflow: 'hidden', background: '#020a04', border: '2px solid #1f5a3a', boxShadow: '0 0 16px rgba(57,255,20,.35)' })}>
          {RAIN.map((seconds, n) => (
            // the bright head of a streak is its first stop, because y runs up
            <i key={n} style={abs(4 + n * 11, 0, 4, 42, { background: 'repeating-linear-gradient(180deg,#d9ffe3 0 2px,#39ff14 2px 7px,rgba(57,255,20,.25) 7px 12px,transparent 12px 21px)', animation: `om-rain ${seconds}s linear infinite`, animationDelay: `-${n * 0.37}s` })} />
          ))}
        </div>
      );
    case 'dojo':
      // Morpheus: the paper screens of the dojo
      return <div style={abs(18, 4, 96, 50, { background: 'repeating-linear-gradient(90deg,#3a2a1e 0 2px,transparent 2px 16px),repeating-linear-gradient(0deg,#3a2a1e 0 2px,transparent 2px 12px),#efe6cf', border: '2px solid #3a2a1e' })} />;
    case 'monitors':
      // the Architect: the wall of screens
      return (
        <div style={abs(16, 6, 180, 48, { background: '#05070d', border: '2px solid #1b2030', boxShadow: '0 0 16px rgba(160,200,255,.4)' })}>
          <i style={abs(0, 0, 176, 44, { background: 'repeating-linear-gradient(90deg,#05070d 0 2px,transparent 2px 16px),repeating-linear-gradient(0deg,#05070d 0 2px,transparent 2px 11px),repeating-linear-gradient(90deg,#cfe6ff 0 16px,#7fb2e6 16px 32px,#e8f3ff 32px 48px)', animation: 'om-glow 1.7s ease-in-out infinite' })} />
        </div>
      );
    case 'kitchen':
      // the Oracle: the sign over her kitchen door, flipped back because the wall draws bottom up
      return <div style={abs(18, 36, 104, 18, { display: 'grid', placeItems: 'center', transform: 'scaleY(-1)', background: '#7a5230', border: '2px solid #4a2f18', color: '#f6e7c4', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: 1 })}>TEMET NOSCE</div>;
    case 'teahouse':
      // Seraph: the green back doors he holds the key to
      return (
        <>
          {[26, 74].map((x) => (
            <div key={x} style={abs(x, 0, 30, 48, { background: 'linear-gradient(90deg,#2f8a52,#256b43)', border: '2px solid #f6f5ff', borderTop: 0 })}>
              <i style={abs(21, 20, 4, 4, { borderRadius: '50%', background: '#f6d55c' })} />
            </div>
          ))}
        </>
      );
    default:
      return null;
  }
}

/** What hangs on a room's left wall beside the agent's poster. Its x runs up from the floor. */
function SideArt({ theme }: { theme: Theme }) {
  switch (theme) {
    case 'dojo':
      // Morpheus: the rack of training weapons, a staff and two swords
      return (
        <>
          <i style={abs(12, 128, 36, 3, { background: '#3a2a1e' })} />
          <i style={abs(12, 178, 36, 3, { background: '#3a2a1e' })} />
          <i style={abs(18, 120, 3, 68, { background: '#b98a5a' })} />
          <i style={abs(28, 124, 2, 60, { background: 'linear-gradient(180deg,#2a1d14 0 22%,#d6dbe6 22%)' })} />
          <i style={abs(38, 124, 2, 60, { background: 'linear-gradient(180deg,#2a1d14 0 22%,#d6dbe6 22%)' })} />
        </>
      );
    case 'monitors':
      // the Architect: the door to the Source
      return <i style={abs(0, 150, 46, 30, { background: 'linear-gradient(90deg,#ffffff,#dfe9ff)', border: '2px solid #aab1bd', boxShadow: '0 0 18px rgba(255,255,255,.7)' })} />;
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
      {/* back wall with the night window and the room's wall art */}
      <div style={abs(0, 0, ROOM_W, 60, { transformOrigin: 'top', transform: 'rotateX(90deg)', background: 'linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.2))', borderBottom: `2px solid ${c1}`, borderLeft: '1px solid rgba(255,255,255,.25)' })}>
        <div style={abs(206, 16, 60, 30, { background: 'radial-gradient(circle at 68% 36%,#ffe9b0 0 3px,transparent 4px),radial-gradient(circle at 30% 60%,rgba(255,255,255,.5) 0 .8px,transparent 1.5px),linear-gradient(180deg,#1b2a6b,#0d1440)', border: '2px solid rgba(255,255,255,.4)', boxShadow: '0 0 14px rgba(120,150,255,.35)' })} />
        <WallArt theme={theme} />
      </div>
      {/* left wall with the agent poster */}
      <div style={abs(0, 0, 60, ROOM_H, { transformOrigin: 'left', transform: 'rotateY(-90deg)', background: 'linear-gradient(90deg,rgba(255,255,255,.05),rgba(255,255,255,.16))', borderRight: `2px solid ${c1}` })}>
        <div style={abs(22, 70, 18, 26, { background: `linear-gradient(135deg,${c1},${c2})`, border: '2px solid rgba(255,255,255,.6)' })} />
        <SideArt theme={theme} />
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

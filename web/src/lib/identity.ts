// identity.ts — the local user's display name + color for Yjs
// awareness. Stored in SESSION storage (per-tab) on purpose so
// opening a second window on the same origin yields a distinct
// random user — matching the operator's expectation when they
// test multi-collaborator scenarios from one machine. The trade-off
// is that closing + reopening the tab forgets the name ; a future
// "Pin this identity" toggle in the Profile section can promote
// the chosen name+color+avatar to localStorage for persistence.
//
//   name  : free-form, defaults to a random "<adjective> <noun>"
//           pair on first visit. Editable from the right-side
//           CollaboratorsSidebar.
//   color : either user-picked (saved in COLOR_KEY) or randomly
//           drawn on first visit. A name change keeps the colour
//           you had unless you reset it.
//
// The Editor's y-codemirror.next consumes the same state to color
// the awareness cursors + selection bg in the buffer, and the
// authorship extension reads it to tint background by author. So
// any change here propagates everywhere through awareness.

const NAME_KEY = 'weft-loom-user-name';
const COLOR_KEY = 'weft-loom-user-color';
const AVATAR_KEY = 'weft-loom-user-avatar';

export interface Identity {
  name: string;
  color: string;
  // avatar is an optional URL to a photo (https://… or a data: URL
  // for pasted base64). When empty, the rendering layer derives a
  // circular initial-letters fallback from `name` over `color`.
  avatar?: string;
}

// initials picks one letter from the first word + one from the last,
// uppercased ; "swift falcon" → "SF", "Bob" → "B", "" → "?". The
// rendering layer drops these into a coloured circle when there's
// no photo URL set.
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const ADJECTIVES = [
  'swift', 'bright', 'quiet', 'curious', 'witty', 'calm', 'bold',
  'eager', 'jolly', 'kind', 'plucky', 'nimble',
];
const NOUNS = [
  'falcon', 'otter', 'fox', 'panda', 'sparrow', 'lynx', 'badger',
  'koala', 'heron', 'wolf', 'finch', 'lemur',
];

function randomName(): string {
  const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
  return pick(ADJECTIVES) + ' ' + pick(NOUNS);
}

export function loadIdentity(): Identity {
  let name = sessionStorage.getItem(NAME_KEY);
  if (!name) {
    name = randomName();
    sessionStorage.setItem(NAME_KEY, name);
  }
  // For first-time visitors we also persist a randomly-distributed
  // colour so the same client across sessions has a stable identity ;
  // a user who edits / hashes their name later still gets a fresh
  // colour band via colorForName().
  let color = sessionStorage.getItem(COLOR_KEY);
  if (!color) {
    color = randomColor();
    sessionStorage.setItem(COLOR_KEY, color);
  }
  const avatar = sessionStorage.getItem(AVATAR_KEY) ?? undefined;
  return { name, color, avatar };
}

export function saveName(name: string): Identity {
  name = name.trim();
  if (name === '') name = randomName();
  sessionStorage.setItem(NAME_KEY, name);
  const color = sessionStorage.getItem(COLOR_KEY) ?? colorForName(name);
  const avatar = sessionStorage.getItem(AVATAR_KEY) ?? undefined;
  return { name, color, avatar };
}

// saveColor persists a user-picked hex / hsl colour. Empty / null
// clears the override so we go back to the name-hash default — the
// CollaboratorsSidebar's "↺" reset button uses that.
export function saveColor(color: string | null, name: string): Identity {
  const avatar = sessionStorage.getItem(AVATAR_KEY) ?? undefined;
  if (!color) {
    sessionStorage.removeItem(COLOR_KEY);
    return { name, color: colorForName(name), avatar };
  }
  sessionStorage.setItem(COLOR_KEY, color);
  return { name, color, avatar };
}

// saveAvatar persists the photo URL ; empty / null drops the
// override so the rendering falls back on the coloured-circle +
// initials.
export function saveAvatar(avatar: string | null, name: string): Identity {
  const color = sessionStorage.getItem(COLOR_KEY) ?? colorForName(name);
  if (!avatar) {
    sessionStorage.removeItem(AVATAR_KEY);
    return { name, color, avatar: undefined };
  }
  sessionStorage.setItem(AVATAR_KEY, avatar);
  return { name, color, avatar };
}

// randomColor : draw an HSL with a random hue + readable mid-band
// saturation / lightness so the colour reads on both daisyUI light
// and dark themes. Used for fresh visitors who haven't picked.
function randomColor(): string {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 70%, 50%)`;
}

// colorForName : stable HSL color seeded by the FNV-1a hash of the
// display name. Saturation + lightness picked to land in the
// readable middle band on both light + dark themes.
export function colorForName(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hue = ((h >>> 0) % 360);
  return `hsl(${hue}, 70%, 50%)`;
}

// hslToHex converts the canonical "hsl(H, S%, L%)" string into a
// "#RRGGBB" hex string the browser's <input type="color"> accepts.
// Pass-through when input isn't HSL.
export function hslToHex(c: string): string {
  if (c.startsWith('#')) return c;
  const m = c.match(/^hsla?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%/);
  if (!m) return '#888888';
  const h = parseFloat(m[1]) / 360;
  const s = parseFloat(m[2]) / 100;
  const l = parseFloat(m[3]) / 100;
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const to2 = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  return '#' + to2(r) + to2(g) + to2(b);
}

// identity.ts — the local user's display name + color for Yjs
// awareness. Persists across reloads (localStorage). The name is
// editable from the navbar ; the color is derived from a stable hash
// of the name so two users with the same name still get distinct
// shades. The Editor's y-codemirror.next consumes the same state to
// color the awareness cursors in the buffer.

const NAME_KEY = 'weft-loom-user-name';

export interface Identity {
  name: string;
  color: string;
}

// Word lists used to generate a friendly default name on first
// visit (e.g. "swift falcon"). Keeping them small + alliterative
// so a fresh window doesn't shame the user with "anonymous".
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
  let name = localStorage.getItem(NAME_KEY);
  if (!name) {
    name = randomName();
    localStorage.setItem(NAME_KEY, name);
  }
  return { name, color: colorForName(name) };
}

export function saveName(name: string): Identity {
  name = name.trim();
  if (name === '') name = randomName();
  localStorage.setItem(NAME_KEY, name);
  return { name, color: colorForName(name) };
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

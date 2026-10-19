// Static Mario Kart Wii reference data. Names only — no game artwork is shipped.

export const POINTS = [15, 12, 10, 8, 7, 6, 5, 4, 3, 2, 1, 0]; // index 0 = 1st place
export const RACES_PER_GP = 4;
export const MAX_PLAYERS = 12;
export const MAX_GP_TOTAL = POINTS[0] * RACES_PER_GP; // 60

export const pointsFor = (place) => {
  if (!Number.isInteger(place) || place < 1 || place > MAX_PLAYERS) {
    throw new RangeError(`placement must be 1-${MAX_PLAYERS}, got ${place}`);
  }
  return POINTS[place - 1];
};

export const CHARACTERS = [
  'Baby Mario', 'Baby Luigi', 'Baby Peach', 'Baby Daisy', 'Toad', 'Toadette',
  'Koopa Troopa', 'Dry Bones', 'Mario', 'Luigi', 'Peach', 'Daisy', 'Yoshi',
  'Birdo', 'Diddy Kong', 'Bowser Jr.', 'Wario', 'Waluigi', 'Donkey Kong',
  'Bowser', 'King Boo', 'Rosalina', 'Funky Kong', 'Dry Bowser', 'Mii',
];

// Short tags + a theme colour per character, used for the text badges in the UI.
export const CHARACTER_COLORS = {
  'Baby Mario': '#e5484d', 'Baby Luigi': '#30a46c', 'Baby Peach': '#e93d82', 'Baby Daisy': '#f5a524',
  'Toad': '#3e63dd', 'Toadette': '#d6409f', 'Koopa Troopa': '#46a758', 'Dry Bones': '#8b8d98',
  'Mario': '#e5484d', 'Luigi': '#30a46c', 'Peach': '#e93d82', 'Daisy': '#f5a524', 'Yoshi': '#46a758',
  'Birdo': '#e93d82', 'Diddy Kong': '#ad7f58', 'Bowser Jr.': '#f76b15', 'Wario': '#ffc53d',
  'Waluigi': '#8e4ec6', 'Donkey Kong': '#ad7f58', 'Bowser': '#f76b15', 'King Boo': '#8b8d98',
  'Rosalina': '#0090ff', 'Funky Kong': '#ad7f58', 'Dry Bowser': '#8b8d98', 'Mii': '#0090ff',
};

export const CUPS = {
  Mushroom: ['Luigi Circuit', 'Moo Moo Meadows', 'Mushroom Gorge', "Toad's Factory"],
  Flower: ['Mario Circuit', 'Coconut Mall', 'DK Summit', "Wario's Gold Mine"],
  Star: ['Daisy Circuit', 'Koopa Cape', 'Maple Treeway', 'Grumble Volcano'],
  Special: ['Dry Dry Ruins', 'Moonview Highway', "Bowser's Castle", 'Rainbow Road'],
  Shell: ['GCN Peach Beach', 'DS Yoshi Falls', 'SNES Ghost Valley 2', 'N64 Mario Raceway'],
  Banana: ['N64 Sherbet Land', 'GBA Shy Guy Beach', 'DS Delfino Square', 'GCN Waluigi Stadium'],
  Leaf: ['DS Desert Hills', 'GBA Bowser Castle 3', "N64 DK's Jungle Parkway", 'GCN Mario Circuit'],
  Lightning: ['SNES Mario Circuit 3', 'DS Peach Gardens', 'GCN DK Mountain', "N64 Bowser's Castle"],
};

export const CUP_NAMES = Object.keys(CUPS);
export const ALL_TRACKS = CUP_NAMES.flatMap((c) => CUPS[c]);
export const ENGINE_CLASSES = ['50cc', '100cc', '150cc', 'Mirror'];
export const EVENT_KINDS = ['session', 'weekend', 'trip', 'other'];

export const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

import { GAMES } from './gamesService';

/**
 * What the Games tab's rail scrolls through: every duel the game service can start,
 * plus the games that are not a duel row in the database.
 *
 * Truth or Dare keeps a shared round of its own and Raise a Child is still being
 * designed, but both belong on the same rail as Snake and Chess — one chip each, one
 * panel under it — so nothing on the Games tab stands outside the carousel.
 */
const LIBRARY_GUESTS = [
  {
    id: 'truth-or-dare',
    kind: 'truth-or-dare',
    name: 'Truth or Dare',
    icon: '♥',
    description: 'Take turns with playful questions and long-distance dares. Every prompt can be done apart, by text, voice call or on your own phone.',
  },
  {
    id: 'raise-a-child',
    kind: 'raise-a-child',
    name: 'Raise a Child',
    icon: '👶',
    description: 'Grow a little one together — a game about the everyday choices of raising a family.',
  },
] as const;

/** One duel from the game service, tagged so the rail can tell the guests apart. */
export type GameEntry = typeof GAMES[number];
/** A game the rail shelters without a duel row behind it. */
export type GuestEntry = typeof LIBRARY_GUESTS[number];
/** One chip in the rail, and the panel it brings in. */
export type LibraryEntry = ({ kind: 'game' } & GameEntry) | GuestEntry;

/** Every chip in the rail, in the order it scrolls: the duels, then the two guests. */
export const GAME_LIBRARY: LibraryEntry[] = [
  ...GAMES.map((game) => ({ ...game, kind: 'game' as const })),
  ...LIBRARY_GUESTS,
];

import { GAMES } from './gamesService';

/**
 * Truth or Dare is a chip in the Games tab's rail even though it is not a duel row in the
 * database: it keeps a shared round of its own, and its panel is the way into it. One chip
 * among the duels means nothing on the tab stands outside the carousel.
 */
export const TRUTH_OR_DARE_ENTRY = {
  id: 'truth-or-dare',
  kind: 'truth-or-dare',
  name: 'Truth or Dare',
  icon: '♥',
  description: 'Take turns with playful questions and long-distance dares. Every prompt can be done apart, by text, voice call or on your own phone.',
} as const;

/** The shared-round chip's entry. */
export type TruthOrDareEntry = typeof TRUTH_OR_DARE_ENTRY;
/** A non-duel game played from a panel: Truth or Dare, for now the only one. */
export type GuestEntry = TruthOrDareEntry;
/** One duel from the game service, tagged so the rail can tell it from the guest chip. */
export type GameEntry = typeof GAMES[number];
/** One chip in the rail, and the panel it brings in. */
export type LibraryEntry = ({ kind: 'game' } & GameEntry) | TruthOrDareEntry;

/** Every chip in the rail, in the order it scrolls: the duels, then Truth or Dare. */
export const GAME_LIBRARY: LibraryEntry[] = [
  ...GAMES.map((game) => ({ ...game, kind: 'game' as const })),
  TRUTH_OR_DARE_ENTRY,
];

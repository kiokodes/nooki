import type { CompanionExpression } from '../types/companions';

import pairHappy from '../assets/companions/pair-happy.png';
import pairAffectionate from '../assets/companions/pair-affectionate.png';
import pairLaughing from '../assets/companions/pair-laughing.png';
import pairShy from '../assets/companions/pair-shy.png';
import pairSurprised from '../assets/companions/pair-surprised.png';

/**
 * Bundled local raster assets for the 5 companion expressions.
 * Each asset is a transparent 256x256 PNG containing both adult-chibi characters.
 */
export const COMPANION_ASSETS: Record<CompanionExpression, string> = {
  happy: pairHappy,
  affectionate: pairAffectionate,
  laughing: pairLaughing,
  shy: pairShy,
  surprised: pairSurprised,
};

export const COMPANION_ALTS: Record<CompanionExpression, string> = {
  happy: 'The two Nookis smiling and holding hands.',
  laughing: 'The two Nookis laughing together.',
  shy: 'The two Nookis sharing a bashful smile.',
  surprised: 'The two Nookis reacting with surprise.',
  affectionate: 'The two Nookis holding hands with a small heart between them.',
};

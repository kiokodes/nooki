/**
 * Type definitions for Nooki Companion characters.
 *
 * Canonical identities:
 * - Nooki A (male-presenting): bald scalp, dark eyebrows, short goatee, pink sweatshirt, dusty-rose trousers.
 * - Nooki B (female-presenting): natural afro puff, gold hoops, green wax-print ankara dress cinched at the waist, white shoes.
 * - Both: warm medium-brown skin, super-deformed adult-chibi proportions.
 */

export type CompanionExpression =
  | 'happy'
  | 'laughing'
  | 'shy'
  | 'surprised'
  | 'affectionate';

export const COMPANION_EXPRESSIONS: CompanionExpression[] = [
  'happy',
  'laughing',
  'shy',
  'surprised',
  'affectionate',
];

export interface NookiPairProps {
  /** The facial expression of the pair. Defaults to 'happy'. */
  expression?: CompanionExpression;
  /** Width in logical units (pixels) or CSS string. Suggested range 160-240. */
  width?: number | string;
  /** Height in logical units (pixels) or CSS string. */
  height?: number | string;
  /**
   * When true, excludes image from accessibility focus (decorative companion).
   * When false, supplies context-appropriate accessible text.
   * Defaults to true.
   */
  decorative?: boolean;
  /** Required when decorative is false. */
  accessibleLabel?: string;
  /** Optional additional class name. */
  className?: string;
  /** Optional inline styles. */
  style?: React.CSSProperties;
}

export interface HomeNookiCompanionsProps {
  /** The expression to display. Defaults to 'happy'. */
  expression?: CompanionExpression;
  /** Manual pause switch for the idle animation. */
  paused?: boolean;
  /**
   * When true, the pair lives on their own in a watch-only ambient theatre that
   * softly crossfades between expressions. No clicks or interaction. Defaults
   * to false for callers that want a single static expression; HomeView enables it.
   */
  ambient?: boolean;
  /**
   * Whether the partner is present on the couple's realtime channel. Home uses this
   * to favour affectionate/laughing art when both partners are available, and calmer
   * happy/shy expressions while the partner is away.
   */
  partnerOnline?: boolean;
  /**
   * Extension point for future finished transparent animation loop
   * (e.g. sitting side by side on a ledge, dangling feet, occasional blinks).
   */
  renderAnimation?: (props: {
    isPaused: boolean;
    prefersReducedMotion: boolean;
  }) => React.ReactNode;
  /** Optional additional class name. */
  className?: string;
  /** Optional inline styles for the outer slot container. */
  style?: React.CSSProperties;
}

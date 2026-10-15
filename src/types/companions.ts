/**
 * Type definitions for Nooki Companion characters.
 *
 * Canonical identities:
 * - Nooki A (male-presenting): bald scalp, dark eyebrows, short goatee, pink sweatshirt, dusty-rose trousers.
 * - Nooki B (female-presenting): natural afro puff, gold hoops, green dungarees, cream tee.
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

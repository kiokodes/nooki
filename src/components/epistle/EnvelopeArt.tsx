import React from 'react';
import { waxInitial } from '../../lib/epistle';

export interface EnvelopeArtProps {
  /** The writer's name — their initial goes in the wax. */
  senderName?: string;
  /** `true` while the wax is intact, `false` once the seal is broken. */
  sealed?: boolean;
  /** A waiting wax is muted; a broken one is cracked; an open day ahead greys it. */
  wax?: 'fresh' | 'waiting' | 'broken';
  /** Drives the flap's position for opened keepsakes. */
  open?: boolean;
  className?: string;
}

/**
 * The envelope itself, drawn in CSS: back, letter, pocket, flap, wax. The same
 * drawing stands in a mailbox card at 58px and alone on the ceremony stage at
 * 264px, so the letter a couple taps is always the same letter.
 */
export const EnvelopeArt: React.FC<EnvelopeArtProps> = ({
  senderName,
  sealed = true,
  wax = 'fresh',
  open = false,
  className,
}) => (
  <span
    className={`ep-env${className ? ` ${className}` : ''}`}
    data-sealed={sealed ? 'true' : 'false'}
    data-open={open ? 'true' : 'false'}
    aria-hidden="true"
  >
    <span className="ep-env-back" />
    <span className="ep-env-letter-mini" />
    <span className="ep-env-front" />
    <span className="ep-env-flap" />
    <span
      className={`ep-wax${wax === 'waiting' ? ' is-waiting' : ''}${wax === 'broken' ? ' is-broken' : ''}`}
    >
      <span>{waxInitial(senderName)}</span>
    </span>
  </span>
);

import React from 'react';
import { formatEpistleDate, letterParagraphs } from '../../lib/epistle';
import type { Epistle } from '../../types/database';

export interface LetterPaperProps {
  /** The letter — or just the words of one, for the read-it-once-more preview. */
  letter: Pick<Epistle, 'id' | 'title' | 'body' | 'sealed_at' | 'opened_at'>;
  /** The writer's name, for the sign-off line. */
  senderName: string;
  /** The dateline above the letter: where it was written, and the day. */
  dateline?: string | null;
  /** True for the once-only reading, where the ink arrives paragraph by paragraph. */
  animate?: boolean;
  /** False for previews, which are not yet a fact: no seal history under the words. */
  showSealLine?: boolean;
  className?: string;
}

/**
 * The letter itself, on its paper — the same sheet in the preview before sealing,
 * in the reading ceremony, and in the keepsakes. No bubbles, no chrome: a dateline,
 * an optional name, the words, and who they came from.
 */
export const LetterPaper: React.FC<LetterPaperProps> = ({
  letter,
  senderName,
  dateline,
  animate = false,
  showSealLine = true,
  className,
}) => {
  const paragraphs = letterParagraphs(letter.body);
  return (
    <article
      data-component="epistle-letter"
      data-letter-id={letter.id}
      className={`epistle-letter-paper${className ? ` ${className}` : ''}`}
      data-animate={animate ? 'true' : 'false'}
    >
      {dateline && <p className="epistle-dateline">{dateline}</p>}
      {letter.title?.trim() && <h2 className="epistle-letter-title">{letter.title.trim()}</h2>}
      <div className="epistle-letter-body">
        {paragraphs.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>
      <p className="epistle-letter-sign">— {senderName}</p>
      {/* Sealed and opened dates, for the keepsake shelf's quiet honesty. */}
      {showSealLine && (
        <p className="epistle-letter-meta" style={{ margin: '10px 0 0' }}>
          Sealed {letter.sealed_at ? formatEpistleDate(letter.sealed_at) : '—'}
          {letter.opened_at ? ` · Opened ${formatEpistleDate(letter.opened_at)}` : ''}
        </p>
      )}
    </article>
  );
};

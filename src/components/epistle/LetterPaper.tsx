import React from 'react';
import { formatEpistleDate, letterParagraphs } from '../../lib/epistle';
import type { Epistle } from '../../types/database';

export interface LetterPaperProps {
  /** The letter — or just the words of one, for the read-it-once-more preview. */
  letter: Pick<Epistle, 'id' | 'title' | 'body' | 'sealed_at' | 'opened_at'>;
  /** The dateline above the letter: where it was written, and the day. */
  dateline?: string | null;
  /** True for the once-only reading, where the ink arrives paragraph by paragraph. */
  animate?: boolean;
  /** False for previews, which are not yet a fact: no seal history under the words. */
  showSealLine?: boolean;
  /** A quiet line under the dateline naming the answered letter, for replies. */
  replyContext?: string | null;
  className?: string;
}

/**
 * The letter itself, on its paper — the same sheet in the preview before sealing,
 * in the reading ceremony, and in the keepsakes. No bubbles, no chrome: a dateline,
 * an optional name, and the words.
 *
 * The letter is never signed for the writer. A couple closes with whatever they like —
 * "love, Ana", "always, your Angel", a nickname only the two of them use — so the last
 * line of the letter belongs to them, not to a name the app pasted on.
 *
 * Every line of it sits on the paper's ruling: the dateline, the name and each line of
 * ink are one ruling tall, and the gaps between them are whole rulings too — so the
 * words never drift off their lines, however long the letter.
 */
export const LetterPaper: React.FC<LetterPaperProps> = ({
  letter,
  dateline,
  animate = false,
  showSealLine = true,
  replyContext,
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
      {replyContext && <p className="epistle-reply-context">{replyContext}</p>}
      {letter.title?.trim() && <h2 className="epistle-letter-title">{letter.title.trim()}</h2>}
      <div className="epistle-letter-body">
        {paragraphs.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>
      {/* Sealed and opened dates, for the keepsake shelf's quiet honesty. */}
      {showSealLine && (
        <p className="epistle-seal-line">
          Sealed {letter.sealed_at ? formatEpistleDate(letter.sealed_at) : '—'}
          {letter.opened_at ? ` · Opened ${formatEpistleDate(letter.opened_at)}` : ''}
        </p>
      )}
    </article>
  );
};

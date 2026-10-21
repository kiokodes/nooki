import React from 'react';
import { Mailbox as MailboxIcon } from 'lucide-react';
import '../../components/epistle/epistle.css';

export interface MailboxButtonProps {
  /** The partner's sealed letters that can be opened right now: the number on the flag. */
  count: number;
  /** The partner's letters still sealed until a chosen day. */
  waitingCount: number;
  /** Named in the hint and label, so the tap is clearly *from* them. */
  partnerName?: string;
  onOpen: () => void;
}

/**
 * The mailbox standing in the nook's bottom-left corner.
 *
 * A quiet little object, the way the "I miss you" button is: when the partner has
 * sealed a letter that is ready, the flag goes up — a number, and a whispered line
 * under it. On other days it is simply the way into the letters.
 */
export const MailboxButton: React.FC<MailboxButtonProps> = ({
  count,
  waitingCount,
  partnerName,
  onOpen,
}) => {
  const who = (partnerName || '').trim() || 'your partner';
  const label = count > 0
    ? `Mailbox — ${count} letter${count === 1 ? '' : 's'} from ${who} waiting to be opened`
    : waitingCount > 0
      ? `Mailbox — a sealed letter from ${who} is waiting for its day`
      : 'Mailbox — our letters';

  return (
    <div className="nooki-mailbox-flag" data-nooki-mailbox="corner">
      <button
        type="button"
        className="nooki-mailbox-button"
        data-nooki-mailbox-button="true"
        aria-label={label}
        onClick={onOpen}
      >
        <MailboxIcon size={13} />
        Mailbox
        {count > 0 && (
          <span className="nooki-mailbox-count" data-nooki-mailbox-count="true" aria-hidden="true">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>
      {count > 0 && (
        <p className="nooki-mailbox-hint" data-nooki-mailbox-hint="true">
          {who} wrote to you
        </p>
      )}
    </div>
  );
};

export default MailboxButton;

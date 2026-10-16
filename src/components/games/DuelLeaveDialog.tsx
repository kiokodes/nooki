import React from 'react';

export interface DuelLeaveDialogProps {
  /** What is being walked out on — "your snake run", "your Tetris run". */
  runLabel: string;
  partnerName: string;
  busy?: boolean;
  onKeepPlaying: () => void;
  onForfeit: () => void;
}

/**
 * The only question a duel asks. It sits over the board on purpose: there is no pause, so
 * the run is still going while the couple decide.
 *
 * Shared by the Snake and Tetris duels — the two games that are one attempt each and
 * cannot be paused — so the question reads the same way whichever board is behind it.
 */
export const DuelLeaveDialog: React.FC<DuelLeaveDialogProps> = ({
  runLabel, partnerName, busy = false, onKeepPlaying, onForfeit,
}) => (
  <div className="snake-leave" role="dialog" aria-modal="true" aria-label={`Leave ${runLabel}`}>
    <div className="snake-leave-card">
      <h2>Leave {runLabel}?</h2>
      <p>
        Leaving is a forfeit: {partnerName} wins this duel straight away, and {runLabel} cannot
        be paused or picked up again.
      </p>
      <p className="game-hint">The clock keeps running while this is on screen.</p>
      <div className="snake-leave-actions">
        <button type="button" onClick={onKeepPlaying}>Keep playing</button>
        <button type="button" className="snake-leave-danger" disabled={busy} onClick={onForfeit}>
          {busy ? 'Leaving…' : 'Leave and forfeit'}
        </button>
      </div>
    </div>
  </div>
);

export default DuelLeaveDialog;

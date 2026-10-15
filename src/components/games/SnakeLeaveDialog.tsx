import React from 'react';

interface SnakeLeaveDialogProps {
  partnerName: string;
  busy?: boolean;
  onKeepPlaying: () => void;
  onForfeit: () => void;
}

/**
 * The only question the Snake duel asks. It sits over the board on purpose: there is no
 * pause, so the snake is still moving while the couple decide.
 */
export const SnakeLeaveDialog: React.FC<SnakeLeaveDialogProps> = ({ partnerName, busy = false, onKeepPlaying, onForfeit }) => (
  <div className="snake-leave" role="dialog" aria-modal="true" aria-label="Leave your snake run">
    <div className="snake-leave-card">
      <h2>Leave your run?</h2>
      <p>
        Leaving is a forfeit: {partnerName} wins this duel straight away, and your run cannot be
        paused or picked up again.
      </p>
      <p className="game-hint">The snake keeps moving while this is on screen.</p>
      <div className="snake-leave-actions">
        <button type="button" onClick={onKeepPlaying}>Keep playing</button>
        <button type="button" className="snake-leave-danger" disabled={busy} onClick={onForfeit}>
          {busy ? 'Leaving…' : 'Leave and forfeit'}
        </button>
      </div>
    </div>
  </div>
);

export default SnakeLeaveDialog;

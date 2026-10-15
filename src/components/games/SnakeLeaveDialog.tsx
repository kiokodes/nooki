import React from 'react';
import { DuelLeaveDialog } from './DuelLeaveDialog';

interface SnakeLeaveDialogProps {
  partnerName: string;
  busy?: boolean;
  onKeepPlaying: () => void;
  onForfeit: () => void;
}

/**
 * The Snake duel's version of the one question a duel asks. It sits over the board on
 * purpose: there is no pause, so the snake is still moving while the couple decide.
 */
export const SnakeLeaveDialog: React.FC<SnakeLeaveDialogProps> = ({ partnerName, busy = false, onKeepPlaying, onForfeit }) => (
  <DuelLeaveDialog
    runLabel="your run"
    partnerName={partnerName}
    busy={busy}
    onKeepPlaying={onKeepPlaying}
    onForfeit={onForfeit}
  />
);

export default SnakeLeaveDialog;

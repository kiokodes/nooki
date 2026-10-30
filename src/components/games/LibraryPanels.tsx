import type { TodRound } from '../../lib/truthOrDare';
import type { TruthOrDareEntry } from '../../lib/gameLibrary';

/**
 * The panel for the guest game in the library rail: Truth or Dare's round, launched from
 * its chip. It lives here rather than inside `GamesView` so the design preview can render
 * the very same panel the app does.
 */

/** How an open round reads on the panel, without opening it. */
function roundStatus(round: TodRound | null): string | null {
  if (!round) return null;
  if (round.status === 'paused') return 'Round paused';
  if (round.status === 'inviting') return 'Waiting for both partners to join';
  return 'Round in progress';
}

export function TruthOrDarePanel({
  entry,
  round,
  ready,
  direction = 'next',
  onOpen,
}: {
  entry: TruthOrDareEntry;
  round: TodRound | null;
  /** False while the couple's shared room is still loading, so the button waits for it. */
  ready: boolean;
  direction?: 'next' | 'prev';
  onOpen: () => void;
}) {
  const status = roundStatus(round);
  return <article
    className="game-card game-panel tod-panel"
    data-game={entry.id}
    data-direction={direction}
    role="tabpanel"
    id={`game-panel-${entry.id}`}
    aria-labelledby={`game-tab-${entry.id}`}
  >
    <div className="game-icon game-icon-glyph" aria-hidden="true">{entry.icon}</div>
    <h2>{entry.name}</h2>
    <p>{entry.description}</p>
    {status && <p className="tod-panel-status" role="status">{status}</p>}
    <div className="game-actions">
      <button type="button" disabled={!ready} onClick={onOpen}>
        {!ready ? 'Opening your shared room…' : round ? 'Resume round →' : 'Choose a theme →'}
      </button>
    </div>
    <p className="game-hint">Both phones play the same round. Either of you can pause or end it.</p>
  </article>;
}


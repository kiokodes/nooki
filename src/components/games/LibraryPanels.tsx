import type { TodRound } from '../../lib/truthOrDare';
import type { RaiseAChildEntry, TruthOrDareEntry } from '../../lib/gameLibrary';

/**
 * The two cards for games that are not duels: Truth or Dare's panel in the library rail,
 * and the Raise a Child card that stands above the ongoing matches until its rules exist.
 *
 * They live here rather than inside `GamesView` so the design preview can render the very
 * same cards — the copy and the placeholder's honesty cannot drift apart from the app they
 * stand in for.
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

/**
 * Raise a Child has no rules yet, so its card says so and offers nothing to start. It sits
 * above the ongoing matches, which is where a game of its own lives on this tab.
 */
export function RaiseAChildCard({ entry, direction = 'next' }: {
  entry: RaiseAChildEntry;
  direction?: 'next' | 'prev';
}) {
  return <article
    className="game-card raise-a-child-card"
    data-card="raise-a-child"
    data-direction={direction}
  >
    <div className="game-icon game-icon-glyph" aria-hidden="true">{entry.icon}</div>
    <h2>{entry.name} <span className="game-soon-chip">In the works</span></h2>
    <p>{entry.description}</p>
    <p className="game-hint" id="raise-a-child-note">
      A placeholder for now: the milestones, the choices and how the two of you raise a
      little one together are still being written.
    </p>
    <div className="game-actions">
      <button type="button" disabled aria-describedby="raise-a-child-note">Coming soon</button>
    </div>
  </article>;
}

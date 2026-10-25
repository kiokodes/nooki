import { useState } from 'react';
import {
  bothPartnersMeetAgeRule,
  EMPTY_TOD_COUNTS,
  hasAcceptedRound,
  intensityForCompletedCount,
  isTodThemeLocked,
  isTodTurn,
  otherTodPlayer,
  requiredAgeForTheme,
  TOD_LOCKED_THEME_MESSAGE,
  TOD_THEMES,
  type TodAgeStatus,
  type TodPrompt,
  type TodPromptType,
  type TodTheme,
} from '../../lib/truthOrDare';
import type { TruthOrDareState } from '../../hooks/useTruthOrDare';
import './truthOrDare.css';

const THEME_COPY: Record<TodTheme, { label: string; badge: string; description: string }> = {
  random: {
    label: 'Random',
    badge: 'All adults',
    description: 'Playful, personal and deep. No sexual prompts.',
  },
  flirty: {
    label: 'Flirty',
    badge: '18+',
    description: 'Romantic, playful and closer. Both partners must be 18 or older.',
  },
  spicy: {
    label: 'Spicy',
    badge: 'Locked',
    description: 'Married couples only. Opens once marriage verification is available.',
  },
};

const MODE_LABELS: Record<TodPrompt['mode'], string> = {
  text: 'Text',
  voice: 'Voice',
  video_call: 'Private video call',
  solo: 'On your phone',
};

function ageMessage(theme: TodTheme, mine: TodAgeStatus, partner: TodAgeStatus, partnerName: string): string | null {
  const required = requiredAgeForTheme(theme);
  if (!required) return null;
  if (mine.tier < required) {
    if (mine.source === 'date_of_birth') return `This theme opens when both partners meet the ${required}+ age rule.`;
    return `Confirm that you are ${required} or older to unlock this theme.`;
  }
  if (partner.tier < required) {
    if (partner.source === 'date_of_birth') return `This theme opens when both partners meet the ${required}+ age rule.`;
    return `${partnerName} can confirm they meet the ${required}+ age rule on their own phone to unlock this theme.`;
  }
  return null;
}

function themePoolReady(counts: { truth: number; dare: number }): boolean {
  return counts.truth > 0 && counts.dare > 0;
}

function PromptCard({ prompt }: { prompt: TodPrompt }) {
  return <article className="tod-prompt" aria-live="polite" aria-atomic="true">
    <div className="tod-prompt-labels">
      <span className={`tod-type-chip tod-type-chip--${prompt.type}`}>{prompt.type === 'truth' ? 'Truth' : 'Dare'}</span>
      <span className="tod-intensity">Intensity {prompt.intensity} of 5</span>
    </div>
    <p className="tod-prompt-text">{prompt.text}</p>
    <span className="tod-mode">{MODE_LABELS[prompt.mode]}</span>
  </article>;
}

export function TruthOrDare({
  game,
  userId,
  partnerName,
  onExit,
}: {
  game: TruthOrDareState;
  userId: string;
  partnerName: string;
  onExit: () => void;
}) {
  const [selectedTheme, setSelectedTheme] = useState<TodTheme>('random');
  const [showAgeConfirm, setShowAgeConfirm] = useState(false);
  const [showRoundMenu, setShowRoundMenu] = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const snapshot = game.snapshot;
  const round = snapshot?.round ?? null;
  const ages = snapshot?.ages ?? {
    mine: { tier: 0, source: 'missing' as const },
    partner: { tier: 0, source: 'missing' as const },
  };
  const counts = snapshot?.active_counts ?? EMPTY_TOD_COUNTS;
  const myTurn = round ? isTodTurn(round, userId) : false;
  const accepted = round ? hasAcceptedRound(round, userId) : false;
  const otherPlayerId = round ? otherTodPlayer(round, userId) : null;
  const partnerAccepted = !!round && !!otherPlayerId && hasAcceptedRound(round, otherPlayerId);
  const poolReady = themePoolReady(counts[selectedTheme]);
  const ageReady = bothPartnersMeetAgeRule(selectedTheme, ages.mine, ages.partner);
  const ownAgeMessage = requiredAgeForTheme(selectedTheme) > 0
    && ages.mine.tier < requiredAgeForTheme(selectedTheme)
    && ages.mine.source !== 'date_of_birth';

  const selectTheme = (theme: TodTheme) => {
    if (isTodThemeLocked(theme)) return;
    setSelectedTheme(theme);
    setShowAgeConfirm(false);
    const required = requiredAgeForTheme(theme);
    if (required > 0 && ages.mine.tier < required && ages.mine.source !== 'date_of_birth') {
      setShowAgeConfirm(true);
    }
  };

  const confirmAge = async () => {
    await game.confirmAge(18);
    setShowAgeConfirm(false);
  };

  const acceptRound = () => { if (round) void game.acceptRound(round.id); };
  const choosePrompt = (type: TodPromptType) => { if (round) void game.choosePrompt(round.id, type); };
  const completePrompt = (result: 'done' | 'skip') => { if (round) void game.completePrompt(round.id, result); };
  const pauseRound = () => { if (round) void game.pauseRound(round.id); setShowRoundMenu(false); };
  const resumeRound = () => { if (round) void game.resumeRound(round.id); setShowRoundMenu(false); };
  const endRound = () => {
    if (!round) return;
    setShowEndConfirm(false);
    setShowRoundMenu(false);
    void game.endRound(round.id);
  };

  if (!snapshot && game.loading) return <section className="tod-view" aria-label="Truth or Dare">
    <p role="status">Opening your shared room…</p>
  </section>;

  // A Spicy round left open before the lock existed must not be playable. The migration
  // closes those rooms, so this card is only a safety net and a way out.
  if (round && isTodThemeLocked(round.theme)) return <section className="tod-view" aria-label="Truth or Dare">
    <div className="tod-waiting-card">
      <span className="tod-step-label">Spicy · locked</span>
      <h2>This round is closed</h2>
      <p>{TOD_LOCKED_THEME_MESSAGE} End it to play Random or Flirty instead.</p>
      <button type="button" className="tod-primary-button" disabled={game.busy} onClick={endRound}>End round</button>
    </div>
    {game.error && <p className="tod-error" role="alert">{game.error}</p>}
    <button type="button" className="tod-exit" onClick={onExit}>← All games</button>
  </section>;

  return <section className="tod-view" aria-label="Truth or Dare">
    {round ? <>
      <div className="tod-round-toolbar">
        <div className="tod-round-heading">
          <span className="tod-theme-chip">{THEME_COPY[round.theme].label}</span>
          <span className="tod-round-status">{round.status === 'inviting' ? 'New round' : round.status === 'paused' ? 'Paused' : 'In progress'}</span>
        </div>
        <button
          type="button"
          className="tod-round-control"
          aria-expanded={showRoundMenu}
          aria-controls="tod-round-actions"
          onClick={() => setShowRoundMenu((open) => !open)}
        >
          Pause / end
        </button>
      </div>

      {showRoundMenu && <div className="tod-round-actions" id="tod-round-actions" role="group" aria-label="Round controls">
        {round.status === 'paused'
          ? <button type="button" disabled={game.busy} onClick={resumeRound}>Resume round</button>
          : <button type="button" disabled={game.busy} onClick={pauseRound}>Pause round</button>}
        <button type="button" className="tod-end-action" disabled={game.busy} onClick={() => setShowEndConfirm(true)}>End round</button>
        <button type="button" className="tod-quiet-action" onClick={() => setShowRoundMenu(false)}>Keep playing</button>
      </div>}

      {round.status === 'inviting' && <div className="tod-waiting-card">
        <span className="tod-step-label">{THEME_COPY[round.theme].badge} · shared round</span>
        <h2>Join when you’re ready</h2>
        <p>{round.created_by === userId
          ? `You started a ${THEME_COPY[round.theme].label} round. Both of you can join when you’re ready.`
          : `${partnerName} started a ${THEME_COPY[round.theme].label} round. Both of you can join when you’re ready.`}</p>
        {accepted
          ? <p className="tod-status-line" role="status">You’re in. {partnerAccepted ? 'Opening the round…' : `Waiting for ${partnerName}.`}</p>
          : <button type="button" className="tod-primary-button" disabled={game.busy} onClick={acceptRound}>I’m in</button>}
      </div>}

      {round.status === 'paused' && <div className="tod-waiting-card">
        <span className="tod-step-label">{THEME_COPY[round.theme].label} · paused</span>
        <h2>Round paused</h2>
        <p>Your place is saved. Either of you can resume when you’re ready.</p>
        <button type="button" className="tod-primary-button" disabled={game.busy} onClick={resumeRound}>Resume round</button>
      </div>}

      {round.status === 'active' && <>
        <div className="tod-turn-line" aria-live="polite">
          <span className={myTurn ? 'tod-turn-dot is-mine' : 'tod-turn-dot'} aria-hidden="true" />
          <strong>{myTurn ? 'Your turn' : `${partnerName}’s turn`}</strong>
          <span>·</span>
          <span>Intensity {intensityForCompletedCount(round.completed_count)} of 5</span>
        </div>
        {round.current_prompt ? <>
          <PromptCard prompt={round.current_prompt} />
          {myTurn
            ? <div className="tod-prompt-actions">
                <button type="button" className="tod-primary-button" disabled={game.busy} onClick={() => completePrompt('done')}>Done</button>
                <button type="button" className="tod-skip-button" disabled={game.busy} onClick={() => completePrompt('skip')}>Skip</button>
              </div>
            : <p className="tod-status-line" role="status">Waiting for {partnerName} to choose Done or Skip.</p>}
        </> : myTurn ? <div className="tod-choice-card">
          <span className="tod-step-label">Choose a prompt</span>
          <h2>Truth or Dare?</h2>
          <p>Choose what feels right for this turn.</p>
          <div className="tod-choice-actions">
            <button type="button" className="tod-primary-button" disabled={game.busy} onClick={() => choosePrompt('truth')}>Truth</button>
            <button type="button" className="tod-dare-button" disabled={game.busy} onClick={() => choosePrompt('dare')}>Dare</button>
          </div>
        </div> : <div className="tod-waiting-card">
          <span className="tod-step-label">Next turn</span>
          <h2>{partnerName} is choosing</h2>
          <p>Your turn comes next.</p>
        </div>}
      </>}
    </> : <>
      <div className="tod-intro">
        <span className="tod-step-label">A shared game · separate phones</span>
        <h2>Truth or Dare</h2>
        <p>Take turns choosing. Every prompt can be done apart by text, voice, video call or on your own phone.</p>
      </div>
      <div className="tod-theme-picker" role="group" aria-label="Choose a theme">
        {TOD_THEMES.map((theme) => {
          const copy = THEME_COPY[theme];
          const themeCounts = counts[theme];
          const locked = isTodThemeLocked(theme);
          const isAvailable = themePoolReady(themeCounts);
          return <button
            key={theme}
            type="button"
            className={`tod-theme-option${selectedTheme === theme ? ' is-selected' : ''}${locked ? ' is-locked' : ''}`}
            aria-pressed={locked ? undefined : selectedTheme === theme}
            disabled={locked}
            onClick={() => selectTheme(theme)}
          >
            <span className="tod-theme-option-heading"><strong>{copy.label}</strong><span>{copy.badge}</span></span>
            <span>{copy.description}</span>
            <small>{locked
              ? 'No one can open this theme yet'
              : `${themeCounts.truth} truths · ${themeCounts.dare} dares · ${isAvailable ? 'ready' : 'not ready'}`}</small>
          </button>;
        })}
      </div>

      <p className="tod-locked-note" role="note">
        Spicy is locked for everyone right now. It opens for married couples only, once we can
        verify marriage certificates.
      </p>

      {requiredAgeForTheme(selectedTheme) > 0 && <div className="tod-gate-note" role="status">
        {ageMessage(selectedTheme, ages.mine, ages.partner, partnerName) || `Both partners meet the ${requiredAgeForTheme(selectedTheme)}+ age rule.`}
        {ownAgeMessage && <button type="button" className="tod-inline-link" onClick={() => setShowAgeConfirm(true)}>
          Confirm my age
        </button>}
      </div>}

      {!poolReady && <p className="tod-pool-note" role="status">
        This prompt pool is awaiting review in Supabase. Seeded prompts start inactive and become available when the owner turns them on.
      </p>}

      {game.error && <p className="tod-error" role="alert">{game.error}</p>}
      <button
        type="button"
        className="tod-primary-button tod-start-button"
        disabled={!snapshot || isTodThemeLocked(selectedTheme) || !ageReady || !poolReady || game.busy}
        aria-busy={game.busy}
        onClick={() => void game.startRound(selectedTheme)}
      >
        {game.busy ? 'Starting…' : 'Start a round'}
      </button>
      <p className="tod-safety-note">Skip any prompt. Either partner can pause or end the round at any time.</p>
    </>}

    {game.error && round && <p className="tod-error" role="alert">{game.error}</p>}

    {showAgeConfirm && <div className="tod-modal-backdrop">
      <section className="tod-dialog" role="dialog" aria-modal="true" aria-labelledby="tod-age-title">
        <button type="button" className="tod-dialog-close" aria-label="Close age confirmation" onClick={() => setShowAgeConfirm(false)}>×</button>
        <span className="tod-step-label">One-time age check</span>
        <h2 id="tod-age-title">Confirm your age</h2>
        <p>There is no date of birth on your profile. Confirm you are 18 or older to unlock Flirty. Your partner confirms on their own phone, and only the minimum age you confirm is saved.</p>
        <div className="tod-dialog-actions">
          {ages.mine.tier < 18 && <button type="button" className="tod-primary-button" disabled={game.busy} onClick={() => void confirmAge()}>I’m 18 or older</button>}
          <button type="button" className="tod-quiet-action" onClick={() => setShowAgeConfirm(false)}>Not now</button>
        </div>
      </section>
    </div>}

    {showEndConfirm && round && <div className="tod-modal-backdrop">
      <section className="tod-dialog" role="dialog" aria-modal="true" aria-labelledby="tod-end-title">
        <span className="tod-step-label">Round control</span>
        <h2 id="tod-end-title">End this round?</h2>
        <p>You can start another round any time.</p>
        <div className="tod-dialog-actions">
          <button type="button" className="tod-end-action" disabled={game.busy} onClick={endRound}>End round</button>
          <button type="button" className="tod-quiet-action" onClick={() => setShowEndConfirm(false)}>Keep playing</button>
        </div>
      </section>
    </div>}

    <button type="button" className="tod-exit" onClick={onExit}>← All games</button>
  </section>;
}

export function TruthOrDareLauncher({ game, onOpen }: { game: TruthOrDareState; onOpen: () => void }) {
  const round = game.snapshot?.round;
  const status = !round ? null
    : round.status === 'paused' ? 'Round paused'
      : round.status === 'inviting' ? 'Waiting for both partners to join'
        : 'Round in progress';
  return <article className="game-card tod-launcher">
    <div className="tod-launcher-icon" aria-hidden="true">♥</div>
    <div className="tod-launcher-copy">
      <span className="games-eyebrow">A little closer, from anywhere</span>
      <h2>Truth or Dare</h2>
      <p>Take turns with playful questions and long-distance dares.</p>
      {status && <p className="tod-launcher-status">{status}</p>}
    </div>
    <button type="button" onClick={onOpen}>{round ? 'Resume round →' : 'Choose a theme →'}</button>
  </article>;
}

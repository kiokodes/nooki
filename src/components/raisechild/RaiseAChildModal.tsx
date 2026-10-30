import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Check, Gift, Heart, Hourglass, MessageCircle, Sparkles, X } from 'lucide-react';
import { ChildAvatar } from './ChildAvatar';
import { DEFAULT_LOOK, HAIR_STYLES, MOOD_FACES, OUTFIT_COLOURS, SKIN_TONES } from '../../lib/raiseChildLook';
import type { RaiseChildAlbumEntry, RaiseChildChild, RaiseChildSnapshot } from '../../lib/raiseChildService';
import type { RaiseChildState } from '../../hooks/useRaiseChild';
import './raisechild.css';

interface RaiseAChildModalProps {
  state: RaiseChildState;
  userName: string;
  partnerName: string;
  /** Takes a disagreement to the chat, with both picks spelled out. */
  onTakeToChat?: (moment: RaiseChildSnapshot['today']['moments'][number]) => Promise<void>;
  /** The moment to open on, when the sheet was reached from the link in the chat. */
  focusMomentId?: string | null;
  onClose: () => void;
}

type View = 'home' | 'setup' | 'album' | 'letter';

const AGE_HEADINGS: Record<number, string> = {
  0: 'The first year',
  1: 'One',
  2: 'Two',
  3: 'Three',
  4: 'Four',
  5: 'Five',
  6: 'Six',
  7: 'Seven',
  8: 'Eight',
  9: 'Nine',
  10: 'Ten',
  11: 'Eleven',
  12: 'Twelve',
  13: 'Thirteen',
  14: 'Fourteen',
  15: 'Fifteen',
  16: 'Sixteen',
  17: 'Seventeen',
  18: 'Eighteen',
};

const KIND_LABELS: Record<RaiseChildAlbumEntry['kind'], string> = {
  moment: 'A moment',
  gift: 'A small surprise',
  milestone: 'A milestone',
  note: 'A note',
  letter: 'The letter',
};

function moodLine(child: RaiseChildChild): string {
  return `${child.name} ${MOOD_FACES[child.mood] ?? 'is quiet today'}.`;
}

function Panel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`raise-child-panel ${className}`.trim()}>{children}</div>;
}

// ----------------------------------------------------------------------------- setup

interface SetupScreenProps {
  snapshot: RaiseChildSnapshot;
  partnerName: string;
  busy: boolean;
  onSave: RaiseChildState['saveSetup'];
}

const SetupScreen: React.FC<SetupScreenProps> = ({ snapshot, partnerName, busy, onSave }) => {
  const [name, setName] = useState(snapshot.setup.name ?? '');
  const [look, setLook] = useState({ ...DEFAULT_LOOK, ...snapshot.setup.look });
  const [traits, setTraits] = useState<string[]>(snapshot.setup.mine);
  const [saved, setSaved] = useState(false);

  const toggleTrait = (slug: string) => {
    setSaved(false);
    setTraits((current) => current.includes(slug)
      ? current.filter((trait) => trait !== slug)
      : current.length >= 3 ? current : [...current, slug]);
  };

  const ready = traits.length === 3;

  return (
    <>
      <Panel>
        <div className="raise-child-hero">
          <ChildAvatar look={look} age={0} size={92} label="A first look at the child" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p className="raise-child-label">Together, before the first chapter</p>
            <p className="raise-child-copy">
              {snapshot.setup.partner_joined
                ? `${partnerName} is here. Pick a name and a face you both like.`
                : `Pick three things about yourself, and ${partnerName} will do the same.`}
            </p>
          </div>
        </div>
      </Panel>

      <Panel>
        <p className="raise-child-label">Their name</p>
        <div className="raise-child-field">
          <input
            className="raise-child-input"
            value={name}
            maxLength={40}
            onChange={(event) => { setName(event.target.value); setSaved(false); }}
            placeholder="Mia"
            aria-label="The child's name"
          />
          <p className="raise-child-copy--soft" style={{ margin: 0 }}>
            Either of you can change it until the first chapter opens.
          </p>
        </div>
        <p className="raise-child-label" style={{ marginTop: '14px' }}>Skin</p>
        <div className="raise-child-swatches">
          {SKIN_TONES.map((tone) => (
            <button
              key={tone.slug}
              type="button"
              className="raise-child-swatch"
              style={{ background: tone.color }}
              aria-label={tone.label}
              aria-pressed={look.skin === tone.color || look.skin === tone.slug}
              onClick={() => { setLook((current) => ({ ...current, skin: tone.color })); setSaved(false); }}
            />
          ))}
        </div>
        <p className="raise-child-label" style={{ marginTop: '14px' }}>Hair</p>
        <div className="raise-child-chips">
          {HAIR_STYLES.map((style) => (
            <button
              key={style.slug}
              type="button"
              className="raise-child-chip"
              aria-pressed={look.hair === style.slug}
              onClick={() => { setLook((current) => ({ ...current, hair: style.slug })); setSaved(false); }}
            >
              {style.label}
            </button>
          ))}
        </div>
        <p className="raise-child-label" style={{ marginTop: '14px' }}>Their colour</p>
        <div className="raise-child-swatches">
          {OUTFIT_COLOURS.map((colour) => (
            <button
              key={colour.slug}
              type="button"
              className="raise-child-swatch"
              style={{ background: colour.color }}
              aria-label={colour.label}
              aria-pressed={look.outfit === colour.color}
              onClick={() => { setLook((current) => ({ ...current, outfit: colour.color })); setSaved(false); }}
            />
          ))}
        </div>
      </Panel>

      <Panel>
        <p className="raise-child-label">Three things about you</p>
        <p className="raise-child-copy--soft" style={{ margin: '0 0 10px' }}>
          These never appear as scores. They quietly colour the childhood you two share.
        </p>
        <div className="raise-child-trait-grid" role="group" aria-label="Choose three traits">
          {snapshot.setup.catalog.map((trait) => {
            const pressed = traits.includes(trait.slug);
            return (
              <button
                key={trait.slug}
                type="button"
                className="raise-child-trait-option"
                aria-pressed={pressed}
                onClick={() => toggleTrait(trait.slug)}
              >
                <span className="raise-child-trait-option__label">{trait.label}</span>
                {trait.blurb && <span className="raise-child-trait-option__blurb">{trait.blurb}</span>}
              </button>
            );
          })}
        </div>
        <p className="raise-child-copy--soft" style={{ margin: '10px 0 0' }}>
          {traits.length} of 3 chosen.
        </p>
      </Panel>

      {snapshot.setup.partner_traits_ready && (
        <p className="raise-child-note">{partnerName} has chosen theirs. The first chapter opens as soon as you save.</p>
      )}
      {saved && <p className="raise-child-note">Saved. {snapshot.family?.status === 'setup' ? `Waiting for ${partnerName}.` : ''}</p>}

      <button
        type="button"
        className="raise-child-button raise-child-button--wide"
        disabled={!ready || busy}
        onClick={async () => {
          await onSave({ name: name.trim() || null, look, traits });
          setSaved(true);
        }}
      >
        {busy ? 'Saving…' : ready ? 'Save my part' : 'Choose three things'}
      </button>
    </>
  );
};

// ----------------------------------------------------------------------------- home

interface MomentCardProps {
  moment: RaiseChildSnapshot['today']['moments'][number];
  partnerName: string;
  busy: boolean;
  /** Reached from the chat link: this card is the one to show, so it is scrolled to. */
  focused?: boolean;
  onVote: (momentId: string, choice: number) => Promise<void>;
  onDecide: (momentId: string) => Promise<void>;
  onTalkItOut: (moment: RaiseChildSnapshot['today']['moments'][number]) => Promise<void>;
}

const MomentCard: React.FC<MomentCardProps> = ({
  moment, partnerName, busy, focused = false, onVote, onDecide, onTalkItOut,
}) => {
  const [changing, setChanging] = useState(false);
  const [talking, setTalking] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Coming back from the chat should land on the card, not at the top of a long list.
  useEffect(() => {
    if (!focused) return;
    const node = cardRef.current;
    if (!node || typeof node.scrollIntoView !== 'function') return;
    try {
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch {
      // A browser without smooth scrolling still shows the card; nothing to do.
    }
  }, [focused]);
  const mine = moment.choices.find((choice) => choice.index === moment.my_choice) ?? null;
  const theirs = moment.choices.find((choice) => choice.index === moment.partner_choice) ?? null;
  const choosing = !moment.resolved && (moment.my_choice === null || changing);

  // A second answer is only offered when the split is real and the change is still unused;
  // picking the same option again is not a change, so nothing is used up.
  const choose = (index: number) => {
    setChanging(false);
    void onVote(moment.id, index);
  };

  return (
    <div ref={cardRef} data-moment-id={moment.id} className={focused ? 'raise-child-focus' : undefined}>
    <Panel>
      <p className="raise-child-label">A moment with {moment.age === 0 ? 'your newborn' : 'your child'}</p>
      <p className="raise-child-moment__title">{moment.title}</p>
      <p className="raise-child-moment__setup">{moment.setup_text}</p>

      {moment.resolved && moment.outcome ? (
        <div className="raise-child-outcome">
          <p className="raise-child-outcome__note">{moment.outcome.note}</p>
          <p className="raise-child-outcome__body">{moment.outcome.outcome_text}</p>
          <p className="raise-child-outcome__saved">Kept in the album.</p>
        </div>
      ) : null}

      {!moment.resolved && moment.disagreement && (
        <div className="raise-child-split">
          <p className="raise-child-split__title">You chose differently.</p>
          <div className="raise-child-picks">
            <div className="raise-child-pick">
              <span className="raise-child-pick__who">You</span>
              <span className="raise-child-pick__what">{mine?.label ?? '—'}</span>
            </div>
            <div className="raise-child-pick">
              <span className="raise-child-pick__who">{partnerName}</span>
              <span className="raise-child-pick__what">{theirs?.label ?? '—'}</span>
            </div>
          </div>
          {!changing && (
            <>
              <p className="raise-child-copy--soft" style={{ margin: '0 0 10px' }}>
                {moment.is_lead
                  ? 'This year’s call is yours. Talk it through — or use it.'
                  : `${partnerName} has this year’s call. Talk it through, and you can still change your mind once.`}
              </p>
              <div className="raise-child-actions">
                <button
                  type="button"
                  className="raise-child-button raise-child-button--quiet"
                  disabled={busy || talking}
                  onClick={() => {
                    setTalking(true);
                    void onTalkItOut(moment).finally(() => setTalking(false));
                  }}
                >
                  <MessageCircle size={15} /> {talking ? 'Opening the chat…' : 'Talk it out'}
                </button>
                {moment.can_decide && (
                  <button
                    type="button"
                    className="raise-child-button"
                    disabled={busy}
                    onClick={() => { void onDecide(moment.id); }}
                  >
                    <Check size={15} /> Use my decision
                  </button>
                )}
                {moment.can_change && (
                  <button
                    type="button"
                    className="raise-child-button raise-child-button--text"
                    disabled={busy}
                    onClick={() => setChanging(true)}
                  >
                    Change my pick
                  </button>
                )}
              </div>
              {!moment.can_change && (
                <p className="raise-child-copy--soft" style={{ margin: '9px 0 0' }}>
                  You have had your second say. Nothing else is expected of you.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {choosing && (
        <div className="raise-child-choices">
          {moment.choices.map((choice) => (
            <button
              key={choice.index}
              type="button"
              className="raise-child-choice"
              data-current={choice.index === moment.my_choice ? 'true' : undefined}
              disabled={busy}
              onClick={() => choose(choice.index)}
            >
              <span className="raise-child-choice__mark" aria-hidden="true">{choice.index}</span>
              <span>{choice.label}</span>
            </button>
          ))}
          {changing && (
            <button
              type="button"
              className="raise-child-button raise-child-button--text"
              onClick={() => setChanging(false)}
            >
              Keep my first answer
            </button>
          )}
        </div>
      )}

      {!moment.resolved && moment.my_choice !== null && !moment.disagreement && !changing && (
        <div className="raise-child-waiting">
          <span className="raise-child-waiting__dot" aria-hidden="true" />
          <span>
            You picked “{mine?.label ?? 'one of them'}”. Waiting for {partnerName}.
          </span>
        </div>
      )}

      {!moment.resolved && moment.my_choice === null && (
        <p className="raise-child-copy--soft" style={{ margin: '10px 0 0' }}>
          Only you can see this answer until {partnerName} has chosen too.
        </p>
      )}
    </Panel>
    </div>
  );
};

interface HomeScreenProps {
  snapshot: RaiseChildSnapshot;
  state: RaiseChildState;
  partnerName: string;
  focusMomentId?: string | null;
  onOpenAlbum: () => void;
  onOpenLetter: () => void;
  onTalkItOut: (moment: RaiseChildSnapshot['today']['moments'][number]) => Promise<void>;
}

const HomeScreen: React.FC<HomeScreenProps> = ({
  snapshot, state, partnerName, focusMomentId = null, onOpenAlbum, onOpenLetter, onTalkItOut,
}) => {
  const child = snapshot.child;
  if (!child) return null;
  const moments = [...snapshot.today.moments].sort((a, b) => {
    if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
    return a.created_at.localeCompare(b.created_at);
  });
  const gift = snapshot.today.gift;
  const bondLine = snapshot.me.bond.line;

  return (
    <>
      <Panel>
        <div className="raise-child-hero">
          <ChildAvatar look={child.look} age={child.age} size={92} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p className="raise-child-hero__name">{child.name}</p>
            <p className="raise-child-hero__age">{child.age_label}</p>
            <p className="raise-child-hero__mood">{moodLine(child)}</p>
          </div>
        </div>
        {child.traits.length > 0 && (
          <div className="raise-child-traits">
            {child.traits.map((trait) => (
              <span key={trait.slug} className="raise-child-trait">{trait.label}</span>
            ))}
          </div>
        )}
        {bondLine && <p className="raise-child-quote" style={{ marginTop: '11px' }}>{bondLine}</p>}
        <div className="raise-child-actions">
          <button type="button" className="raise-child-button raise-child-button--quiet" onClick={onOpenAlbum}>
            <BookOpen size={15} /> The album{snapshot.album.count ? ` · ${snapshot.album.count}` : ''}
          </button>
          {snapshot.letter && (
            <button type="button" className="raise-child-button raise-child-button--quiet" onClick={onOpenLetter}>
              <Heart size={15} /> The letter
            </button>
          )}
        </div>
      </Panel>

      {!snapshot.configured && (
        <p className="raise-child-note">The story cards are still being written. Until then the days are quiet.</p>
      )}

      {moments.map((moment) => (
        <MomentCard
          key={moment.id}
          moment={moment}
          partnerName={partnerName}
          busy={state.busy}
          focused={moment.id === focusMomentId}
          onVote={state.vote}
          onDecide={state.decide}
          onTalkItOut={onTalkItOut}
        />
      ))}

      {moments.length === 0 && snapshot.configured && (
        <Panel>
          <p className="raise-child-copy">
            A quiet day. {child.name} is {child.age_label.toLowerCase()}, and nothing needs deciding.
          </p>
        </Panel>
      )}

      {gift && (
        <Panel className="raise-child-panel--paper">
          <p className="raise-child-label">{gift.opened ? 'A small surprise' : 'Something arrived'}</p>
          {gift.opened ? (
            <>
              <p className="raise-child-moment__title">{gift.title}</p>
              <p className="raise-child-copy" style={{ marginTop: '6px' }}>{gift.body}</p>
            </>
          ) : (
            <>
              <p className="raise-child-copy">A little card from {child.name}, waiting to be opened.</p>
              <div className="raise-child-actions">
                <button
                  type="button"
                  className="raise-child-button"
                  disabled={state.busy}
                  onClick={() => { void state.openGift(gift.id); }}
                >
                  <Gift size={15} /> Open it
                </button>
              </div>
            </>
          )}
        </Panel>
      )}

      <Panel>
        <p className="raise-child-label">The next year</p>
        {snapshot.today.can_age_up ? (
          <>
            <p className="raise-child-copy">Every moment in this chapter has an answer. Ready for the next year?</p>
            <div className="raise-child-actions">
              <button
                type="button"
                className="raise-child-button"
                disabled={state.busy}
                onClick={() => { void state.ageUp(); }}
              >
                <Sparkles size={15} /> {child.age >= 17 ? 'Turn eighteen' : `Turn ${child.age + 1}`}
              </button>
            </div>
          </>
        ) : (
          <p className="raise-child-copy--soft" style={{ display: 'flex', alignItems: 'center', gap: '7px', margin: 0 }}>
            <Hourglass size={14} /> {snapshot.today.age_up_hint ?? 'The next chapter opens when this one is answered.'}
          </p>
        )}
      </Panel>
    </>
  );
};

// ----------------------------------------------------------------------------- album

const AlbumScreen: React.FC<{ state: RaiseChildState; snapshot: RaiseChildSnapshot }> = ({ state, snapshot }) => {
  const entries = state.album;
  const grouped = useMemo(() => {
    const map = new Map<number, RaiseChildAlbumEntry[]>();
    for (const entry of entries) {
      map.set(entry.age, [...(map.get(entry.age) ?? []), entry]);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [entries]);

  return (
    <>
      <p className="raise-child-copy--soft" style={{ margin: 0 }}>
        Every outcome, gift and milestone, from the first day to now. {snapshot.album.count} page{snapshot.album.count === 1 ? '' : 's'}.
      </p>
      {state.albumLoading && entries.length === 0 && <p className="raise-child-copy--soft">Turning the pages…</p>}
      {entries.length === 0 && !state.albumLoading && <p className="raise-child-copy--soft">The album opens with the first chapter.</p>}
      <div className="raise-child-album">
        {grouped.map(([age, group]) => (
          <React.Fragment key={age}>
            <p className="raise-child-album__year">{AGE_HEADINGS[age] ?? `Age ${age}`}</p>
            {group.map((entry) => (
              <article key={entry.id} className="raise-child-entry" data-kind={entry.kind}>
                <span className="raise-child-entry__kind">{KIND_LABELS[entry.kind]}</span>
                <p className="raise-child-entry__title">{entry.title}</p>
                <p className="raise-child-entry__body">{entry.body}</p>
              </article>
            ))}
          </React.Fragment>
        ))}
      </div>
      {snapshot.album.count > entries.length && (
        <button
          type="button"
          className="raise-child-button raise-child-button--quiet raise-child-button--wide"
          disabled={state.albumLoading}
          onClick={() => { void state.loadAlbum({ before: entries[entries.length - 1]?.created_at ?? null }); }}
        >
          {state.albumLoading ? 'Turning…' : 'Earlier pages'}
        </button>
      )}
    </>
  );
};

// ----------------------------------------------------------------------------- letter

const LetterScreen: React.FC<{
  state: RaiseChildState;
  snapshot: RaiseChildSnapshot;
  childName: string;
  onOpenAlbum: () => void;
}> = ({ state, snapshot, childName, onOpenAlbum }) => {
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const letter = snapshot.letter;

  return (
    <>
      {letter ? (
        <div className="raise-child-letter">
          {letter.paragraphs.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      ) : (
        <Panel>
          <p className="raise-child-copy">The letter arrives when {childName} turns eighteen.</p>
        </Panel>
      )}

      <Panel>
        <p className="raise-child-label">One line back</p>
        {sent ? (
          <p className="raise-child-note">Saved to the album. {childName} would have liked that.</p>
        ) : (
          <>
            <p className="raise-child-copy--soft" style={{ margin: '0 0 8px' }}>
              Keep it short. It goes in the album beside the letter.
            </p>
            <div className="raise-child-letter__reply">
              <textarea
                className="raise-child-textarea"
                maxLength={400}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                aria-label="A short note back"
                placeholder="We read it twice…"
              />
              <p className="raise-child-count">{note.length}/400</p>
              <button
                type="button"
                className="raise-child-button"
                disabled={state.busy || note.trim().length === 0}
                onClick={async () => {
                  await state.reply(note);
                  setNote('');
                  setSent(true);
                }}
              >
                <Check size={15} /> Keep this note
              </button>
            </div>
          </>
        )}
      </Panel>

      <Panel>
        <p className="raise-child-label">What now</p>
        <p className="raise-child-copy--soft" style={{ margin: '0 0 10px' }}>
          The album stays yours forever, whichever you choose.
        </p>
        <div className="raise-child-actions" style={{ marginTop: 0 }}>
          <button type="button" className="raise-child-button raise-child-button--quiet" onClick={onOpenAlbum}>
            <BookOpen size={15} /> The album
          </button>
          {confirmNew ? (
            <>
              <button
                type="button"
                className="raise-child-button"
                disabled={state.busy}
                onClick={() => { void state.startNewChild(); setConfirmNew(false); }}
              >
                Yes, begin again
              </button>
              <button type="button" className="raise-child-button raise-child-button--quiet" onClick={() => setConfirmNew(false)}>
                Not yet
              </button>
            </>
          ) : (
            <button type="button" className="raise-child-button raise-child-button--quiet" onClick={() => setConfirmNew(true)}>
              Start a new child
            </button>
          )}
        </div>
      </Panel>
    </>
  );
};

// ----------------------------------------------------------------------------- sheet

/** The whole game, in a sheet over Together. Home, setup, album and the letter. */
export const RaiseAChildModal: React.FC<RaiseAChildModalProps> = ({
  state, userName, partnerName, onTakeToChat, focusMomentId = null, onClose,
}) => {
  const snapshot = state.snapshot;
  const status = snapshot?.family?.status ?? null;
  const [view, setView] = useState<View>(status === 'letter' ? 'letter' : 'home');
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  // The app re-renders all the time while this sheet is open — presence, the chat, a
  // partner's nudge — and every one of those renders hands over a new onClose. Keeping it
  // in a ref lets the effect below run once, on open: re-running it would pull focus off
  // whatever the reader is typing in, and on a phone that shuts the keyboard.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    // Never take focus from inside the sheet: a half-typed name belongs to the reader.
    if (!sheetRef.current?.contains(document.activeElement)) closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (view === 'album') void state.loadAlbum();
    // Loading the album is the only side effect of changing view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const childName = snapshot?.child?.name ?? 'your child';
  const effectiveView: View = !snapshot ? 'home'
    : status === 'setup' || status === null ? 'setup'
    : status === 'letter' ? (view === 'album' ? 'album' : 'letter')
    : view;

  const heading = effectiveView === 'setup' ? 'A family, together'
    : effectiveView === 'album' ? 'The family album'
    : effectiveView === 'letter' ? `${childName}’s letter`
    : childName;

  return (
    <div
      className="raise-child-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Raise a child"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="raise-child-sheet" ref={sheetRef}>
        <header className="raise-child-sheet__head">
          {effectiveView === 'album' && (
            <button
              type="button"
              className="raise-child-icon-button"
              onClick={() => setView(status === 'letter' ? 'letter' : 'home')}
              aria-label="Back"
            >
              <ArrowLeft size={17} />
            </button>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <p className="raise-child-sheet__eyebrow">Raise a child</p>
            <p className="raise-child-sheet__title">{heading}</p>
          </div>
          <button ref={closeRef} type="button" className="raise-child-icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </header>

        <div className="raise-child-sheet__body">
          {state.error && (
            <p className="raise-child-note raise-child-note--error" role="alert">{state.error}</p>
          )}

          {!snapshot && !state.error && <p className="raise-child-copy--soft">{userName}, one small moment…</p>}

          {snapshot && effectiveView === 'setup' && (
            <SetupScreen snapshot={snapshot} partnerName={partnerName} busy={state.busy} onSave={state.saveSetup} />
          )}

          {snapshot && effectiveView === 'home' && (
            <>
              {snapshot.family && snapshot.child ? (
                <HomeScreen
                  snapshot={snapshot}
                  state={state}
                  partnerName={partnerName}
                  focusMomentId={focusMomentId}
                  onOpenAlbum={() => setView('album')}
                  onOpenLetter={() => setView('letter')}
                  onTalkItOut={onTakeToChat ?? (async () => {})}
                />
              ) : (
                <SetupScreen snapshot={snapshot} partnerName={partnerName} busy={state.busy} onSave={state.saveSetup} />
              )}
            </>
          )}

          {snapshot && effectiveView === 'album' && <AlbumScreen state={state} snapshot={snapshot} />}

          {snapshot && effectiveView === 'letter' && (
            <LetterScreen
              state={state}
              snapshot={snapshot}
              childName={childName}
              onOpenAlbum={() => setView('album')}
            />
          )}
        </div>
      </div>
    </div>
  );
};

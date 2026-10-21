import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Feather, Mailbox as MailboxIcon, PenLine, Reply, Trash2, Undo2, X } from 'lucide-react';
import {
  EPISTLE_BODY_LIMIT,
  countWords,
  epistleAriaLabel,
  epistleState,
  formatDateline,
  formatEpistleDate,
  formatOpensIn,
  isEpistleOpenable,
  isEpistleReadable,
  letterExcerpt,
  replyAncestors,
  replyDescendants,
  replyParent,
  replySubject,
  sectionEpistles,
  splitKeepsakes,
  threadSize,
  waxInitial,
} from '../../lib/epistle';
import type { EpistleState } from '../../lib/epistle';
import type { Epistle } from '../../types/database';
import { EnvelopeArt } from './EnvelopeArt';
import { LetterPaper } from './LetterPaper';
import './epistle.css';

export interface EpistleViewProps {
  letters: Epistle[];
  loading: boolean;
  error: string | null;
  userId: string;
  myName: string;
  partnerName: string;
  /** The writer's own town, for the dateline — "Lagos, Nigeria". */
  myPlace: string | null;
  todayKey: string;
  onClose: () => void;
  onCreateDraft: (title: string, body: string, replyToId?: string | null) => Promise<Epistle>;
  onSaveDraft: (id: string, title: string, body: string, replyToId?: string | null) => Promise<Epistle>;
  onSeal: (id: string, opensAt: string | null) => Promise<Epistle>;
  onRecall: (id: string) => Promise<Epistle>;
  onOpen: (id: string) => Promise<Epistle>;
  onDiscard: (id: string) => Promise<void>;
  onClearError: () => void;
}

type Screen =
  | { kind: 'mailbox' }
  | { kind: 'compose'; draft: Epistle | null; replyToId: string | null }
  | { kind: 'ceremony'; epistle: Epistle }
  | { kind: 'read'; epistle: Epistle };

/** The mailbox's shelves: what arrived, what was sent, and what is still being written. */
type MailboxTab = 'received' | 'sent' | 'drafts';

type SealingStep = 'review' | 'when' | 'press' | 'sealed';

const CEREMONY_OPENING_MS = 1250;

/** The desk autosaves this often after the last keystroke. */
const AUTOSAVE_DEBOUNCE_MS = 900;

/** A letter's dateline: where it was written, and the day it began. */
function datelineFor(place: string | null, when: string): string {
  return formatDateline(place, when);
}

/** One mailbox card for a sealed letter, in every state an envelope can stand in. */
function EnvelopeCard({
  epistle,
  eyebrow,
  eyebrowMuted,
  waxName,
  state,
  ribbon,
  ribbonReady,
  threadNote,
  onActivate,
  activateLabel,
}: {
  epistle: Epistle;
  /** The line above the name: who it is from — or, for one's own, who it is to. */
  eyebrow: string;
  eyebrowMuted?: boolean;
  /** The writer, whose initial the wax carries. */
  waxName: string;
  state: EpistleState;
  /** The ribbon under the dates: a countdown, an invitation, or nothing at all. */
  ribbon: string | null;
  ribbonReady?: boolean;
  /** Where the letter stands in its correspondence, when it stands in one. */
  threadNote: string | null;
  /** Null while the seal refuses: a scheduled letter is looked at, not touched. */
  onActivate: (() => void) | null;
  activateLabel: string;
}) {
  const title = epistle.title?.trim() || 'An unnamed letter';
  const waiting = state === 'sealed-waiting';
  const opened = state === 'opened';
  const meta = `Sealed ${epistle.sealed_at ? formatEpistleDate(epistle.sealed_at) : '—'}${opened && epistle.opened_at ? ` · opened ${formatEpistleDate(epistle.opened_at)}` : ''}`;

  const Card = onActivate ? 'button' : 'div';

  return (
    <Card
      type={Card === 'button' ? 'button' : undefined}
      data-epistle-card={epistle.id}
      data-epistle-state={state}
      className="epistle-envelope"
      onClick={onActivate ?? undefined}
      aria-label={activateLabel}
      style={Card === 'div' ? { cursor: 'default' } : undefined}
    >
      <EnvelopeArt
        senderName={waxName}
        sealed={!opened}
        wax={opened ? 'broken' : waiting ? 'waiting' : 'fresh'}
        open={opened}
      />
      <span className="epistle-envelope-text">
        <span className={`ep-envelope-from${eyebrowMuted ? ' is-muted' : ''}`}>{eyebrow}</span>
        <span className="ep-envelope-title">{title}</span>
        <span className="ep-envelope-meta">{meta}</span>
        {threadNote && (
          <span className="ep-envelope-thread">
            <Reply size={11} aria-hidden="true" />
            <span>{threadNote}</span>
          </span>
        )}
        {ribbon && (
          <span className={`ep-envelope-ribbon${ribbonReady ? ' is-ready' : ''}`}>{ribbon}</span>
        )}
      </span>
    </Card>
  );
}

/**
 * Epistles — the whole world of letters, over everything else.
 *
 * A mailbox of envelopes instead of a list of messages; a writing desk instead of a
 * composer; a wax seal instead of a send button; and a reading ceremony instead of a
 * screen. Nothing here is a chat: a letter is written slowly, sealed deliberately,
 * and opened once.
 */
export const EpistleView: React.FC<EpistleViewProps> = ({
  letters,
  loading,
  error,
  userId,
  myName,
  partnerName,
  myPlace,
  todayKey,
  onClose,
  onCreateDraft,
  onSaveDraft,
  onSeal,
  onRecall,
  onOpen,
  onDiscard,
  onClearError,
}) => {
  const [screen, setScreen] = useState<Screen>({ kind: 'mailbox' });
  const [mailboxTab, setMailboxTab] = useState<MailboxTab>('received');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const sections = useMemo(() => sectionEpistles(letters, userId, todayKey), [letters, userId, todayKey]);
  const lettersById = useMemo(() => new Map(letters.map((letter) => [letter.id, letter])), [letters]);
  const isEmpty = letters.length === 0 && !loading;

  const partnerDisplay = (partnerName || 'Your partner').trim() || 'Your partner';

  const handleError = useCallback((err: unknown, fallback: string) => {
    setActionError(err instanceof Error ? err.message : fallback);
  }, []);

  // --- The writing desk ----------------------------------------------------

  const startCompose = useCallback((draft: Epistle | null, replyToId: string | null = null) => {
    setActionError(null);
    setScreen({ kind: 'compose', draft, replyToId });
  }, []);

  const replyToLetter = useCallback((epistle: Epistle) => {
    startCompose(null, epistle.id);
  }, [startCompose]);

  const openLetter = useCallback((epistle: Epistle) => {
    setActionError(null);
    // The chain holds snapshots; the mailbox holds the living letter.
    setScreen({ kind: 'read', epistle: lettersById.get(epistle.id) ?? epistle });
  }, [lettersById]);

  // --- Breaking a seal -----------------------------------------------------

  const [openingId, setOpeningId] = useState<string | null>(null);

  const breakSeal = useCallback(async (epistle: Epistle) => {
    if (openingId) return;
    setActionError(null);
    setBusyId(epistle.id);
    try {
      const opened = await onOpen(epistle.id);
      setOpeningId(epistle.id);
      setScreen({ kind: 'ceremony', epistle: opened });
      // The wax breaks, the flap lifts, the letter rises — then the paper takes over.
      window.setTimeout(() => {
        setScreen({ kind: 'read', epistle: opened });
        setOpeningId(null);
      }, CEREMONY_OPENING_MS);
    } catch (err) {
      handleError(err, 'The seal would not break. Try again in a moment.');
    } finally {
      setBusyId(null);
    }
  }, [onOpen, openingId, handleError]);

  // --- Taking a letter back ------------------------------------------------

  const recall = useCallback(async (epistle: Epistle) => {
    setActionError(null);
    setBusyId(epistle.id);
    try {
      const draft = await onRecall(epistle.id);
      setScreen({ kind: 'compose', draft, replyToId: null });
    } catch (err) {
      handleError(err, 'The letter could not be taken back.');
    } finally {
      setBusyId(null);
    }
  }, [onRecall, handleError]);

  const discard = useCallback(async (epistle: Epistle) => {
    setActionError(null);
    setBusyId(epistle.id);
    try {
      await onDiscard(epistle.id);
    } catch (err) {
      handleError(err, 'The draft could not be discarded.');
    } finally {
      setBusyId(null);
    }
  }, [onDiscard, handleError]);

  return (
    <div className="epistle-view" data-component="epistle-view" role="dialog" aria-label="Our letters">
      {screen.kind === 'mailbox' && (
        <MailboxScreen
          sections={sections}
          letters={letters}
          loading={loading}
          isEmpty={isEmpty}
          myName={myName}
          partnerName={partnerDisplay}
          todayKey={todayKey}
          busyId={busyId}
          error={error ?? actionError}
          userId={userId}
          tab={mailboxTab}
          onTabChange={setMailboxTab}
          onClearError={onClearError}
          onClose={onClose}
          onStartCompose={startCompose}
          onResumeDraft={(draft) => startCompose(draft, null)}
          onBreakSeal={breakSeal}
          onReadAgain={openLetter}
          onRecall={recall}
          onDiscard={discard}
        />
      )}

      {screen.kind === 'compose' && (() => {
        const replyId = screen.replyToId ?? screen.draft?.reply_to_id ?? null;
        return (
          <WritingDesk
            draft={screen.draft}
            initialReplyTo={replyId ? lettersById.get(replyId) ?? null : null}
            letters={letters}
            userId={userId}
            myName={myName}
            partnerName={partnerDisplay}
            myPlace={myPlace}
            todayKey={todayKey}
            onCreateDraft={onCreateDraft}
            onSaveDraft={onSaveDraft}
            onSeal={onSeal}
            onBack={() => { setActionError(null); setScreen({ kind: 'mailbox' }); }}
            onSealed={() => { setMailboxTab('sent'); setScreen({ kind: 'mailbox' }); }}
            onError={(message) => setActionError(message)}
          />
        );
      })()}

      {screen.kind === 'ceremony' && (
        <div className="epistle-reading">
          <div className="epistle-ceremony-stage" data-opening="true">
            <div
              className="epistle-stage-env"
              data-opening={openingId === screen.epistle.id ? 'true' : 'false'}
              role="status"
              aria-label={`The seal on ${partnerDisplay}'s letter is breaking`}
            >
              <EnvelopeArt
                className="ep-env"
                senderName={partnerDisplay}
                sealed
                wax="fresh"
              />
            </div>
            <p className="epistle-stage-caption">
              The wax breaks — <strong>{partnerDisplay}</strong> wrote to you
            </p>
          </div>
        </div>
      )}

      {screen.kind === 'read' && (
        <ReadingScreen
          epistle={screen.epistle}
          senderName={screen.epistle.sender_id === userId ? myName : partnerDisplay}
          dateline={datelineFor(screen.epistle.sender_id === userId ? myPlace : null, screen.epistle.created_at)}
          userId={userId}
          myName={myName}
          partnerName={partnerDisplay}
          letters={letters}
          onClose={() => { setActionError(null); setScreen({ kind: 'mailbox' }); }}
          onReply={replyToLetter}
          onOpenLetter={openLetter}
        />
      )}
    </div>
  );
};

/* ------------------------------------------------------------------------ */
/* The mailbox                                                               */
/* ------------------------------------------------------------------------ */

function MailboxScreen({
  sections,
  letters,
  loading,
  isEmpty,
  myName,
  partnerName,
  todayKey,
  busyId,
  error,
  userId,
  tab,
  onTabChange,
  onClearError,
  onClose,
  onStartCompose,
  onResumeDraft,
  onBreakSeal,
  onReadAgain,
  onRecall,
  onDiscard,
}: {
  sections: ReturnType<typeof sectionEpistles>;
  letters: Epistle[];
  loading: boolean;
  isEmpty: boolean;
  myName: string;
  partnerName: string;
  todayKey: string;
  busyId: string | null;
  error: string | null;
  userId: string;
  tab: MailboxTab;
  onTabChange: (tab: MailboxTab) => void;
  onClearError: () => void;
  onClose: () => void;
  onStartCompose: (draft: Epistle | null) => void;
  onResumeDraft: (draft: Epistle) => void;
  onBreakSeal: (epistle: Epistle) => void;
  onReadAgain: (epistle: Epistle) => void;
  onRecall: (epistle: Epistle) => void;
  onDiscard: (epistle: Epistle) => void;
}) {
  const lettersById = useMemo(() => new Map(letters.map((letter) => [letter.id, letter])), [letters]);
  const keepsakes = useMemo(() => splitKeepsakes(sections.keepsakes, userId), [sections.keepsakes, userId]);

  const hasAnything = sections.unopened.length + sections.waiting.length + sections.mine.length
    + sections.keepsakes.length + sections.drafts.length > 0;

  /** Where one letter stands in its correspondence, in a single quiet line. */
  const threadNoteFor = useCallback((epistle: Epistle): string | null => {
    const parent = replyParent(epistle, lettersById);
    if (parent) {
      const name = parent.title?.trim();
      return name ? `In reply to “${name}”` : 'In reply to an unnamed letter';
    }
    const answers = replyDescendants(epistle.id, letters);
    if (answers.length > 0) {
      return `${answers.length} ${answers.length === 1 ? 'reply' : 'replies'} in this correspondence`;
    }
    return null;
  }, [letters, lettersById]);

  const mineStateFor = useCallback((epistle: Epistle): EpistleState => (
    epistleState(epistle, todayKey)
  ), [todayKey]);

  const mineRibbonFor = useCallback((epistle: Epistle): string => (
    isEpistleOpenable(epistle, todayKey)
      ? `Waiting for ${partnerName} to open`
      : formatOpensIn(epistle.opens_at ?? '', todayKey)
  ), [partnerName, todayKey]);

  const mineLabelFor = useCallback((epistle: Epistle): string => {
    const title = epistle.title?.trim() ? `, “${epistle.title.trim()}”` : '';
    return isEpistleOpenable(epistle, todayKey)
      ? `Your letter to ${partnerName}${title} — read it again`
      : `Your letter to ${partnerName}${title} — sealed until ${formatEpistleDate(epistle.opens_at ?? '')}`;
  }, [partnerName, todayKey]);

  return (
    <>
      <header className="epistle-mailbox-head">
        <div>
          <h1 className="epistle-mailbox-title">Our letters</h1>
          <p className="epistle-mailbox-sub">
            Not messages — letters. Written slowly, sealed with wax, kept forever.
          </p>
        </div>
        <button type="button" className="epistle-close" aria-label="Close the letters" onClick={() => { onClearError(); onClose(); }}>
          <X size={17} />
        </button>
      </header>

      <div className="epistle-tabs" role="tablist" aria-label="Letter shelves">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'received' ? 'true' : 'false'}
          data-epistle-tab="received"
          className="epistle-tab"
          onClick={() => onTabChange('received')}
        >
          Received
          {sections.unopened.length > 0 && (
            <span className="epistle-tab-count" aria-label={`${sections.unopened.length} waiting to be opened`}>
              {sections.unopened.length}
            </span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'sent' ? 'true' : 'false'}
          data-epistle-tab="sent"
          className="epistle-tab"
          onClick={() => onTabChange('sent')}
        >
          Sent
          {sections.mine.length > 0 && (
            <span className="epistle-tab-count" aria-label={`${sections.mine.length} on their way`}>
              {sections.mine.length}
            </span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'drafts' ? 'true' : 'false'}
          data-epistle-tab="drafts"
          className="epistle-tab"
          onClick={() => onTabChange('drafts')}
        >
          Drafts
          {sections.drafts.length > 0 && (
            <span className="epistle-tab-count" aria-hidden="true">
              {sections.drafts.length}
            </span>
          )}
        </button>
      </div>

      <div className="epistle-mailbox" data-epistle-mailbox="true" data-epistle-active-tab={tab}>
        {error && <p className="epistle-error" role="alert" data-epistle-error="true">{error}</p>}

        {isEmpty && tab === 'received' && (
          <div className="epistle-empty" data-epistle-empty="true">
            <span className="epistle-empty-icon"><MailboxIcon size={26} /></span>
            <h3>The mailbox is empty</h3>
            <p>
              Somewhere between a message and a promise, there is a letter.
              Write the first one for {partnerName}.
            </p>
          </div>
        )}

        {tab === 'received' && !isEmpty && sections.unopened.length + sections.waiting.length + keepsakes.received.length === 0 && (
          <p className="epistle-tab-empty" data-epistle-tab-empty="received">
            No letters from {partnerName} yet — yours might be the one that starts it.
          </p>
        )}

        {tab === 'received' && sections.unopened.length > 0 && (
          <section data-epistle-section="unopened">
            <p className="epistle-section-label">Waiting for you</p>
            <div className="epistle-shelf">
              {sections.unopened.map((epistle) => (
                <EnvelopeCard
                  key={epistle.id}
                  epistle={epistle}
                  eyebrow={`From ${partnerName}`}
                  waxName={partnerName}
                  state="sealed-unopened"
                  ribbon="Tap to break the seal"
                  ribbonReady
                  threadNote={threadNoteFor(epistle)}
                  onActivate={() => onBreakSeal(epistle)}
                  activateLabel={epistleAriaLabel(epistle, partnerName, 'sealed-unopened')}
                />
              ))}
            </div>
          </section>
        )}

        {tab === 'received' && sections.waiting.length > 0 && (
          <section data-epistle-section="waiting">
            <p className="epistle-section-label is-muted">Sealed until their day</p>
            <div className="epistle-shelf">
              {sections.waiting.map((epistle) => (
                <EnvelopeCard
                  key={epistle.id}
                  epistle={epistle}
                  eyebrow={`From ${partnerName} — sealed until its day`}
                  eyebrowMuted
                  waxName={partnerName}
                  state="sealed-waiting"
                  ribbon={formatOpensIn(epistle.opens_at ?? '', todayKey)}
                  threadNote={threadNoteFor(epistle)}
                  onActivate={null}
                  activateLabel={epistleAriaLabel(epistle, partnerName, 'sealed-waiting')}
                />
              ))}
            </div>
          </section>
        )}

        {tab === 'received' && keepsakes.received.length > 0 && (
          <section data-epistle-section="received-kept">
            <p className="epistle-section-label is-muted">Read &amp; kept</p>
            <div className="epistle-shelf">
              {keepsakes.received.map((epistle) => (
                <EnvelopeCard
                  key={epistle.id}
                  epistle={epistle}
                  eyebrow={`From ${partnerName}`}
                  eyebrowMuted
                  waxName={partnerName}
                  state="opened"
                  ribbon={null}
                  threadNote={threadNoteFor(epistle)}
                  onActivate={() => onReadAgain(epistle)}
                  activateLabel={epistleAriaLabel(epistle, partnerName, 'opened')}
                />
              ))}
            </div>
          </section>
        )}

        {tab === 'sent' && sections.mine.length + keepsakes.sent.length === 0 && !loading && (
          <p className="epistle-tab-empty" data-epistle-tab-empty="sent">
            Nothing on its way — your sealed letters wait here until {partnerName} opens them.
          </p>
        )}

        {tab === 'sent' && sections.mine.length > 0 && (
          <section data-epistle-section="mine">
            <p className="epistle-section-label is-muted">On their way</p>
            <div className="epistle-shelf">
              {sections.mine.map((epistle) => (
                <div key={epistle.id} className="epistle-row is-sent-letter">
                  <div className="epistle-row-main">
                    <EnvelopeCard
                      epistle={epistle}
                      eyebrow={`To ${partnerName}`}
                      waxName={myName}
                      state={mineStateFor(epistle)}
                      ribbon={mineRibbonFor(epistle)}
                      threadNote={threadNoteFor(epistle)}
                      onActivate={() => onReadAgain(epistle)}
                      activateLabel={mineLabelFor(epistle)}
                    />
                  </div>
                  <div className="epistle-envelope-actions">
                    <button
                      type="button"
                      className="ep-mini-button"
                      disabled={busyId === epistle.id}
                      onClick={() => onReadAgain(epistle)}
                    >
                      <PenLine size={12} /> Read
                    </button>
                    <button
                      type="button"
                      className="ep-mini-button is-danger"
                      disabled={busyId === epistle.id}
                      aria-label={`Take the letter back before ${partnerName} opens it`}
                      onClick={() => onRecall(epistle)}
                    >
                      <Undo2 size={12} /> Take back
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {tab === 'sent' && keepsakes.sent.length > 0 && (
          <section data-epistle-section="sent-kept">
            <p className="epistle-section-label is-muted">Opened &amp; kept</p>
            <div className="epistle-shelf">
              {keepsakes.sent.map((epistle) => {
                const title = epistle.title?.trim() ? `, “${epistle.title.trim()}”` : '';
                return (
                  <EnvelopeCard
                    key={epistle.id}
                    epistle={epistle}
                    eyebrow={`To ${partnerName}`}
                    eyebrowMuted
                    waxName={myName}
                    state="opened"
                    ribbon={null}
                    threadNote={threadNoteFor(epistle)}
                    onActivate={() => onReadAgain(epistle)}
                    activateLabel={`Your letter to ${partnerName}${title} — read it again`}
                  />
                );
              })}
            </div>
          </section>
        )}

        {tab === 'drafts' && sections.drafts.length === 0 && !loading && (
          <p className="epistle-tab-empty" data-epistle-tab-empty="drafts">
            No unfinished letters — every thought so far has been sealed and sent.
          </p>
        )}

        {tab === 'drafts' && sections.drafts.length > 0 && (
          <section data-epistle-section="drafts">
            <p className="epistle-section-label is-muted">Still being written</p>
            <div className="epistle-shelf">
              {sections.drafts.map((epistle) => (
                <div key={epistle.id} className="epistle-row">
                  <button
                    type="button"
                    className="epistle-draft-card"
                    data-epistle-card={epistle.id}
                    data-epistle-state="draft"
                    style={{ flex: 1, minWidth: 0 }}
                    onClick={() => onResumeDraft(epistle)}
                    aria-label={epistleAriaLabel(epistle, 'you', 'draft')}
                  >
                    <span className="epistle-draft-pencil"><Feather size={16} /></span>
                    <span className="epistle-draft-body">
                      <h4>{epistle.title?.trim() || 'An unnamed letter'}</h4>
                      <p>{countWords(epistle.body)} words so far · saved {formatEpistleDate(epistle.updated_at)}</p>
                      {epistle.reply_to_id && lettersById.get(epistle.reply_to_id)?.title?.trim() && (
                        <p className="epistle-draft-reply">In reply to “{lettersById.get(epistle.reply_to_id)?.title?.trim()}”</p>
                      )}
                    </span>
                  </button>
                  <div className="epistle-envelope-actions">
                    <button
                      type="button"
                      className="ep-mini-button"
                      disabled={busyId === epistle.id}
                      aria-label={`Discard the draft ${epistle.title?.trim() || ''}`}
                      onClick={() => onDiscard(epistle)}
                    >
                      <Trash2 size={12} /> Discard
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {loading && !hasAnything && (
          <p className="epistle-mailbox-sub" style={{ textAlign: 'center', padding: '20px 0' }}>
            Opening the mailbox…
          </p>
        )}
      </div>

      <footer
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          padding: '14px 18px calc(16px + env(safe-area-inset-bottom, 0px))',
          display: 'flex',
          justifyContent: 'center',
          background: 'linear-gradient(180deg, rgba(248,242,230,0) 0%, #f4ecdd 34%)',
        }}
      >
        <button
          type="button"
          className="epistle-seal-button"
          data-epistle-write="true"
          onClick={() => onStartCompose(null)}
        >
          <Feather size={16} /> Write a letter
        </button>
      </footer>
    </>
  );
}

/* ------------------------------------------------------------------------ */
/* The writing desk                                                          */
/* ------------------------------------------------------------------------ */

function WritingDesk({
  draft,
  initialReplyTo,
  letters,
  userId,
  myName,
  partnerName,
  myPlace,
  todayKey,
  onCreateDraft,
  onSaveDraft,
  onSeal,
  onBack,
  onSealed,
  onError,
}: {
  draft: Epistle | null;
  /** The answered letter, when this letter is (or resumes) a reply. */
  initialReplyTo: Epistle | null;
  /** Every letter this phone may see, so the answered one stays fresh. */
  letters: Epistle[];
  userId: string;
  myName: string;
  partnerName: string;
  myPlace: string | null;
  todayKey: string;
  onCreateDraft: (title: string, body: string, replyToId?: string | null) => Promise<Epistle>;
  onSaveDraft: (id: string, title: string, body: string, replyToId?: string | null) => Promise<Epistle>;
  onSeal: (id: string, opensAt: string | null) => Promise<Epistle>;
  onBack: () => void;
  onSealed: () => void;
  onError: (message: string) => void;
}) {
  const lettersById = useMemo(() => new Map(letters.map((letter) => [letter.id, letter])), [letters]);

  const [draftId, setDraftId] = useState<string | null>(draft?.id ?? null);
  const [title, setTitle] = useState(draft?.title ?? (initialReplyTo ? replySubject(initialReplyTo.title) : ''));
  const [body, setBody] = useState(draft?.body ?? '');
  const [replyToId, setReplyToId] = useState<string | null>(initialReplyTo?.id ?? draft?.reply_to_id ?? null);
  const [saveLine, setSaveLine] = useState('');
  const [sealing, setSealing] = useState<null | {
    step: SealingStep;
    opensAt: string | null;
    timing: 'now' | 'day';
    pressed: boolean;
    busy: boolean;
  }>(null);

  // The answered letter, looked up fresh: the mailbox may have learned more about
  // it since the desk opened. A link whose letter is gone answers nothing.
  const replyTo = replyToId ? lettersById.get(replyToId) ?? null : null;
  const replyToName = replyTo ? (replyTo.sender_id === userId ? myName : partnerName) : '';

  const bodyRef = useRef(body);
  const titleRef = useRef(title);
  const idRef = useRef(draftId);
  const replyRef = useRef<string | null>(replyTo ? replyToId : null);
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const savingRef = useRef<Promise<unknown> | null>(null);
  const bodyFieldRef = useRef<HTMLTextAreaElement | null>(null);

  // The desk opens with the pen on the paper, the way a letter starts — exactly
  // once. (Focusing on every render used to drag the cursor out of the name field
  // with each keystroke, which made naming a letter impossible.)
  useEffect(() => {
    bodyFieldRef.current?.focus({ preventScroll: true });
  }, []);

  // The pens the autosave writes with mirror the sheet, not the render.
  useEffect(() => { bodyRef.current = body; }, [body]);
  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => { idRef.current = draftId; }, [draftId]);
  useEffect(() => { replyRef.current = replyTo ? replyToId : null; }, [replyTo, replyToId]);

  const persist = useCallback(async () => {
    const cleanTitle = titleRef.current.trim().slice(0, 80);
    const cleanBody = bodyRef.current.trim();
    if (!cleanBody) return;
    setSaveLine('Saving…');
    const work = idRef.current
      ? () => onSaveDraft(idRef.current as string, cleanTitle, cleanBody, replyRef.current)
      : () => onCreateDraft(cleanTitle, cleanBody, replyRef.current);
    savingRef.current = work()
      .then((row) => {
        idRef.current = row.id;
        setDraftId(row.id);
        dirtyRef.current = false;
        setSaveLine('Saved');
      })
      .catch((err: unknown) => {
        setSaveLine('');
        onError(err instanceof Error ? err.message : 'The draft could not be saved.');
      })
      .finally(() => { savingRef.current = null; });
    await savingRef.current;
  }, [onCreateDraft, onSaveDraft, onError]);

  // Autosave: a letter is too heavy to lose to a closed app.
  useEffect(() => {
    if (!body.trim()) return;
    dirtyRef.current = true;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { void persist(); }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [title, body, replyToId, persist]);

  // Leaving the desk mid-save: one last save, best effort.
  useEffect(() => () => {
    if (dirtyRef.current && bodyRef.current.trim()) void persist();
  }, [persist]);

  const words = countWords(body);
  const canSeal = body.trim().length > 0;

  const pressSeal = async () => {
    if (!sealing) return;
    let id = idRef.current;
    if (!id) {
      // A letter so fresh the autosave has not landed yet: save it first, seal second.
      await persist();
      id = idRef.current;
    }
    if (!id) {
      onError('The letter could not be saved before sealing.');
      return;
    }
    setSealing({ ...sealing, pressed: true, busy: true });
    // The stamp lands before the database hears about it: the moment should feel
    // physical first, administrative second.
    window.setTimeout(async () => {
      try {
        await onSeal(id as string, sealing.timing === 'day' ? sealing.opensAt : null);
        setSealing((current) => (current ? { ...current, step: 'sealed', busy: false } : current));
      } catch (err) {
        setSealing((current) => (current ? { ...current, pressed: false, busy: false } : current));
        onError(err instanceof Error ? err.message : 'The letter could not be sealed.');
      }
    }, 700);
  };

  const dateline = useMemo(() => datelineFor(myPlace, todayKey), [myPlace, todayKey]);

  return (
    <>
      <div className="epistle-desk" data-epistle-desk="true">
        <div className="epistle-desk-top">
          <button type="button" className="epistle-close" style={{ width: 30, height: 30 }} aria-label="Back to the mailbox" onClick={() => { if (sealing) setSealing(null); else onBack(); }}>
            <ChevronLeft size={16} />
          </button>
          <span className="epistle-desk-mode">Writing to {partnerName}</span>
          <span className="epistle-save-line" data-epistle-save-line="true">{saveLine}</span>
        </div>

        {replyTo && (
          <div className="epistle-reply-banner" data-epistle-reply-banner="true">
            <span className="epistle-reply-banner-icon" aria-hidden="true"><Reply size={15} /></span>
            <span className="epistle-reply-banner-text">
              <h4>Replying to {replyToName}’s {replyTo.title?.trim() ? `“${replyTo.title.trim()}”` : 'letter'}</h4>
              <p>{letterExcerpt(replyTo.body)}</p>
            </span>
            <button
              type="button"
              className="epistle-reply-banner-remove"
              onClick={() => setReplyToId(null)}
              aria-label="Write this as a new letter instead of a reply"
            >
              New letter instead
            </button>
          </div>
        )}

        <div className="epistle-paper">
          <p className="epistle-dateline">{dateline}</p>
          <input
            className="epistle-title-input"
            data-epistle-title="true"
            value={title}
            maxLength={80}
            placeholder="Give it a name — or leave it unnamed"
            aria-label="The letter's name (optional)"
            onChange={(event) => setTitle(event.target.value)}
          />
          <textarea
            ref={bodyFieldRef}
            className="epistle-body-input"
            data-epistle-body="true"
            value={body}
            maxLength={EPISTLE_BODY_LIMIT}
            placeholder={`My dearest ${partnerName}…`}
            aria-label="The letter itself"
            onChange={(event) => setBody(event.target.value)}
          />
        </div>

        <div className="epistle-desk-bar">
          <span className="epistle-word-count" data-epistle-words="true">
            {words === 1 ? '1 word' : `${words} words`}
          </span>
          <button
            type="button"
            className="epistle-seal-button"
            data-epistle-seal-start="true"
            disabled={!canSeal}
            onClick={() => setSealing({ step: 'review', opensAt: null, timing: 'now', pressed: false, busy: false })}
          >
            Seal it
          </button>
        </div>
      </div>

      {sealing && (
        <SealingCeremony
          step={sealing.step}
          title={title}
          body={body}
          dateline={dateline}
          myName={myName}
          partnerName={partnerName}
          todayKey={todayKey}
          timing={sealing.timing}
          opensAt={sealing.opensAt}
          pressed={sealing.pressed}
          busy={sealing.busy}
          replyTo={replyTo}
          replyToName={replyToName}
          onChangeTiming={(timing, opensAt) => setSealing((current) => (current ? { ...current, timing, opensAt } : current))}
          onStep={(step) => setSealing((current) => (current ? { ...current, step } : current))}
          onPress={pressSeal}
          onCancel={() => setSealing(null)}
          onDone={onSealed}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------------ */
/* The sealing ceremony                                                      */
/* ------------------------------------------------------------------------ */

function SealingCeremony({
  step,
  title,
  body,
  dateline,
  myName,
  partnerName,
  todayKey,
  timing,
  opensAt,
  pressed,
  busy,
  replyTo,
  replyToName,
  onChangeTiming,
  onStep,
  onPress,
  onCancel,
  onDone,
}: {
  step: SealingStep;
  title: string;
  body: string;
  dateline: string;
  myName: string;
  partnerName: string;
  todayKey: string;
  timing: 'now' | 'day';
  opensAt: string | null;
  pressed: boolean;
  busy: boolean;
  replyTo: Epistle | null;
  replyToName: string;
  onChangeTiming: (timing: 'now' | 'day', opensAt: string | null) => void;
  onStep: (step: SealingStep) => void;
  onPress: () => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const preview = useMemo(() => ({
    id: 'preview',
    title: title.trim() || null,
    body,
    sealed_at: null,
    opened_at: null,
  }), [title, body]);

  const stepLabel = step === 'review' ? 'Before sealing' : step === 'when' ? 'The open day' : 'The seal';
  const dayWords = opensAt ? formatOpensIn(opensAt, todayKey) : null;
  const replyContext = replyTo
    ? (replyTo.title?.trim()
      ? `In reply to ${replyToName}’s “${replyTo.title.trim()}”`
      : `In reply to ${replyToName}’s letter`)
    : null;

  return (
    <div className="epistle-ceremony" data-epistle-sealing="true" data-sealing-step={step}>
      <div className="epistle-ceremony-top">
        <span className="epistle-ceremony-step">{stepLabel}</span>
        <button type="button" className="epistle-close" style={{ width: 30, height: 30 }} aria-label="Return to the letter" onClick={onCancel}>
          <X size={15} />
        </button>
      </div>

      {step === 'review' && (
        <>
          <div className="epistle-ceremony-body">
            <h2 className="epistle-ceremony-heading">Read it once more.</h2>
            <p className="epistle-ceremony-note">
              A letter is given, not sent. This is exactly how {partnerName} will see it.
            </p>
            <LetterPaper letter={preview} senderName={myName} dateline={dateline} showSealLine={false} replyContext={replyContext} className="epistle-ceremony-paper" />
          </div>
          <div className="epistle-ceremony-foot">
            <button type="button" className="epistle-ghost-button" onClick={onCancel}>Keep writing</button>
            <button type="button" className="epistle-primary-button" data-epistle-seal-review="true" onClick={() => onStep('when')}>
              Continue
            </button>
          </div>
        </>
      )}

      {step === 'when' && (
        <>
          <div className="epistle-ceremony-body">
            <h2 className="epistle-ceremony-heading">When may it be opened?</h2>
            <p className="epistle-ceremony-note">
              It stands in {partnerName}'s mailbox the moment it is sealed. You choose when the wax lets them in.
            </p>
            <button
              type="button"
              className="epistle-choice"
              data-epistle-timing="now"
              data-chosen={timing === 'now' ? 'true' : 'false'}
              onClick={() => onChangeTiming('now', null)}
            >
              <span className="epistle-choice-radio" aria-hidden="true" />
              <span className="epistle-choice-text">
                <h4>As soon as they like</h4>
                <p>The wax waits for their hands, nothing more.</p>
              </span>
            </button>
            <button
              type="button"
              className="epistle-choice"
              data-epistle-timing="day"
              data-chosen={timing === 'day' ? 'true' : 'false'}
              onClick={() => onChangeTiming('day', opensAt ?? todayKey)}
            >
              <span className="epistle-choice-radio" aria-hidden="true" />
              <span className="epistle-choice-text">
                <h4>On a day I choose</h4>
                <p>An anniversary, a birthday, an ordinary Tuesday. It waits, sealed, until then.</p>
              </span>
            </button>
            {timing === 'day' && (
              <div className="epistle-date-field" data-epistle-date-field="true">
                <label htmlFor="epistle-opens-at">The day the seal may break</label>
                <input
                  id="epistle-opens-at"
                  className="epistle-date-input"
                  type="date"
                  value={opensAt ?? todayKey}
                  min={todayKey}
                  onChange={(event) => onChangeTiming('day', event.target.value || todayKey)}
                />
              </div>
            )}
          </div>
          <div className="epistle-ceremony-foot">
            <button type="button" className="epistle-ghost-button" onClick={() => onStep('review')}>Back</button>
            <button
              type="button"
              className="epistle-primary-button"
              data-epistle-seal-when="true"
              disabled={timing === 'day' && !opensAt}
              onClick={() => onStep('press')}
            >
              {timing === 'day' && opensAt ? `Seal it until ${formatEpistleDate(opensAt)}` : 'Continue'}
            </button>
          </div>
        </>
      )}

      {step === 'press' && (
        <>
          <div className="epistle-ceremony-body">
            <div className="epistle-stamp-stage" data-epistle-stamp-stage="true">
              <span className="epistle-seal-ring">
                <button
                  type="button"
                  className={`epistle-stamp${pressed ? ' is-pressed' : ''}`}
                  data-epistle-stamp="true"
                  disabled={busy}
                  aria-label="Press the wax seal and send the letter"
                  onClick={onPress}
                >
                  <span>{waxInitial(myName)}</span>
                </button>
              </span>
              <h2 className="epistle-ceremony-heading" style={{ textAlign: 'center' }}>
                {pressed ? 'The wax is setting…' : 'Press the seal.'}
              </h2>
              <p className="epistle-ceremony-note" style={{ textAlign: 'center', maxWidth: '30ch' }}>
                {pressed
                  ? 'Hold still — a letter takes a moment to become theirs.'
                  : `Take a breath. From this moment the letter belongs to ${partnerName}.`}
              </p>
            </div>
          </div>
          <div className="epistle-ceremony-foot">
            <button type="button" className="epistle-ghost-button" disabled={busy} onClick={() => onStep('when')}>Back</button>
          </div>
        </>
      )}

      {step === 'sealed' && (
        <div className="epistle-ceremony-body" style={{ justifyContent: 'center', alignItems: 'center', display: 'flex' }}>
          <div className="epistle-sealed-note" data-epistle-sealed="true">
            <span className="epistle-sealed-env">
              <EnvelopeArt senderName={myName} sealed wax="fresh" className="ep-env" />
            </span>
            <h3>Sealed.</h3>
            <p>
              {opensAt
                ? `It stands in ${partnerName}'s mailbox now — but the wax keeps it until ${dayWords?.toLowerCase() ?? formatEpistleDate(opensAt)}. Until then it is a secret between you and the wax.`
                : `It stands in ${partnerName}'s mailbox now, flap down, wax intact. Whenever they come, it is ready.`}
            </p>
            <p style={{ marginTop: 14 }}>
              <button type="button" className="epistle-primary-button" data-epistle-seal-done="true" onClick={onDone}>
                Back to the mailbox
              </button>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* The reading                                                               */
/* ------------------------------------------------------------------------ */

function ReadingScreen({
  epistle,
  senderName,
  dateline,
  userId,
  myName,
  partnerName,
  letters,
  onClose,
  onReply,
  onOpenLetter,
}: {
  epistle: Epistle;
  senderName: string;
  dateline: string | null;
  userId: string;
  myName: string;
  partnerName: string;
  letters: Epistle[];
  onClose: () => void;
  onReply: (epistle: Epistle) => void;
  onOpenLetter: (epistle: Epistle) => void;
}) {
  const wasJustOpened = Boolean(epistle.opened_at
    && epistle.sealed_at
    && new Date(epistle.opened_at).getTime() - new Date(epistle.sealed_at).getTime() < 60_000);

  const lettersById = useMemo(() => new Map(letters.map((letter) => [letter.id, letter])), [letters]);
  const parent = replyParent(epistle, lettersById);
  const ancestors = useMemo(() => replyAncestors(epistle, lettersById), [epistle, lettersById]);
  const descendants = useMemo(() => replyDescendants(epistle.id, letters), [epistle.id, letters]);
  const size = threadSize(epistle, letters, lettersById);
  const who = useCallback((letter: Epistle) => (letter.sender_id === userId ? myName : partnerName), [userId, myName, partnerName]);

  // The newest answer whose words may already be shown; an answer still sealed is
  // somebody's mailbox surprise, not a page to turn to from here.
  const readableAnswer = descendants.find((letter) => isEpistleReadable(letter, userId)) ?? null;

  const parentLabel = parent
    ? (parent.title?.trim()
      ? `In reply to ${who(parent)}’s “${parent.title.trim()}”`
      : `In reply to ${who(parent)}’s letter`)
    : null;
  const parentReadable = parent ? isEpistleReadable(parent, userId) : false;

  return (
    <div className="epistle-reading" data-epistle-reading="true">
      <div className="epistle-desk-top" style={{ padding: '12px 18px 10px' }}>
        <button type="button" className="epistle-close" style={{ width: 30, height: 30 }} aria-label="Back to the mailbox" onClick={onClose}>
          <ChevronLeft size={16} />
        </button>
        <span className="epistle-desk-mode">A letter from {senderName}</span>
        <span style={{ width: 30 }} aria-hidden="true" />
      </div>

      <div className="epistle-reading-body">
        {parent && parentLabel && (parentReadable ? (
          <button
            type="button"
            className="epistle-reading-reply"
            data-epistle-in-reply-to="true"
            onClick={() => onOpenLetter(parent)}
            aria-label={`${parentLabel} — read it`}
          >
            <Reply size={13} aria-hidden="true" />
            <span>{parentLabel}</span>
          </button>
        ) : (
          <p className="epistle-reading-reply is-static">
            <Reply size={13} aria-hidden="true" />
            <span>{parentLabel} — still sealed</span>
          </p>
        ))}

        {ancestors.length > 0 && (
          <section className="epistle-thread" data-epistle-thread="true" aria-label="The correspondence so far">
            <p className="epistle-section-label is-muted">
              The correspondence so far · letter {ancestors.length + 1} of {size}
            </p>
            <div className="epistle-shelf">
              {ancestors.map((letter, index) => {
                const readable = isEpistleReadable(letter, userId);
                const item = (
                  <>
                    <span className="epistle-thread-num" aria-hidden="true">{index + 1}</span>
                    <span className="epistle-thread-text">
                      <h4>{letter.title?.trim() || 'An unnamed letter'}</h4>
                      <p>{letterExcerpt(letter.body)}</p>
                      <span className="epistle-thread-meta">
                        {who(letter)} · {formatEpistleDate(letter.sealed_at ?? letter.created_at)}
                        {!readable && ' · still sealed'}
                      </span>
                    </span>
                  </>
                );
                return readable ? (
                  <button
                    key={letter.id}
                    type="button"
                    className="epistle-thread-item"
                    data-epistle-thread-letter={letter.id}
                    onClick={() => onOpenLetter(letter)}
                    aria-label={`Read ${who(letter)}’s letter ${letter.title?.trim() ? `“${letter.title.trim()}”` : ''}`}
                  >
                    {item}
                  </button>
                ) : (
                  <div key={letter.id} className="epistle-thread-item is-static" aria-label={`${who(letter)}’s letter — still sealed`}>
                    {item}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <LetterPaper
          letter={epistle}
          senderName={senderName}
          dateline={dateline}
          animate={wasJustOpened}
        />

        {readableAnswerNotice(descendants, readableAnswer, onOpenLetter)}
      </div>

      <div className="epistle-letter-foot">
        <span className="epistle-letter-meta">
          {epistle.opens_at
            ? `It waited until ${formatEpistleDate(epistle.opens_at)}.`
            : 'Kept in your mailbox forever.'}
          {size > 1 && ` Letter ${ancestors.length + 1} of ${size}.`}
        </span>
        <div className="epistle-letter-actions">
          <button type="button" className="epistle-ghost-button" data-epistle-keep="true" onClick={onClose}>
            Keep it
          </button>
          <button type="button" className="epistle-seal-button" data-epistle-reply="true" onClick={() => onReply(epistle)}>
            <Reply size={15} /> Reply
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What followed the letter: the newest answer already readable, one tap away — or,
 * when the only answers are still sealed surprises, a quiet word that the mailbox
 * holds them.
 */
function readableAnswerNotice(
  descendants: Epistle[],
  readableAnswer: Epistle | null,
  onOpenLetter: (epistle: Epistle) => void,
): React.ReactNode {
  if (descendants.length === 0) return null;
  if (readableAnswer) {
    const title = readableAnswer.title?.trim() ? ` “${readableAnswer.title.trim()}”` : '';
    return (
      <div className="epistle-answers-note">
        <button
          type="button"
          className="epistle-answers-link"
          data-epistle-latest-answer="true"
          onClick={() => onOpenLetter(readableAnswer)}
          aria-label={descendants.length === 1
            ? `One answer followed this letter${title} — read it`
            : `${descendants.length} answers followed this letter — read the latest${title}`}
        >
          <Reply size={13} aria-hidden="true" />
          {descendants.length === 1
            ? <span>One answer followed — read it</span>
            : <span>{descendants.length} answers followed — read the latest</span>}
        </button>
      </div>
    );
  }
  return (
    <p className="epistle-answers-note is-static">
      {descendants.length === 1 ? 'An answer is waiting in your mailbox.' : 'Answers are waiting in your mailbox.'}
    </p>
  );
}

export default EpistleView;

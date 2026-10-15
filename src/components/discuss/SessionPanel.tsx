import React, { useMemo, useState } from 'react';
import { ArrowLeft, Eye, Lock, Pencil } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import {
  ANSWER_REACTIONS,
  REACTION_COMMENT_MAX_LENGTH,
  categoryDisplay,
  emptyAnswer,
  isAnswerEmpty,
  parseAnswerValue,
  reactionDisplay,
  validateAnswer,
} from '../../lib/questionFormat';
import { AnswerInput } from './AnswerInput';
import type { SessionDetail } from '../../hooks/useDiscuss';
import type { AnswerReaction, AnswerValue, Question, ReactionKind } from '../../types/database';

interface SessionPanelProps {
  detail: SessionDetail;
  userId: string;
  userName: string;
  partnerName: string;
  busy: boolean;
  onBack: () => void;
  onSubmit: (value: AnswerValue) => Promise<void>;
  onRevise: (answerId: string, value: AnswerValue) => Promise<void>;
  onReact: (reaction: ReactionKind, comment: string | null) => Promise<void>;
}

const primaryButtonStyle = (disabled: boolean, background: string = tokens.colors.accentSageDeep): React.CSSProperties => ({
  padding: '13px',
  borderRadius: tokens.radii.pill,
  border: 'none',
  backgroundColor: background,
  color: tokens.colors.textWhite,
  fontSize: '0.9rem',
  fontWeight: 800,
  fontFamily: tokens.typography.fontFamily,
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.6 : 1,
  width: '100%',
});

const ghostButtonStyle: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: tokens.radii.pill,
  border: `1.5px solid ${tokens.colors.borderSoft}`,
  backgroundColor: tokens.colors.bgSurface,
  color: tokens.colors.textSecondary,
  fontSize: '0.8rem',
  fontWeight: 700,
  fontFamily: tokens.typography.fontFamily,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
};

/** How one stored answer reads on screen, for every input type. */
const AnswerBody: React.FC<{ question: Question; value: AnswerValue }> = ({ question, value }) => {
  const parsed = parseAnswerValue(value, question.input_type);

  if (question.input_type === 'slider') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '4px' }}>
        <span style={{ fontSize: '1.8rem', fontWeight: 800, color: tokens.colors.accentSageDeep, lineHeight: 1 }}>
          {typeof parsed === 'number' ? parsed : '–'}
        </span>
        <span style={{ fontSize: '0.74rem', color: tokens.colors.textMuted, fontWeight: 700 }}>/ 10</span>
      </span>
    );
  }

  if (question.input_type === 'ranking' && Array.isArray(parsed)) {
    return (
      <ol role="list" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {parsed.map((label, index) => (
          <li key={`${label}-${index}`} style={{ display: 'flex', gap: '6px', fontSize: '0.8rem', color: tokens.colors.textPrimary }}>
            <span style={{ fontWeight: 800, color: tokens.colors.textMuted }}>{`${index + 1}.`}</span>
            <span>{label}</span>
          </li>
        ))}
      </ol>
    );
  }

  if (Array.isArray(parsed)) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
        {parsed.map((label) => (
          <span
            key={label}
            style={{
              padding: '4px 10px',
              borderRadius: tokens.radii.pill,
              backgroundColor: tokens.colors.accentSageSoft,
              color: tokens.colors.accentSageDeep,
              fontSize: '0.74rem',
              fontWeight: 700,
            }}
          >
            {label}
          </span>
        ))}
      </div>
    );
  }

  return (
    <p style={{ margin: 0, fontSize: '0.84rem', lineHeight: 1.5, color: tokens.colors.textPrimary, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {String(parsed ?? '')}
    </p>
  );
};

/**
 * The writing screen. It owns one draft and validates it the way the database will, so a
 * mistake is explained on the phone instead of arriving as a server refusal.
 *
 * It is remounted (by `key`) whenever a different session or a saved answer goes into it,
 * which is what keeps the draft from one question out of the next.
 */
const AnswerComposer: React.FC<{
  question: Question;
  initial: AnswerValue;
  submitLabel: string;
  busy: boolean;
  hint: string | null;
  onSubmit: (value: AnswerValue) => Promise<void>;
}> = ({ question, initial, submitLabel, busy, hint, onSubmit }) => {
  const [draft, setDraft] = useState<AnswerValue>(initial);
  const [formError, setFormError] = useState<string | null>(null);
  const empty = isAnswerEmpty(draft);

  const send = async () => {
    setFormError(null);
    let value: AnswerValue;
    try {
      value = validateAnswer(draft, question);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'That answer is not ready yet.');
      return;
    }
    try {
      await onSubmit(value);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'That answer could not be saved.');
    }
  };

  return (
    <div data-session-screen="composer" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {hint && (
        <p
          data-partner-waiting
          style={{
            margin: 0,
            padding: '10px 12px',
            borderRadius: tokens.radii.md,
            backgroundColor: tokens.colors.primaryPinkSoft,
            color: tokens.colors.primaryPinkDeep,
            fontSize: '0.76rem',
            fontWeight: 700,
            lineHeight: 1.45,
          }}
        >
          {hint}
        </p>
      )}
      <AnswerInput question={question} value={draft} onChange={setDraft} disabled={busy} />
      {formError && (
        <p role="alert" data-answer-error style={{ margin: 0, fontSize: '0.78rem', color: '#DC2626', fontWeight: 700 }}>
          {formError}
        </p>
      )}
      <button
        type="button"
        aria-label={submitLabel}
        disabled={busy || empty}
        onClick={() => void send()}
        style={primaryButtonStyle(busy || empty)}
      >
        {submitLabel}
      </button>
    </div>
  );
};

/**
 * After the reveal: an emoji and an optional comment, one per partner.
 *
 * Which emoji is selected is read from the stored reaction rather than kept locally, so
 * the picker can never disagree with the database — only the comment being typed is a
 * draft.
 */
const ReactionPicker: React.FC<{
  myReaction: AnswerReaction | null;
  partnerReaction: AnswerReaction | null;
  partnerName: string;
  busy: boolean;
  onReact: (reaction: ReactionKind, comment: string | null) => Promise<void>;
}> = ({ myReaction, partnerReaction, partnerName, busy, onReact }) => {
  const [comment, setComment] = useState(myReaction?.comment ?? '');
  const reaction = myReaction?.reaction ?? null;
  const commentUnchanged = comment.trim() === (myReaction?.comment ?? '');

  const send = async (kind: ReactionKind) => {
    try {
      await onReact(kind, comment.trim() || null);
    } catch {
      // The screen above already explains why; the picker stays where it was.
    }
  };

  return (
    <div data-reactions style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <span style={{ fontSize: '0.8rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
        How did that land?
      </span>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {ANSWER_REACTIONS.map((entry) => {
          const isSelected = reaction === entry.kind;
          return (
            <button
              key={entry.kind}
              type="button"
              aria-label={entry.label}
              aria-pressed={isSelected}
              data-reaction={entry.kind}
              data-selected={isSelected ? 'true' : 'false'}
              disabled={busy}
              onClick={() => void send(entry.kind)}
              style={{
                flex: '1 1 auto',
                minWidth: '48px',
                padding: '8px 6px',
                borderRadius: tokens.radii.md,
                border: `1.5px solid ${isSelected ? tokens.colors.accentSageDeep : tokens.colors.borderSubtle}`,
                backgroundColor: isSelected ? tokens.colors.accentSageSoft : tokens.colors.bgSurface,
                cursor: busy ? 'not-allowed' : 'pointer',
                fontSize: '1.15rem',
                lineHeight: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '3px',
                fontFamily: tokens.typography.fontFamily,
              }}
            >
              <span aria-hidden="true">{entry.emoji}</span>
              <span style={{ fontSize: '0.6rem', fontWeight: 700, color: tokens.colors.textSecondary }}>
                {entry.label}
              </span>
            </button>
          );
        })}
      </div>

      <textarea
        aria-label="Add a comment"
        value={comment}
        disabled={busy || !reaction}
        placeholder={reaction ? 'Say something about it (optional)…' : 'Pick a reaction first'}
        onChange={(event) => setComment(event.target.value.slice(0, REACTION_COMMENT_MAX_LENGTH))}
        rows={2}
        style={{
          width: '100%',
          padding: '12px 14px',
          borderRadius: tokens.radii.md,
          border: `1.5px solid ${tokens.colors.borderSubtle}`,
          backgroundColor: tokens.colors.bgSurface,
          fontSize: '0.84rem',
          fontFamily: tokens.typography.fontFamily,
          color: tokens.colors.textPrimary,
          resize: 'vertical',
          outline: 'none',
        }}
      />
      <button
        type="button"
        aria-label="Save comment"
        disabled={busy || !reaction || commentUnchanged}
        onClick={() => reaction && void send(reaction)}
        style={primaryButtonStyle(busy || !reaction || commentUnchanged, tokens.colors.primaryPinkDeep)}
      >
        Save comment
      </button>

      {partnerReaction && (
        <div
          data-partner-reaction
          style={{
            padding: '10px 12px',
            borderRadius: tokens.radii.md,
            backgroundColor: tokens.colors.bgSurfaceSubtle,
            border: `1px solid ${tokens.colors.borderSubtle}`,
            fontSize: '0.78rem',
            color: tokens.colors.textSecondary,
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
          }}
        >
          <span aria-hidden="true" style={{ fontSize: '1.05rem' }}>
            {reactionDisplay(partnerReaction.reaction).emoji}
          </span>
          <span>
            <strong style={{ color: tokens.colors.textPrimary }}>{partnerName}</strong>
            {` reacted ${reactionDisplay(partnerReaction.reaction).label.toLowerCase()}`}
            {partnerReaction.comment ? ` — “${partnerReaction.comment}”` : ''}
          </span>
        </div>
      )}
    </div>
  );
};

/**
 * One asked question, in whichever of its three states this phone is in: writing an
 * answer, waiting with that answer sealed, or looking at both answers after the reveal.
 *
 * The panel never decides whether the partner's answer may be shown. It renders the rows
 * the database sent, and the database only sends the partner's row once both of you have
 * answered — see the "Couple members can view answers" policy in
 * supabase/migrations/202610150004_discuss_questions.sql.
 */
export const SessionPanel: React.FC<SessionPanelProps> = ({
  detail,
  userId,
  userName,
  partnerName,
  busy,
  onBack,
  onSubmit,
  onRevise,
  onReact,
}) => {
  const { session, question, myAnswer, partnerAnswer, partnerHasAnswered, revealed } = detail;
  // Set by the Edit button only: a fresh answer writes, a saved one revises.
  const [editing, setEditing] = useState(!myAnswer);

  const display = question ? categoryDisplay(question.category) : null;
  const myReaction = useMemo(
    () => detail.reactions.find((entry) => entry.user_id === userId) ?? null,
    [detail.reactions, userId],
  );
  const partnerReaction = useMemo(
    () => detail.reactions.find((entry) => entry.user_id !== userId) ?? null,
    [detail.reactions, userId],
  );

  const back = (
    <button type="button" aria-label="Back to categories" onClick={onBack} style={{ ...ghostButtonStyle, alignSelf: 'flex-start' }}>
      <ArrowLeft size={14} aria-hidden="true" />
      <span>Categories</span>
    </button>
  );

  if (!question) {
    return (
      <div data-session-screen="missing" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {back}
        <p style={{ fontSize: '0.84rem', color: tokens.colors.textSecondary }}>
          That question is no longer in your library, so its answers went with it.
        </p>
      </div>
    );
  }

  const showComposer = editing || (!revealed && !myAnswer);

  return (
    <div data-discuss-session style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {back}

      <div
        style={{
          backgroundColor: tokens.colors.bgSurface,
          borderRadius: tokens.radii.card,
          padding: '20px 18px',
          boxShadow: tokens.shadows.card,
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
        }}
      >
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                padding: '5px 12px',
                borderRadius: tokens.radii.pill,
                backgroundColor: display?.accentSoft,
                color: display?.accent,
                fontSize: '0.7rem',
                fontWeight: 800,
              }}
            >
              <span aria-hidden="true">{display?.emoji}</span>
              <span>{display?.name}</span>
            </span>
            <span
              style={{
                padding: '5px 12px',
                borderRadius: tokens.radii.pill,
                backgroundColor: tokens.colors.bgSurfaceSubtle,
                color: tokens.colors.textSecondary,
                fontSize: '0.7rem',
                fontWeight: 800,
              }}
            >
              {`Level ${question.seriousness}`}
            </span>
          </div>
          <p
            data-question-text
            style={{ margin: 0, fontSize: '1.12rem', fontWeight: 800, lineHeight: 1.35, color: tokens.colors.textPrimary }}
          >
            {question.text}
          </p>
          <p style={{ margin: '4px 0 0 0', fontSize: '0.7rem', color: tokens.colors.textMuted }}>
            {detail.startedByMe ? 'You asked this' : `${partnerName} asked this`}
          </p>
        </div>

        {/* --- Writing an answer ------------------------------------------------------- */}
        {showComposer && (
          <AnswerComposer
            key={myAnswer ? `${session.id}-revise` : `${session.id}-new`}
            question={question}
            initial={myAnswer ? parseAnswerValue(myAnswer.answer, question.input_type) ?? emptyAnswer(question.input_type) : emptyAnswer(question.input_type)}
            submitLabel={myAnswer ? 'Save my new answer' : 'Send my answer'}
            busy={busy}
            hint={partnerHasAnswered
              ? `${partnerName} has already answered. Theirs stays sealed until yours is in.`
              : null}
            onSubmit={async (value) => {
              if (myAnswer) await onRevise(myAnswer.id, value);
              else await onSubmit(value);
              setEditing(false);
            }}
          />
        )}

        {showComposer && (
          <p style={{ margin: 0, textAlign: 'center', fontSize: '0.72rem', color: tokens.colors.textMuted, lineHeight: 1.45 }}>
            <Lock size={11} style={{ verticalAlign: '-1px', marginRight: '4px' }} aria-hidden="true" />
            {`Sealed until you and ${partnerName} have both answered.`}
          </p>
        )}

        {/* --- Answered, waiting for the partner --------------------------------------- */}
        {!showComposer && !revealed && myAnswer && (
          <div data-session-screen="waiting" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div
              data-my-sealed-answer
              style={{
                padding: '14px',
                borderRadius: tokens.radii.lg,
                backgroundColor: tokens.colors.bgSurfaceSubtle,
                border: `1.5px solid ${tokens.colors.borderSubtle}`,
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <span style={{ fontSize: '0.72rem', fontWeight: 800, color: tokens.colors.textMuted }}>
                {`Your answer · ${userName}`}
              </span>
              <AnswerBody question={question} value={myAnswer.answer} />
            </div>

            <div
              data-waiting-partner
              style={{
                padding: '14px',
                borderRadius: tokens.radii.lg,
                backgroundColor: tokens.colors.accentSageSoft,
                border: `1.5px dashed ${tokens.colors.accentSage}`,
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
              }}
            >
              <Lock size={18} color={tokens.colors.accentSageDeep} aria-hidden="true" />
              <div>
                <span style={{ display: 'block', fontSize: '0.82rem', fontWeight: 800, color: tokens.colors.accentSageDeep }}>
                  {`Waiting for ${partnerName}`}
                </span>
                <span style={{ display: 'block', fontSize: '0.72rem', color: tokens.colors.textSecondary, lineHeight: 1.4 }}>
                  Both answers appear together the moment they reply. No peeking before then.
                </span>
              </div>
            </div>

            <button
              type="button"
              aria-label="Edit my answer"
              disabled={busy}
              onClick={() => setEditing(true)}
              style={{ ...ghostButtonStyle, justifyContent: 'center' }}
            >
              <Pencil size={13} aria-hidden="true" />
              <span>Edit my answer</span>
            </button>
          </div>
        )}

        {/* --- The reveal --------------------------------------------------------------- */}
        {!showComposer && revealed && (
          <div data-session-screen="revealed" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <span
              className="nooki-reveal-badge"
              data-reveal-badge
              style={{
                alignSelf: 'center',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 14px',
                borderRadius: tokens.radii.pill,
                backgroundColor: tokens.colors.primaryGreenSoft,
                color: tokens.colors.primaryGreenDeep,
                fontSize: '0.74rem',
                fontWeight: 800,
              }}
            >
              <Eye size={13} aria-hidden="true" />
              <span>You both answered</span>
            </span>

            <div style={{ display: 'flex', gap: '10px', alignItems: 'stretch' }}>
              {[
                { key: 'mine', name: userName, answer: myAnswer, side: 'mine' as const },
                { key: 'partner', name: partnerName, answer: partnerAnswer, side: 'partner' as const },
              ].map((entry) => (
                <div
                  key={entry.key}
                  className="nooki-reveal-card"
                  data-reveal-card={entry.side}
                  style={{
                    flex: '1 1 0',
                    minWidth: 0,
                    padding: '12px',
                    borderRadius: tokens.radii.lg,
                    backgroundColor: entry.side === 'mine' ? tokens.colors.primaryPinkSoft : tokens.colors.accentSageSoft,
                    border: `1.5px solid ${entry.side === 'mine' ? tokens.colors.primaryPink : tokens.colors.accentSage}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                  }}
                >
                  <span style={{ fontSize: '0.72rem', fontWeight: 800, color: tokens.colors.textSecondary }}>
                    {entry.name}
                  </span>
                  {entry.answer
                    ? <AnswerBody question={question} value={entry.answer.answer} />
                    : <span style={{ fontSize: '0.78rem', color: tokens.colors.textMuted }}>No answer stored</span>}
                </div>
              ))}
            </div>

            <ReactionPicker
              key={session.id}
              myReaction={myReaction}
              partnerReaction={partnerReaction}
              partnerName={partnerName}
              busy={busy}
              onReact={onReact}
            />
          </div>
        )}
      </div>

      <p data-session-asked style={{ margin: 0, textAlign: 'center', fontSize: '0.7rem', color: tokens.colors.textMuted }}>
        {`Asked ${new Date(session.created_at).toLocaleDateString()}`}
      </p>
    </div>
  );
};

export default SessionPanel;

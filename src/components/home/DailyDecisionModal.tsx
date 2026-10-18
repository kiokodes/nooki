import React, { useState } from 'react';
import { Check, MessageCircle, X } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import type { DailyDecisionQuestion } from '../../types/database';
import type { DailyDecisionState } from '../../hooks/useDailyDecision';

interface DailyDecisionModalProps {
  state: DailyDecisionState;
  userName: string;
  partnerName: string;
  onTakeToChat: (question: DailyDecisionQuestion) => Promise<void>;
  onClose: () => void;
}

const closeButtonStyle: React.CSSProperties = {
  width: '34px',
  height: '34px',
  borderRadius: tokens.radii.full,
  border: 'none',
  backgroundColor: tokens.colors.bgSurfaceSubtle,
  color: tokens.colors.textSecondary,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  flexShrink: 0,
};

const primaryButtonStyle = (disabled: boolean): React.CSSProperties => ({
  width: '100%',
  minHeight: '42px',
  padding: '10px 14px',
  borderRadius: tokens.radii.pill,
  border: 'none',
  backgroundColor: disabled ? tokens.colors.borderSoft : tokens.colors.primaryPink,
  color: tokens.colors.textWhite,
  boxShadow: disabled ? 'none' : tokens.shadows.highlightPink,
  fontSize: '0.82rem',
  fontWeight: 800,
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontFamily: tokens.typography.fontFamily,
});

/** One daily question; the database keeps both answers private until the second reply. */
export const DailyDecisionModal: React.FC<DailyDecisionModalProps> = ({
  state,
  userName,
  partnerName,
  onTakeToChat,
  onClose,
}) => {
  const question = state.question;
  const [draftChoice, setDraftChoice] = useState<{
    decisionDate: string | undefined;
    savedChoice: number | null;
    wasAgreed: boolean;
    value: number | null;
  } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const selectedChoice = draftChoice
    && draftChoice.decisionDate === question?.decision_date
    && draftChoice.savedChoice === state.my_choice
    && draftChoice.wasAgreed === state.agreed
    ? draftChoice.value
    : state.my_choice;
  const changed = selectedChoice !== null && selectedChoice !== state.my_choice;

  const handleSubmit = () => {
    if (selectedChoice !== null && selectedChoice !== state.my_choice) {
      void state.submitChoice(selectedChoice);
    }
  };

  const handleTakeToChat = async () => {
    if (!question || sharing) return;
    setSharing(true);
    setShareError(null);
    try {
      await onTakeToChat(question);
    } catch (error) {
      setShareError(error instanceof Error ? error.message : 'The decision could not be taken to chat. Please try again.');
    } finally {
      setSharing(false);
    }
  };

  const showRevealedAnswers = state.both_answered
    && state.my_choice !== null
    && state.partner_choice !== null;
  const myRevealedChoice = state.my_choice === null ? '' : question?.options[state.my_choice - 1] ?? '';
  const partnerRevealedChoice = state.partner_choice === null ? '' : question?.options[state.partner_choice - 1] ?? '';
  const statusText = state.agreed
    ? 'You both agree. This is today’s shared decision.'
    : showRevealedAnswers
      ? 'Your choices are different. Talk it through, then either of you can update your choice until you agree.'
      : state.my_choice !== null
        ? `${partnerName || 'Your partner'} hasn’t replied yet. Your choice stays private until they do.`
        : state.partner_responded
          ? `${partnerName || 'Your partner'} has chosen. Pick your answer to reveal both choices.`
          : 'Choose one. Neither answer is revealed until you have both replied.';

  return (
    <div
      data-modal="daily-decision"
      role="dialog"
      aria-modal="true"
      aria-label="Today’s decision"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 45,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        backgroundColor: 'rgba(55, 46, 41, 0.32)',
        backdropFilter: 'blur(2px)',
        animation: 'nooki-fade-in 0.18s ease',
      }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        className="nooki-modal-sheet"
        style={{
          backgroundColor: tokens.colors.bgCanvas,
          borderTopLeftRadius: tokens.radii.card,
          borderTopRightRadius: tokens.radii.card,
          boxShadow: tokens.shadows.card,
          maxHeight: '94%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'nooki-sheet-up 0.24s cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <header
          style={{
            padding: '14px 16px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            borderBottom: `1px solid ${tokens.colors.borderSubtle}`,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                fontSize: '0.64rem',
                fontWeight: 800,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: tokens.colors.accentSageDeep,
              }}
            >
              Daily decision
            </span>
            <h2 style={{ margin: '2px 0 0', fontSize: '1.05rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
              Today’s decision
            </h2>
          </div>
          <button type="button" style={closeButtonStyle} aria-label="Close daily decision" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div
          data-daily-decision-body
          style={{
            minHeight: 0,
            overflowY: 'auto',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          {state.loading && !question ? (
            <p data-decision-loading style={{ margin: 0, color: tokens.colors.textSecondary, fontSize: '0.82rem' }}>
              Loading today’s decision…
            </p>
          ) : state.error && !question ? (
            <p role="alert" data-decision-error style={{ margin: 0, color: '#B91C1C', fontSize: '0.8rem', fontWeight: 700, lineHeight: 1.5 }}>
              {state.error}
            </p>
          ) : !question ? (
            <p data-decision-empty style={{ margin: 0, color: tokens.colors.textSecondary, fontSize: '0.82rem', lineHeight: 1.5 }}>
              No decision has been added for today yet. Check back soon.
            </p>
          ) : (
            <>
              <p
                data-decision-question
                style={{
                  margin: 0,
                  color: tokens.colors.textPrimary,
                  fontSize: '0.94rem',
                  fontWeight: 750,
                  lineHeight: 1.5,
                }}
              >
                {question.question}
              </p>

              <p
                data-decision-status
                aria-live="polite"
                style={{
                  margin: 0,
                  padding: '10px 12px',
                  borderRadius: tokens.radii.md,
                  backgroundColor: state.agreed ? tokens.colors.accentSageSoft : tokens.colors.bgSurfaceSubtle,
                  border: `1px solid ${state.agreed ? tokens.colors.accentSage : tokens.colors.borderSubtle}`,
                  color: state.agreed ? tokens.colors.accentSageDeep : tokens.colors.textSecondary,
                  fontSize: '0.76rem',
                  fontWeight: 650,
                  lineHeight: 1.45,
                }}
              >
                {statusText}
              </p>

              {showRevealedAnswers && (
                <div
                  data-decision-reveal
                  aria-label="Both answers revealed"
                  style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}
                >
                  <div style={{ padding: '10px', borderRadius: tokens.radii.md, backgroundColor: tokens.colors.primaryPinkSoft, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: '0.65rem', fontWeight: 800, color: tokens.colors.primaryPinkDeep }}>You · {userName}</span>
                    <span data-my-decision-choice style={{ display: 'block', marginTop: '3px', fontSize: '0.8rem', fontWeight: 750, color: tokens.colors.textPrimary, overflowWrap: 'anywhere' }}>
                      {myRevealedChoice}
                    </span>
                  </div>
                  <div style={{ padding: '10px', borderRadius: tokens.radii.md, backgroundColor: tokens.colors.accentSageSoft, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: '0.65rem', fontWeight: 800, color: tokens.colors.accentSageDeep }}>{partnerName || 'Your partner'}</span>
                    <span data-partner-decision-choice style={{ display: 'block', marginTop: '3px', fontSize: '0.8rem', fontWeight: 750, color: tokens.colors.textPrimary, overflowWrap: 'anywhere' }}>
                      {partnerRevealedChoice}
                    </span>
                  </div>
                </div>
              )}

              <fieldset
                data-decision-options
                disabled={state.busy || state.agreed}
                style={{ margin: 0, padding: 0, border: 'none', display: 'flex', flexDirection: 'column', gap: '8px' }}
              >
                <legend style={{ marginBottom: '6px', fontSize: '0.75rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
                  Choose one option
                </legend>
                {question.options.map((option, index) => {
                  const checked = selectedChoice === index + 1;
                  return (
                    <label
                      key={`${index}-${option}`}
                      data-decision-option={index + 1}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        padding: '11px 12px',
                        borderRadius: tokens.radii.md,
                        border: `1px solid ${checked ? tokens.colors.accentSage : tokens.colors.borderSubtle}`,
                        backgroundColor: checked ? tokens.colors.accentSageSoft : tokens.colors.bgSurface,
                        color: tokens.colors.textPrimary,
                        cursor: state.busy || state.agreed ? 'default' : 'pointer',
                        fontSize: '0.8rem',
                        lineHeight: 1.4,
                        fontWeight: checked ? 750 : 600,
                      }}
                    >
                      <input
                        type="radio"
                        name="daily-decision-choice"
                        value={index + 1}
                        checked={checked}
                        disabled={state.busy || state.agreed}
                        onChange={() => setDraftChoice({
                          decisionDate: question.decision_date,
                          savedChoice: state.my_choice,
                          wasAgreed: state.agreed,
                          value: index + 1,
                        })}
                        style={{ accentColor: tokens.colors.accentSageDeep, flexShrink: 0 }}
                      />
                      <span>{option}</span>
                    </label>
                  );
                })}
              </fieldset>

              {!state.agreed && (
                <button
                  type="button"
                  data-action="submit-daily-decision"
                  disabled={state.busy || selectedChoice === null || !changed}
                  onClick={handleSubmit}
                  style={primaryButtonStyle(state.busy || selectedChoice === null || !changed)}
                >
                  {state.busy ? 'Saving…' : state.my_choice === null ? 'Submit my choice' : changed ? 'Update my choice' : 'Choice saved'}
                </button>
              )}

              {state.error && (
                <p role="alert" data-decision-error style={{ margin: 0, color: '#B91C1C', fontSize: '0.76rem', fontWeight: 700, lineHeight: 1.5 }}>
                  {state.error}
                </p>
              )}

              <button
                type="button"
                data-action="take-decision-to-chat"
                disabled={sharing}
                onClick={() => void handleTakeToChat()}
                style={{
                  width: '100%',
                  minHeight: '40px',
                  padding: '9px 14px',
                  borderRadius: tokens.radii.pill,
                  border: `1px solid ${tokens.colors.accentSage}`,
                  backgroundColor: tokens.colors.accentSageSoft,
                  color: tokens.colors.accentSageDeep,
                  fontSize: '0.8rem',
                  fontWeight: 800,
                  cursor: sharing ? 'not-allowed' : 'pointer',
                  fontFamily: tokens.typography.fontFamily,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '7px',
                }}
              >
                <MessageCircle size={15} aria-hidden="true" />
                {sharing ? 'Taking to chat…' : 'Take to chat'}
              </button>
              {shareError && <p role="alert" style={{ margin: 0, color: '#B91C1C', fontSize: '0.76rem', fontWeight: 700 }}>{shareError}</p>}
              <p style={{ margin: '-6px 0 0', textAlign: 'center', color: tokens.colors.textMuted, fontSize: '0.68rem', lineHeight: 1.4 }}>
                This shares the question and all three options in your chat.
              </p>
              {state.agreed && (
                <div data-decision-agreed style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', color: tokens.colors.accentSageDeep, fontSize: '0.78rem', fontWeight: 800 }}>
                  <Check size={15} aria-hidden="true" />
                  Agreed together
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default DailyDecisionModal;

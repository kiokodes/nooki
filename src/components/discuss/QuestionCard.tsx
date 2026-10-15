import React from 'react';
import { ArrowLeft, Lock, Send } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { categoryDisplay } from '../../lib/questionFormat';
import type { Question, QuestionInputType } from '../../types/database';

interface QuestionCardProps {
  question: Question;
  partnerName: string;
  busy: boolean;
  /** Unused questions left after this one, so the card can say when the well runs dry. */
  remaining: number;
  onAsk: () => void;
  onAnother: () => void;
  onBack: () => void;
}

const ANSWER_HINTS: Record<QuestionInputType, string> = {
  text: 'You both write an answer',
  choice: 'You both pick one',
  multi_choice: 'You both tick any that apply',
  ranking: 'You both put them in order',
  slider: 'You both pick 1 to 10',
};

const pillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  padding: '5px 12px',
  borderRadius: tokens.radii.pill,
  fontSize: '0.7rem',
  fontWeight: 800,
};

const ghostButtonStyle: React.CSSProperties = {
  padding: '12px 16px',
  borderRadius: tokens.radii.pill,
  border: `1.5px solid ${tokens.colors.borderSoft}`,
  backgroundColor: tokens.colors.bgSurface,
  color: tokens.colors.textSecondary,
  fontSize: '0.82rem',
  fontWeight: 700,
  fontFamily: tokens.typography.fontFamily,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
};

/**
 * Step two: the question itself. Nothing is stored yet — tapping "Ask my partner" is what
 * creates the session both of you answer privately.
 */
export const QuestionCard: React.FC<QuestionCardProps> = ({
  question,
  partnerName,
  busy,
  remaining,
  onAsk,
  onAnother,
  onBack,
}) => {
  const display = categoryDisplay(question.category);

  return (
    <div data-discuss-question style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <button
        type="button"
        aria-label="Back to categories"
        onClick={onBack}
        style={{ ...ghostButtonStyle, alignSelf: 'flex-start', padding: '8px 14px' }}
      >
        <ArrowLeft size={14} aria-hidden="true" />
        <span>Categories</span>
      </button>

      <div
        style={{
          backgroundColor: tokens.colors.bgSurface,
          borderRadius: tokens.radii.card,
          padding: '22px 20px',
          boxShadow: tokens.shadows.card,
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          <span style={{ ...pillStyle, backgroundColor: display.accentSoft, color: display.accent }}>
            <span aria-hidden="true">{display.emoji}</span>
            <span>{display.name}</span>
          </span>
          <span style={{ ...pillStyle, backgroundColor: tokens.colors.bgSurfaceSubtle, color: tokens.colors.textSecondary }}>
            {`Level ${question.seriousness}`}
          </span>
          {question.is_adult && (
            <span style={{ ...pillStyle, backgroundColor: tokens.colors.primaryPinkSoft, color: tokens.colors.primaryPinkDeep }}>
              <Lock size={11} aria-hidden="true" />
              <span>18+</span>
            </span>
          )}
        </div>

        <p
          data-question-text
          style={{
            margin: 0,
            fontSize: '1.22rem',
            fontWeight: 800,
            lineHeight: 1.35,
            color: tokens.colors.textPrimary,
            letterSpacing: '-0.01em',
          }}
        >
          {question.text}
        </p>

        <p style={{ margin: 0, fontSize: '0.76rem', color: tokens.colors.textMuted }}>
          {ANSWER_HINTS[question.input_type]}
        </p>

        <div
          data-question-privacy
          style={{
            padding: '10px 12px',
            borderRadius: tokens.radii.md,
            backgroundColor: tokens.colors.accentSageSoft,
            border: `1px solid ${tokens.colors.borderSubtle}`,
            fontSize: '0.74rem',
            color: tokens.colors.accentSageDeep,
            fontWeight: 600,
            lineHeight: 1.45,
          }}
        >
          {`You answer privately, ${partnerName} answers privately, and nothing is shown until you both have.`}
        </div>

        <button
          type="button"
          aria-label="Ask my partner"
          disabled={busy}
          onClick={onAsk}
          style={{
            padding: '13px',
            borderRadius: tokens.radii.pill,
            border: 'none',
            backgroundColor: tokens.colors.accentSageDeep,
            color: tokens.colors.textWhite,
            fontSize: '0.92rem',
            fontWeight: 800,
            fontFamily: tokens.typography.fontFamily,
            cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.7 : 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            boxShadow: tokens.shadows.subtle,
          }}
        >
          <Send size={15} aria-hidden="true" />
          <span>Ask my partner</span>
        </button>

        <button
          type="button"
          aria-label="Show another question"
          disabled={busy}
          onClick={onAnother}
          style={{ ...ghostButtonStyle, justifyContent: 'center', opacity: busy ? 0.6 : 1 }}
        >
          <span>Not this one — show another</span>
        </button>

        <span style={{ textAlign: 'center', fontSize: '0.7rem', color: tokens.colors.textMuted }}>
          {remaining > 0
            ? `${remaining} more like this to come`
            : 'That is the last one in this corner for now'}
        </span>
      </div>
    </div>
  );
};

export default QuestionCard;

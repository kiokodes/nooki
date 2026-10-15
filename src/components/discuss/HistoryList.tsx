import React from 'react';
import { ArrowLeft, ChevronRight, Lock } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { categoryDisplay, formatAnswerSummary } from '../../lib/questionFormat';
import type { SessionDetail } from '../../hooks/useDiscuss';

interface HistoryListProps {
  sessions: SessionDetail[];
  /** This phone's account, so the list can show your own comment on a row. */
  userId: string;
  partnerName: string;
  onOpen: (sessionId: string) => void;
  onBack: () => void;
}

interface StateChip {
  label: string;
  color: string;
  background: string;
}

/** The three things a past session can still be doing. */
function stateChip(detail: SessionDetail, partnerName: string): StateChip {
  if (detail.revealed) {
    return { label: 'Revealed', color: tokens.colors.primaryGreenDeep, background: tokens.colors.primaryGreenSoft };
  }
  if (!detail.myAnswer) {
    return { label: 'Your turn', color: tokens.colors.primaryPinkDeep, background: tokens.colors.primaryPinkSoft };
  }
  return { label: `Waiting for ${partnerName}`, color: tokens.colors.accentSageDeep, background: tokens.colors.accentSageSoft };
}

/**
 * Every question this couple has asked, newest first. A sealed session shows its state
 * and nothing else — the partner's answer is not in this list because the database never
 * sent it.
 */
export const HistoryList: React.FC<HistoryListProps> = ({ sessions, userId, partnerName, onOpen, onBack }) => {
  return (
    <div data-discuss-history style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
        <button
          type="button"
          aria-label="Back to categories"
          onClick={onBack}
          style={{
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
          }}
        >
          <ArrowLeft size={14} aria-hidden="true" />
          <span>Categories</span>
        </button>
        <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
          Your questions
        </h2>
        {/* Keeps the title centred against the back button. */}
        <span style={{ width: '104px' }} aria-hidden="true" />
      </div>

      {!sessions.length && (
        <div
          data-history-empty
          style={{
            padding: '24px 18px',
            borderRadius: tokens.radii.lg,
            backgroundColor: tokens.colors.bgSurface,
            border: `1.5px dashed ${tokens.colors.borderSoft}`,
            textAlign: 'center',
            fontSize: '0.82rem',
            color: tokens.colors.textSecondary,
            lineHeight: 1.5,
          }}
        >
          Nothing asked yet. Pick a category and ask your first question.
        </div>
      )}

      {sessions.map((detail) => {
        const chip = stateChip(detail, partnerName);
        const display = categoryDisplay(detail.question?.category ?? '');
        const myComment = detail.comments.find((entry) => entry.user_id === userId) ?? null;
        return (
          <button
            key={detail.session.id}
            type="button"
            aria-label={`Open ${detail.question?.text ?? 'this question'}`}
            data-history-item={detail.session.id}
            data-history-state={detail.revealed ? 'revealed' : detail.myAnswer ? 'waiting' : 'your-turn'}
            onClick={() => onOpen(detail.session.id)}
            style={{
              width: '100%',
              padding: '13px 14px',
              borderRadius: tokens.radii.lg,
              backgroundColor: tokens.colors.bgSurface,
              border: `1.5px solid ${tokens.colors.borderSubtle}`,
              boxShadow: tokens.shadows.subtle,
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              cursor: 'pointer',
              fontFamily: tokens.typography.fontFamily,
              textAlign: 'left',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: '34px',
                height: '34px',
                borderRadius: tokens.radii.full,
                backgroundColor: display.accentSoft,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1rem',
                flexShrink: 0,
              }}
            >
              {display.emoji}
            </span>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <span
                style={{
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  color: tokens.colors.textPrimary,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {detail.question?.text ?? 'A question that is no longer in your library'}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <span
                  style={{
                    padding: '2px 9px',
                    borderRadius: tokens.radii.pill,
                    backgroundColor: chip.background,
                    color: chip.color,
                    fontSize: '0.66rem',
                    fontWeight: 800,
                  }}
                >
                  {chip.label}
                </span>
                <span style={{ fontSize: '0.66rem', color: tokens.colors.textMuted }}>
                  {new Date(detail.session.created_at).toLocaleDateString()}
                </span>
                {detail.revealed && detail.myAnswer?.answer != null && (
                  <span style={{ fontSize: '0.66rem', color: tokens.colors.textMuted }}>
                    {formatAnswerSummary(detail.myAnswer.answer, detail.question?.input_type ?? 'text').slice(0, 34)}
                  </span>
                )}
                {myComment && (
                  <span data-my-comment style={{ fontSize: '0.66rem', color: tokens.colors.textSecondary }}>
                    {`💬 ${myComment.comment.length > 28 ? `${myComment.comment.slice(0, 28)}…` : myComment.comment}`}
                  </span>
                )}
              </span>
            </span>
            {!detail.revealed && <Lock size={14} color={tokens.colors.textMuted} aria-hidden="true" />}
            <ChevronRight size={16} color={tokens.colors.textMuted} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
};

export default HistoryList;

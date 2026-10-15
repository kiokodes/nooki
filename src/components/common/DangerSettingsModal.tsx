import React, { useState } from 'react';
import { AlertTriangle, LogOut, HeartCrack, Lock } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { requestOrConfirmBreakup, cancelBreakup } from '../../lib/authService';
import type { Couple, Profile } from '../../types/database';

interface DangerSettingsModalProps {
  userId: string;
  couple: Couple;
  partner: Profile | null;
  /** This partner's own 18+ consent. The category opens only when both are true. */
  adultQuestionsEnabled: boolean;
  partnerAdultQuestionsEnabled: boolean;
  adultQuestionsSaving: boolean;
  onToggleAdultQuestions: (enabled: boolean) => Promise<void>;
  onClose: () => void;
  onCoupleEnded: () => void;
  onSignOut: () => void;
}

export const DangerSettingsModal: React.FC<DangerSettingsModalProps> = ({
  userId,
  couple,
  partner,
  adultQuestionsEnabled,
  partnerAdultQuestionsEnabled,
  adultQuestionsSaving,
  onToggleAdultQuestions,
  onClose,
  onCoupleEnded,
  onSignOut,
}) => {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [adultError, setAdultError] = useState<string | null>(null);

  const partnerName = partner?.name || 'your partner';
  const bothAgreed = adultQuestionsEnabled && partnerAdultQuestionsEnabled;

  const handleToggleAdultQuestions = async () => {
    setAdultError(null);
    try {
      await onToggleAdultQuestions(!adultQuestionsEnabled);
    } catch (err: any) {
      setAdultError(err?.message || 'That setting could not be saved.');
    }
  };

  const hasRequestedBreakup = couple.breakup_requested_by === userId;
  const partnerRequestedBreakup =
    couple.breakup_requested_by && couple.breakup_requested_by !== userId;

  const handleBreakupAction = async () => {
    setLoading(true);
    try {
      const res = await requestOrConfirmBreakup();
      setMessage(res.message);
      if (res.status === 'ended') {
        setTimeout(() => {
          onCoupleEnded();
        }, 1500);
      }
    } catch (err: any) {
      setMessage(err?.message || 'Error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleCancelBreakup = async () => {
    setLoading(true);
    try {
      await cancelBreakup();
      setMessage('Breakup request cancelled.');
      setTimeout(() => {
        onCoupleEnded();
      }, 500);
    } catch (err: any) {
      setMessage(err?.message || 'Error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(55, 46, 41, 0.45)',
        backdropFilter: 'blur(3px)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
    >
      <div
        style={{
          width: '100%',
          backgroundColor: tokens.colors.bgSurface,
          borderRadius: tokens.radii.card,
          padding: '28px 22px',
          boxShadow: tokens.shadows.card,
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={18} color="#EF4444" />
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
              Couple Settings
            </h3>
          </div>
          <button
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '1.1rem',
              cursor: 'pointer',
              color: tokens.colors.textMuted,
            }}
          >
            ✕
          </button>
        </div>

        {/* Regular Account Actions */}
        <div
          style={{
            padding: '12px 14px',
            borderRadius: tokens.radii.md,
            backgroundColor: tokens.colors.bgSurfaceSubtle,
            border: `1px solid ${tokens.colors.borderSubtle}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: tokens.colors.textPrimary, display: 'block' }}>
              Sign Out
            </span>
            <span style={{ fontSize: '0.72rem', color: tokens.colors.textMuted }}>
              Stay logged in on return or switch accounts
            </span>
          </div>

          <button
            onClick={onSignOut}
            style={{
              padding: '6px 14px',
              borderRadius: tokens.radii.pill,
              backgroundColor: tokens.colors.bgSurface,
              border: `1px solid ${tokens.colors.borderSubtle}`,
              color: tokens.colors.textSecondary,
              fontSize: '0.78rem',
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <LogOut size={13} />
            <span>Sign Out</span>
          </button>
        </div>

        {/* 18+ questions: hidden from the library until both partners switch it on. */}
        <div
          data-adult-settings
          style={{
            border: `1.5px solid ${tokens.colors.borderSubtle}`,
            backgroundColor: tokens.colors.bgSurfaceSubtle,
            borderRadius: tokens.radii.lg,
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Lock size={15} color={tokens.colors.primaryPinkDeep} />
            <span style={{ fontSize: '0.86rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
              Intimacy questions (18+)
            </span>
          </div>

          <p style={{ fontSize: '0.76rem', color: tokens.colors.textSecondary, margin: 0, lineHeight: 1.5 }}>
            The Intimacy category stays out of your question library until <strong>both of you</strong> turn
            it on. Either of you turning it off hides those questions again, for both phones.
          </p>

          <div
            data-adult-status
            style={{
              display: 'flex',
              gap: '8px',
              fontSize: '0.74rem',
              fontWeight: 700,
            }}
          >
            <span
              style={{
                flex: 1,
                padding: '7px 10px',
                borderRadius: tokens.radii.sm,
                backgroundColor: adultQuestionsEnabled ? tokens.colors.primaryGreenSoft : tokens.colors.bgSurface,
                color: adultQuestionsEnabled ? tokens.colors.primaryGreenDeep : tokens.colors.textMuted,
                border: `1px solid ${tokens.colors.borderSubtle}`,
              }}
            >
              {`You: ${adultQuestionsEnabled ? 'on' : 'off'}`}
            </span>
            <span
              style={{
                flex: 1,
                padding: '7px 10px',
                borderRadius: tokens.radii.sm,
                backgroundColor: partnerAdultQuestionsEnabled ? tokens.colors.primaryGreenSoft : tokens.colors.bgSurface,
                color: partnerAdultQuestionsEnabled ? tokens.colors.primaryGreenDeep : tokens.colors.textMuted,
                border: `1px solid ${tokens.colors.borderSubtle}`,
              }}
            >
              {`${partnerName}: ${partnerAdultQuestionsEnabled ? 'on' : 'off'}`}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
            <span style={{ fontSize: '0.76rem', fontWeight: 700, color: bothAgreed ? tokens.colors.primaryGreenDeep : tokens.colors.textSecondary }}>
              {bothAgreed ? 'Unlocked for you both' : `Hidden until ${partnerName} agrees too`}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={adultQuestionsEnabled}
              aria-label={adultQuestionsEnabled ? 'Turn off Intimacy questions' : 'Turn on Intimacy questions'}
              disabled={adultQuestionsSaving}
              onClick={handleToggleAdultQuestions}
              style={{
                width: '52px',
                height: '30px',
                borderRadius: tokens.radii.pill,
                border: `1.5px solid ${adultQuestionsEnabled ? tokens.colors.primaryPinkDeep : tokens.colors.borderSoft}`,
                backgroundColor: adultQuestionsEnabled ? tokens.colors.primaryPink : tokens.colors.bgSurface,
                position: 'relative',
                cursor: adultQuestionsSaving ? 'not-allowed' : 'pointer',
                opacity: adultQuestionsSaving ? 0.6 : 1,
                flexShrink: 0,
                padding: 0,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: '2px',
                  left: adultQuestionsEnabled ? '24px' : '2px',
                  width: '22px',
                  height: '22px',
                  borderRadius: tokens.radii.full,
                  backgroundColor: tokens.colors.textWhite,
                  boxShadow: tokens.shadows.subtle,
                  transition: 'left 0.18s ease',
                }}
              />
            </button>
          </div>

          {adultError && (
            <span role="alert" style={{ fontSize: '0.76rem', color: '#B91C1C', fontWeight: 700 }}>
              {adultError}
            </span>
          )}
        </div>

        {/* Danger Zone: End Couple (Mutual Agreement Required) */}
        <div
          style={{
            border: '1.5px solid #FEE2E2',
            backgroundColor: '#FFF5F5',
            borderRadius: tokens.radii.lg,
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <HeartCrack size={16} color="#DC2626" />
            <span style={{ fontSize: '0.86rem', fontWeight: 800, color: '#991B1B' }}>
              Danger Zone: End Couple
            </span>
          </div>

          <p style={{ fontSize: '0.76rem', color: '#7F1D1D', margin: 0, lineHeight: 1.5 }}>
            To end this couple, <strong>both partners must agree</strong>. Once confirmed by both, both of you are unlinked and free to invite or join another couple.
          </p>

          {partnerRequestedBreakup && (
            <div
              style={{
                backgroundColor: '#FEE2E2',
                padding: '10px 12px',
                borderRadius: tokens.radii.sm,
                fontSize: '0.78rem',
                color: '#991B1B',
                fontWeight: 600,
              }}
            >
              ⚠️ {partner?.name || 'Your partner'} has requested to end the couple. Agreeing below will immediately dissolve the couple.
            </div>
          )}

          {hasRequestedBreakup && (
            <div
              style={{
                backgroundColor: '#FEF3C7',
                padding: '10px 12px',
                borderRadius: tokens.radii.sm,
                fontSize: '0.78rem',
                color: '#92400E',
                fontWeight: 600,
              }}
            >
              ⏳ You requested to end this couple. Waiting for {partner?.name || 'partner'} to agree.
            </div>
          )}

          {message && (
            <div style={{ fontSize: '0.78rem', color: '#B91C1C', fontWeight: 700 }}>
              {message}
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
            {hasRequestedBreakup ? (
              <button
                type="button"
                disabled={loading}
                onClick={handleCancelBreakup}
                style={{
                  flex: 1,
                  padding: '10px',
                  borderRadius: tokens.radii.pill,
                  backgroundColor: tokens.colors.bgSurface,
                  color: tokens.colors.textPrimary,
                  border: `1px solid ${tokens.colors.borderSubtle}`,
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Cancel Request
              </button>
            ) : (
              <button
                type="button"
                disabled={loading}
                onClick={handleBreakupAction}
                style={{
                  flex: 1,
                  padding: '10px',
                  borderRadius: tokens.radii.pill,
                  backgroundColor: '#DC2626',
                  color: '#FFFFFF',
                  border: 'none',
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {partnerRequestedBreakup ? 'Agree & End Couple' : 'Request to End Couple'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

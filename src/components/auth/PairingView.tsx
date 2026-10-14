import React, { useState } from 'react';
import { Heart, PlusCircle, LogIn, Calendar, Copy, Check, RefreshCw } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { createCouple, joinCoupleWithCode } from '../../lib/authService';
import type { Couple } from '../../types/database';

interface PairingProps {
  userId: string;
  userName: string;
  couple: Couple | null;
  onPairSuccess: () => void;
}

export const PairingView: React.FC<PairingProps> = ({
  userId,
  userName,
  couple,
  onPairSuccess,
}) => {
  const [mode, setMode] = useState<'choose' | 'create' | 'join'>('choose');
  const [anniversaryDate, setAnniversaryDate] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // If user already created a couple and is waiting for partner
  if (couple) {
    const handleCopy = () => {
      navigator.clipboard.writeText(couple.invite_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };

    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '0 24px',
        }}
      >
        <div
          style={{
            backgroundColor: tokens.colors.bgSurface,
            borderRadius: tokens.radii.card,
            padding: '38px 24px',
            boxShadow: tokens.shadows.card,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            gap: '18px',
          }}
        >
          {/* Pulsing gentle ring */}
          <div
            style={{
              width: '72px',
              height: '72px',
              borderRadius: tokens.radii.full,
              backgroundColor: tokens.colors.primaryPinkSoft,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: tokens.colors.primaryPinkDeep,
              boxShadow: tokens.shadows.highlightPink,
            }}
          >
            <Heart size={36} fill={tokens.colors.primaryPink} strokeWidth={1.5} />
          </div>

          <div>
            <h2
              style={{
                fontSize: '1.5rem',
                fontWeight: 800,
                color: tokens.colors.textPrimary,
                margin: '0 0 6px 0',
              }}
            >
              Waiting for Your Partner...
            </h2>
            <p
              style={{
                fontSize: '0.88rem',
                color: tokens.colors.textSecondary,
                lineHeight: 1.5,
                margin: 0,
                maxWidth: '280px',
              }}
            >
              Share this 6-character code with your person. Once they join, your shared nook will unlock!
            </p>
          </div>

          {/* Large, clear Invite Code display */}
          <div
            style={{
              width: '100%',
              backgroundColor: tokens.colors.bgSurfaceSubtle,
              border: `2px dashed ${tokens.colors.primaryPink}`,
              borderRadius: tokens.radii.lg,
              padding: '18px 12px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '10px',
            }}
          >
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: tokens.colors.textMuted }}>
              YOUR 6-CHARACTER INVITE CODE
            </span>
            <span
              style={{
                fontSize: '2.4rem',
                fontWeight: 900,
                letterSpacing: '0.22em',
                color: tokens.colors.textPrimary,
                fontFamily: 'monospace',
                marginLeft: '0.22em',
              }}
            >
              {couple.invite_code}
            </span>

            <button
              onClick={handleCopy}
              style={{
                padding: '8px 18px',
                borderRadius: tokens.radii.pill,
                backgroundColor: copied ? tokens.colors.primaryGreen : tokens.colors.bgSurface,
                color: copied ? tokens.colors.primaryGreenDeep : tokens.colors.textPrimary,
                border: `1.5px solid ${copied ? tokens.colors.primaryGreen : tokens.colors.borderSubtle}`,
                fontSize: '0.82rem',
                fontWeight: 700,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'all 0.2s ease',
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              <span>{copied ? 'Code Copied!' : 'Copy Invite Code'}</span>
            </button>
          </div>

          {couple.anniversary_date && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '0.8rem',
                color: tokens.colors.textSecondary,
              }}
            >
              <Calendar size={14} color={tokens.colors.primaryPinkDeep} />
              <span>Anniversary locked: <strong>{couple.anniversary_date}</strong></span>
            </div>
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '0.76rem',
              color: tokens.colors.textMuted,
            }}
          >
            <RefreshCw size={13} />
            <span>Listening for partner to join...</span>
          </div>

          <button
            onClick={onPairSuccess}
            style={{
              padding: '8px 16px',
              borderRadius: tokens.radii.pill,
              background: 'none',
              border: `1px solid ${tokens.colors.borderSubtle}`,
              color: tokens.colors.textSecondary,
              fontSize: '0.78rem',
              cursor: 'pointer',
            }}
          >
            Check Connection Now
          </button>
        </div>
      </div>
    );
  }

  // Create Couple Flow
  const handleCreateCouple = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!anniversaryDate) {
      setError('Please select your relationship anniversary date.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await createCouple(userId, anniversaryDate);
      onPairSuccess();
    } catch (err: any) {
      setError(err?.message || 'Failed to create couple.');
    } finally {
      setLoading(false);
    }
  };

  // Join Couple Flow
  const handleJoinCouple = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCode || joinCode.trim().length < 6) {
      setError('Please enter a valid 6-character invite code.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await joinCoupleWithCode(userId, joinCode.trim());
      onPairSuccess();
    } catch (err: any) {
      setError(err?.message || 'Failed to join couple.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '0 24px',
      }}
    >
      <div
        style={{
          backgroundColor: tokens.colors.bgSurface,
          borderRadius: tokens.radii.card,
          padding: '36px 24px',
          boxShadow: tokens.shadows.card,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '20px',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <h2
            style={{
              fontSize: '1.5rem',
              fontWeight: 800,
              color: tokens.colors.textPrimary,
              margin: '0 0 4px 0',
            }}
          >
            Hi {userName} 👋
          </h2>
          <p style={{ fontSize: '0.86rem', color: tokens.colors.textSecondary, margin: 0 }}>
            Connect with your partner to unlock your shared Nook
          </p>
        </div>

        {error && (
          <div
            style={{
              width: '100%',
              backgroundColor: '#FEF2F2',
              color: '#DC2626',
              padding: '10px 14px',
              borderRadius: tokens.radii.sm,
              fontSize: '0.8rem',
            }}
          >
            {error}
          </div>
        )}

        {mode === 'choose' && (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {/* Option 1: Create a Couple */}
            <button
              onClick={() => {
                setMode('create');
                setError(null);
              }}
              style={{
                width: '100%',
                padding: '20px 18px',
                borderRadius: tokens.radii.lg,
                backgroundColor: tokens.colors.bgSurfaceSubtle,
                border: `1.5px solid ${tokens.colors.borderSubtle}`,
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s ease',
              }}
            >
              <div
                style={{
                  width: '44px',
                  height: '44px',
                  borderRadius: tokens.radii.full,
                  backgroundColor: tokens.colors.primaryPinkSoft,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: tokens.colors.primaryPinkDeep,
                  flexShrink: 0,
                }}
              >
                <PlusCircle size={22} />
              </div>
              <div>
                <h4 style={{ margin: '0 0 2px 0', fontSize: '0.98rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
                  Create a Couple
                </h4>
                <p style={{ margin: 0, fontSize: '0.78rem', color: tokens.colors.textSecondary }}>
                  Set your anniversary and get a 6-character code to send to your partner.
                </p>
              </div>
            </button>

            {/* Option 2: Join with Code */}
            <button
              onClick={() => {
                setMode('join');
                setError(null);
              }}
              style={{
                width: '100%',
                padding: '20px 18px',
                borderRadius: tokens.radii.lg,
                backgroundColor: tokens.colors.bgSurfaceSubtle,
                border: `1.5px solid ${tokens.colors.borderSubtle}`,
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s ease',
              }}
            >
              <div
                style={{
                  width: '44px',
                  height: '44px',
                  borderRadius: tokens.radii.full,
                  backgroundColor: tokens.colors.primaryGreenSoft,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: tokens.colors.primaryGreenDeep,
                  flexShrink: 0,
                }}
              >
                <LogIn size={22} />
              </div>
              <div>
                <h4 style={{ margin: '0 0 2px 0', fontSize: '0.98rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
                  Enter Partner's Code
                </h4>
                <p style={{ margin: 0, fontSize: '0.78rem', color: tokens.colors.textSecondary }}>
                  Your partner already created a couple and sent you a 6-character invite code.
                </p>
              </div>
            </button>
          </div>
        )}

        {mode === 'create' && (
          <form
            onSubmit={handleCreateCouple}
            style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '14px' }}
          >
            <div>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  color: tokens.colors.textSecondary,
                  marginBottom: '6px',
                }}
              >
                <Calendar size={14} />
                <span>Relationship Anniversary Date</span>
              </label>
              <input
                type="date"
                required
                value={anniversaryDate}
                onChange={(e) => setAnniversaryDate(e.target.value)}
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  borderRadius: tokens.radii.pill,
                  border: `1.5px solid ${tokens.colors.borderSubtle}`,
                  backgroundColor: tokens.colors.bgSurfaceSubtle,
                  fontSize: '0.9rem',
                  fontFamily: tokens.typography.fontFamily,
                  color: tokens.colors.textPrimary,
                  outline: 'none',
                }}
              />
              <span style={{ fontSize: '0.72rem', color: tokens.colors.textMuted, marginTop: '4px', display: 'block' }}>
                Note: This is set once when creating the couple and cannot be edited afterward.
              </span>
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{
                marginTop: '10px',
                padding: '13px',
                borderRadius: tokens.radii.pill,
                backgroundColor: tokens.colors.primaryPink,
                color: tokens.colors.textWhite,
                border: 'none',
                fontWeight: 700,
                fontSize: '0.95rem',
                cursor: loading ? 'not-allowed' : 'pointer',
                boxShadow: tokens.shadows.highlightPink,
              }}
            >
              <span>{loading ? 'Creating Couple...' : 'Generate 6-Character Code'}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setMode('choose');
                setError(null);
              }}
              style={{
                background: 'none',
                border: 'none',
                color: tokens.colors.textMuted,
                fontSize: '0.82rem',
                cursor: 'pointer',
                textAlign: 'center',
              }}
            >
              ← Back to options
            </button>
          </form>
        )}

        {mode === 'join' && (
          <form
            onSubmit={handleJoinCouple}
            style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '14px' }}
          >
            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  color: tokens.colors.textSecondary,
                  marginBottom: '6px',
                }}
              >
                6-Character Invite Code
              </label>
              <input
                type="text"
                required
                maxLength={6}
                value={joinCode}
                placeholder="e.g. 7K4MZ9"
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  borderRadius: tokens.radii.pill,
                  border: `1.5px solid ${tokens.colors.borderSubtle}`,
                  backgroundColor: tokens.colors.bgSurfaceSubtle,
                  fontSize: '1.25rem',
                  fontFamily: 'monospace',
                  letterSpacing: '0.15em',
                  textAlign: 'center',
                  color: tokens.colors.textPrimary,
                  outline: 'none',
                  textTransform: 'uppercase',
                }}
              />
              <span style={{ fontSize: '0.72rem', color: tokens.colors.textMuted, marginTop: '4px', display: 'block', textAlign: 'center' }}>
                Ask your partner for the code displayed on their waiting screen.
              </span>
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{
                marginTop: '10px',
                padding: '13px',
                borderRadius: tokens.radii.pill,
                backgroundColor: tokens.colors.primaryGreen,
                color: tokens.colors.primaryGreenDeep,
                border: 'none',
                fontWeight: 800,
                fontSize: '0.95rem',
                cursor: loading ? 'not-allowed' : 'pointer',
                boxShadow: tokens.shadows.subtle,
              }}
            >
              <span>{loading ? 'Joining Couple...' : 'Join Couple'}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setMode('choose');
                setError(null);
              }}
              style={{
                background: 'none',
                border: 'none',
                color: tokens.colors.textMuted,
                fontSize: '0.82rem',
                cursor: 'pointer',
                textAlign: 'center',
              }}
            >
              ← Back to options
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

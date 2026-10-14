import React, { useState, useEffect } from 'react';
import { Sparkles, Globe, User, ArrowRight } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { saveOnboardingProfile } from '../../lib/authService';

interface OnboardingProps {
  userId: string;
  onComplete: () => void;
}

export const OnboardingView: React.FC<OnboardingProps> = ({ userId, onComplete }) => {
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      setTimezone(detected);
    } catch {
      setTimezone('UTC');
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Please enter your first name.');
      return;
    }

    setLoading(true);
    try {
      await saveOnboardingProfile(userId, name.trim(), timezone || 'UTC');
      onComplete();
    } catch (err: any) {
      setError(err?.message || 'Failed to save profile.');
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
          gap: '18px',
        }}
      >
        <div
          style={{
            width: '60px',
            height: '60px',
            borderRadius: tokens.radii.full,
            backgroundColor: tokens.colors.primaryGreenSoft,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: tokens.colors.primaryGreenDeep,
          }}
        >
          <Sparkles size={28} />
        </div>

        <div style={{ textAlign: 'center' }}>
          <h2
            style={{
              fontSize: '1.5rem',
              fontWeight: 800,
              color: tokens.colors.textPrimary,
              margin: '0 0 4px 0',
            }}
          >
            Tell us about you
          </h2>
          <p style={{ fontSize: '0.85rem', color: tokens.colors.textSecondary, margin: 0 }}>
            Set up your identity before pairing with your partner
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

        <form
          onSubmit={handleSubmit}
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
              <User size={14} />
              <span>First Name</span>
            </label>
            <input
              type="text"
              required
              value={name}
              placeholder="e.g. Chloe, Milo"
              onChange={(e) => setName(e.target.value)}
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
          </div>

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
              <Globe size={14} />
              <span>Timezone (Auto-detected)</span>
            </label>
            <input
              type="text"
              required
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              style={{
                width: '100%',
                padding: '12px 16px',
                borderRadius: tokens.radii.pill,
                border: `1.5px solid ${tokens.colors.borderSubtle}`,
                backgroundColor: tokens.colors.bgSurfaceSubtle,
                fontSize: '0.88rem',
                fontFamily: tokens.typography.fontFamily,
                color: tokens.colors.textPrimary,
                outline: 'none',
              }}
            />
            <span style={{ fontSize: '0.72rem', color: tokens.colors.textMuted, marginTop: '4px', display: 'block' }}>
              Used to calculate hours apart with your partner.
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
              fontFamily: tokens.typography.fontFamily,
              cursor: loading ? 'not-allowed' : 'pointer',
              boxShadow: tokens.shadows.highlightPink,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
            }}
          >
            <span>Continue to Couple Pairing</span>
            <ArrowRight size={16} />
          </button>
        </form>
      </div>
    </div>
  );
};

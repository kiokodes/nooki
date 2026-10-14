import React, { useState } from 'react';
import { Heart, AlertCircle, ArrowRight } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { signInWithEmail, signUpWithEmail } from '../../lib/authService';

interface AuthModalProps {
  onSuccess: () => void;
}

export const AuthView: React.FC<AuthModalProps> = ({ onSuccess }) => {
  const [isSignUp, setIsSignUp] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email || !password) {
      setError('Please provide both email and password.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setLoading(true);
    try {
      const res = isSignUp
        ? await signUpWithEmail(email, password)
        : await signInWithEmail(email, password);

      if (res.error) {
        setError(res.error);
      } else {
        onSuccess();
      }
    } catch (err: any) {
      setError(err?.message || 'Authentication error. Please try again.');
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
            width: '64px',
            height: '64px',
            borderRadius: tokens.radii.full,
            backgroundColor: tokens.colors.primaryPinkSoft,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: tokens.colors.primaryPinkDeep,
            boxShadow: tokens.shadows.subtle,
          }}
        >
          <Heart size={30} fill={tokens.colors.primaryPink} strokeWidth={1.5} />
        </div>

        <div style={{ textAlign: 'center' }}>
          <h1
            style={{
              fontSize: '1.65rem',
              fontWeight: 800,
              color: tokens.colors.textPrimary,
              margin: '0 0 4px 0',
            }}
          >
            {isSignUp ? 'Welcome to Nooki' : 'Welcome Back'}
          </h1>
          <p
            style={{
              fontSize: '0.88rem',
              color: tokens.colors.textSecondary,
              margin: 0,
            }}
          >
            {isSignUp
              ? 'A cozy, storybook corner for long-distance partners'
              : 'Sign in to reconnect to your couple nook'}
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
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              border: '1px solid #FEE2E2',
            }}
          >
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
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
              Email Address
            </label>
            <input
              type="email"
              required
              value={email}
              placeholder="you@love.com"
              onChange={(e) => setEmail(e.target.value)}
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
                display: 'block',
                fontSize: '0.8rem',
                fontWeight: 700,
                color: tokens.colors.textSecondary,
                marginBottom: '6px',
              }}
            >
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              placeholder="At least 6 characters"
              onChange={(e) => setPassword(e.target.value)}
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

          <button
            type="submit"
            disabled={loading}
            style={{
              marginTop: '8px',
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
              opacity: loading ? 0.7 : 1,
            }}
          >
            <span>{isSignUp ? 'Create Account' : 'Sign In'}</span>
            <ArrowRight size={16} />
          </button>
        </form>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem' }}>
          <span style={{ color: tokens.colors.textMuted }}>
            {isSignUp ? 'Already have an account?' : 'Need a new account?'}
          </span>
          <button
            type="button"
            onClick={() => {
              setIsSignUp(!isSignUp);
              setError(null);
            }}
            style={{
              background: 'none',
              border: 'none',
              color: tokens.colors.primaryPinkDeep,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: tokens.typography.fontFamily,
              textDecoration: 'underline',
              padding: 0,
            }}
          >
            {isSignUp ? 'Sign In' : 'Sign Up'}
          </button>
        </div>
      </div>
    </div>
  );
};

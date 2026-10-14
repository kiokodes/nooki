import React from 'react';
import { Heart, Sparkles, MapPin, Coffee, Send, Coins } from 'lucide-react';
import { nookiTokens } from '../tokens/designTokens';
import { StoryCard } from '../components/common/StoryCard';
import { PillButton } from '../components/common/PillButton';
import { StoryBadge } from '../components/common/StoryBadge';

export const HomeScreen: React.FC = () => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', paddingBottom: '90px' }}>
      {/* Top Welcome & Partner Distance Pill */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0 4px',
        }}
      >
        <div>
          <span style={{ fontSize: '0.8rem', fontWeight: 700, color: nookiTokens.colors.textMuted }}>
            WELCOME HOME, NOOKIES
          </span>
          <h2
            style={{
              fontSize: '1.4rem',
              fontWeight: 900,
              fontFamily: nookiTokens.typography.fontHeading,
              color: nookiTokens.colors.textPrimary,
              margin: 0,
            }}
          >
            Milo &amp; Chloe's Nook
          </h2>
        </div>

        {/* In-app Currency Pill: Nookies / Nook Bits */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            backgroundColor: '#FFF7E6',
            border: `1px solid ${nookiTokens.colors.honeySoft}`,
            borderRadius: nookiTokens.radii.pill,
            padding: '6px 12px',
            boxShadow: nookiTokens.shadows.subtle,
          }}
        >
          <Coins size={16} color={nookiTokens.colors.honeyDeep} />
          <span style={{ fontWeight: 800, fontSize: '0.85rem', color: nookiTokens.colors.honeyDeep }}>
            320 Nookies
          </span>
        </div>
      </div>

      {/* Main Storybook Hero Card: Our Nook Room */}
      <StoryCard
        variant="surface"
        style={{
          background: 'linear-gradient(180deg, #FFFDF8 0%, #FAF1E4 100%)',
          borderRadius: nookiTokens.radii.cardLg,
          padding: '22px',
          border: `1.5px solid ${nookiTokens.colors.borderSubtle}`,
          boxShadow: nookiTokens.shadows.card,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
          <StoryBadge label="Our Nook · Level 3" variant="peach" icon={<Heart size={12} fill="#FF9E88" />} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.78rem', color: nookiTokens.colors.textMuted, fontWeight: 700 }}>
            <MapPin size={13} color={nookiTokens.colors.peachDeep} />
            <span>3,842 miles apart</span>
          </div>
        </div>

        {/* Cozy Illustrated Room Scene placeholder */}
        <div
          style={{
            width: '100%',
            height: '150px',
            borderRadius: '22px',
            background: 'linear-gradient(135deg, #FFF5EB 0%, #EDF7F1 50%, #F5EEFC 100%)',
            border: '2px dashed #EADECA',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: '12px',
              right: '14px',
              background: 'rgba(255, 255, 255, 0.85)',
              backdropFilter: 'blur(4px)',
              padding: '4px 10px',
              borderRadius: '999px',
              fontSize: '0.72rem',
              fontWeight: 800,
              color: nookiTokens.colors.greenDeep,
            }}
          >
            🌱 Cozy Plant Nook
          </div>

          <div style={{ fontSize: '2.5rem', marginBottom: '6px' }}>🏡✨🛋️</div>
          <p
            style={{
              fontSize: '0.88rem',
              fontWeight: 800,
              color: nookiTokens.colors.textPrimary,
              margin: 0,
            }}
          >
            The Living Room Nook
          </p>
          <span style={{ fontSize: '0.75rem', color: nookiTokens.colors.textMuted }}>
            Chloe just placed a cozy rug 20m ago!
          </span>
        </div>

        <div style={{ marginTop: '16px', display: 'flex', gap: '10px' }}>
          <PillButton variant="peach" size="sm" icon={<Send size={15} />} style={{ flex: 1 }}>
            Send a Nook
          </PillButton>
          <PillButton variant="soft" size="sm" icon={<Coffee size={15} />} style={{ flex: 1 }}>
            Decorate Room
          </PillButton>
        </div>
      </StoryCard>

      {/* The Daily Nook prompt card */}
      <StoryCard
        variant="peach"
        style={{
          border: `1.5px solid ${nookiTokens.colors.peachSoft}`,
          padding: '20px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Sparkles size={16} color={nookiTokens.colors.peachDeep} />
            <span style={{ fontSize: '0.8rem', fontWeight: 900, color: nookiTokens.colors.peachDeep, letterSpacing: '0.04em' }}>
              THE DAILY NOOK
            </span>
          </div>
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: nookiTokens.colors.textMuted }}>
            Day 48 Streak 🔥
          </span>
        </div>

        <h3
          style={{
            fontSize: '1.05rem',
            fontWeight: 800,
            color: nookiTokens.colors.textPrimary,
            marginBottom: '6px',
            lineHeight: 1.35,
          }}
        >
          "What is one tiny ordinary memory of us you replay when you miss me?"
        </h3>

        <p style={{ fontSize: '0.82rem', color: nookiTokens.colors.textSecondary, marginBottom: '14px' }}>
          Chloe has already answered! Answer yours to unlock each other's notes.
        </p>

        <PillButton variant="peach" size="sm" style={{ width: '100%' }}>
          Answer Today's Nook (+15 Nookies)
        </PillButton>
      </StoryCard>

      {/* Quick Action Cards Grid (Pastel Palette Demonstration) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <StoryCard variant="green" style={{ padding: '16px' }}>
          <div style={{ fontSize: '1.5rem', marginBottom: '8px' }}>💌</div>
          <h4 style={{ fontSize: '0.92rem', fontWeight: 800, color: nookiTokens.colors.greenDeep, margin: '0 0 4px 0' }}>
            To Nook
          </h4>
          <p style={{ fontSize: '0.75rem', color: nookiTokens.colors.textSecondary, margin: 0 }}>
            Send quick love vibrations &amp; audio notes.
          </p>
        </StoryCard>

        <StoryCard variant="lavender" style={{ padding: '16px' }}>
          <div style={{ fontSize: '1.5rem', marginBottom: '8px' }}>🪐</div>
          <h4 style={{ fontSize: '0.92rem', fontWeight: 800, color: nookiTokens.colors.lavenderDeep, margin: '0 0 4px 0' }}>
            The Square
          </h4>
          <p style={{ fontSize: '0.75rem', color: nookiTokens.colors.textSecondary, margin: 0 }}>
            Visit community couples in The Public Nook.
          </p>
        </StoryCard>
      </div>
    </div>
  );
};

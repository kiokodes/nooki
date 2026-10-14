import React from 'react';
import { Coins, Sparkles, Trophy, Palette } from 'lucide-react';
import { nookiTokens } from '../tokens/designTokens';
import { StoryCard } from '../components/common/StoryCard';
import { PillButton } from '../components/common/PillButton';
import { StoryBadge } from '../components/common/StoryBadge';

export const GamesScreen: React.FC = () => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', paddingBottom: '90px' }}>
      {/* Top Banner */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2
            style={{
              fontSize: '1.3rem',
              fontWeight: 900,
              fontFamily: nookiTokens.typography.fontHeading,
              color: nookiTokens.colors.textPrimary,
              margin: 0,
            }}
          >
            Nook Mini-Games
          </h2>
          <p style={{ fontSize: '0.8rem', color: nookiTokens.colors.textMuted, margin: 0 }}>
            Play together &amp; earn Nookies currency
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            backgroundColor: '#FFF7E6',
            border: `1px solid ${nookiTokens.colors.honeySoft}`,
            borderRadius: nookiTokens.radii.pill,
            padding: '5px 10px',
          }}
        >
          <Coins size={15} color={nookiTokens.colors.honeyDeep} />
          <span style={{ fontWeight: 800, fontSize: '0.8rem', color: nookiTokens.colors.honeyDeep }}>
            320 Bits
          </span>
        </div>
      </div>

      {/* Featured Game: Chibi Avatar & House Decorator */}
      <StoryCard
        variant="lavender"
        style={{
          border: '1px solid #DFD2F3',
          padding: '20px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <StoryBadge label="House Decoration Drops" variant="lavender" icon={<Palette size={12} />} />
          <span style={{ fontSize: '0.74rem', fontWeight: 800, color: nookiTokens.colors.lavenderDeep }}>
            New Drops 🎁
          </span>
        </div>

        <h3 style={{ fontSize: '1.05rem', fontWeight: 800, color: nookiTokens.colors.textPrimary, margin: '0 0 6px 0' }}>
          Chibi Dress-up &amp; Nook Furnishing
        </h3>

        <p style={{ fontSize: '0.82rem', color: nookiTokens.colors.textSecondary, margin: '0 0 14px 0' }}>
          Spend earned Nookies to unlock matching pajama sets, retro record players, and mini bonsai trees.
        </p>

        <PillButton variant="lavender" size="sm" icon={<Sparkles size={14} />}>
          Enter Decor Shop
        </PillButton>
      </StoryCard>

      {/* Active Mini-Games Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <StoryCard variant="peach" style={{ padding: '16px' }}>
          <div style={{ fontSize: '1.8rem', marginBottom: '6px' }}>🎲</div>
          <h4 style={{ fontSize: '0.92rem', fontWeight: 800, color: nookiTokens.colors.peachDeep, margin: '0 0 4px 0' }}>
            Couple Trivia
          </h4>
          <p style={{ fontSize: '0.74rem', color: nookiTokens.colors.textSecondary, marginBottom: '12px' }}>
            Who remembers the first movie date?
          </p>
          <PillButton variant="peach" size="sm" style={{ width: '100%', padding: '6px 12px', fontSize: '0.8rem' }}>
            Play
          </PillButton>
        </StoryCard>

        <StoryCard variant="green" style={{ padding: '16px' }}>
          <div style={{ fontSize: '1.8rem', marginBottom: '6px' }}>🎨</div>
          <h4 style={{ fontSize: '0.92rem', fontWeight: 800, color: nookiTokens.colors.greenDeep, margin: '0 0 4px 0' }}>
            Doodle Together
          </h4>
          <p style={{ fontSize: '0.74rem', color: nookiTokens.colors.textSecondary, marginBottom: '12px' }}>
            Draw live sync on a shared cozy canvas.
          </p>
          <PillButton variant="green" size="sm" style={{ width: '100%', padding: '6px 12px', fontSize: '0.8rem' }}>
            Draw
          </PillButton>
        </StoryCard>
      </div>

      {/* Daily Leaderboard / Streak Card */}
      <StoryCard variant="surface" style={{ padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '50%',
                backgroundColor: '#FFF5E6',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Trophy size={18} color={nookiTokens.colors.honeyDeep} />
            </div>
            <div>
              <p style={{ fontSize: '0.88rem', fontWeight: 800, color: nookiTokens.colors.textPrimary, margin: 0 }}>
                48 Days Continuous Nooking
              </p>
              <span style={{ fontSize: '0.74rem', color: nookiTokens.colors.textMuted }}>
                Next tier unlock at 50 Days: Stargazer Skylight
              </span>
            </div>
          </div>
        </div>
      </StoryCard>
    </div>
  );
};

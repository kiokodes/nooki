import React from 'react';
import { Camera, Music, Sparkles, BookOpen, Plus } from 'lucide-react';
import { nookiTokens } from '../tokens/designTokens';
import { StoryCard } from '../components/common/StoryCard';
import { PillButton } from '../components/common/PillButton';
import { StoryBadge } from '../components/common/StoryBadge';

export const MediaScreen: React.FC = () => {
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
            Media &amp; Keepsakes
          </h2>
          <p style={{ fontSize: '0.8rem', color: nookiTokens.colors.textMuted, margin: 0 }}>
            Shared albums, voice clips &amp; shared books
          </p>
        </div>

        <PillButton variant="green" size="sm" icon={<Plus size={15} />}>
          Add
        </PillButton>
      </div>

      {/* Now Playing shared audio widget */}
      <StoryCard
        variant="green"
        style={{
          border: '1px solid #C5E5CE',
          display: 'flex',
          alignItems: 'center',
          gap: '14px',
          padding: '16px',
        }}
      >
        <div
          style={{
            width: '48px',
            height: '48px',
            borderRadius: '16px',
            backgroundColor: nookiTokens.colors.greenPrimary,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#15381D',
            boxShadow: nookiTokens.shadows.glowGreen,
          }}
        >
          <Music size={24} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '0.72rem', fontWeight: 800, color: nookiTokens.colors.greenDeep }}>
              LISTENING TOGETHER
            </span>
            <span style={{ fontSize: '0.65rem' }}>🎵</span>
          </div>
          <h4 style={{ fontSize: '0.92rem', fontWeight: 800, margin: '2px 0', color: nookiTokens.colors.textPrimary }}>
            Coffeehouse Chill &amp; Rain
          </h4>
          <span style={{ fontSize: '0.74rem', color: nookiTokens.colors.textSecondary }}>
            Synced via Spotify Nook
          </span>
        </div>
      </StoryCard>

      {/* Our Photo Scrapbook */}
      <StoryCard variant="surface">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Camera size={18} color={nookiTokens.colors.peachDeep} />
            <h3 style={{ fontSize: '1rem', fontWeight: 800, margin: 0, color: nookiTokens.colors.textPrimary }}>
              Storybook Scrapbook
            </h3>
          </div>
          <StoryBadge label="128 Memories" variant="peach" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
          {[
            { label: 'Airport hug', emoji: '✈️' },
            { label: 'Sunset picnic', emoji: '🌅' },
            { label: 'Matcha dates', emoji: '🍵' },
            { label: 'Paris bridge', emoji: '🌉' },
            { label: 'Video call sleep', emoji: '💤' },
            { label: 'Flower surprise', emoji: '💐' },
          ].map((item, idx) => (
            <div
              key={idx}
              style={{
                aspectRatio: '1',
                backgroundColor: nookiTokens.colors.bgSurfaceAlt,
                borderRadius: '18px',
                border: `1px solid ${nookiTokens.colors.borderSubtle}`,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4px',
                cursor: 'pointer',
                transition: 'transform 0.15s ease',
              }}
            >
              <span style={{ fontSize: '1.6rem' }}>{item.emoji}</span>
              <span style={{ fontSize: '0.65rem', fontWeight: 700, color: nookiTokens.colors.textSecondary }}>
                {item.label}
              </span>
            </div>
          ))}
        </div>
      </StoryCard>

      {/* Shared Book Reading Nook */}
      <StoryCard
        variant="lavender"
        style={{
          border: '1px solid #DFD2F3',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <BookOpen size={18} color={nookiTokens.colors.lavenderDeep} />
            <span style={{ fontWeight: 800, fontSize: '0.92rem', color: nookiTokens.colors.lavenderDeep }}>
              Shared Book Nook
            </span>
          </div>
          <StoryBadge label="Page 184 / 320" variant="lavender" />
        </div>

        <p style={{ fontSize: '0.84rem', color: nookiTokens.colors.textPrimary, margin: 0 }}>
          Currently reading: <em>"Before the Coffee Gets Cold"</em> ☕
        </p>

        <PillButton variant="lavender" size="sm" icon={<Sparkles size={14} />}>
          Open Shared Bookmark
        </PillButton>
      </StoryCard>
    </div>
  );
};

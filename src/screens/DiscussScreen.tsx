import React from 'react';
import { MessageSquarePlus, Compass } from 'lucide-react';
import { nookiTokens } from '../tokens/designTokens';
import { StoryCard } from '../components/common/StoryCard';
import { PillButton } from '../components/common/PillButton';
import { StoryBadge } from '../components/common/StoryBadge';

export const DiscussScreen: React.FC = () => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', paddingBottom: '90px' }}>
      {/* Header */}
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
            The Square
          </h2>
          <p style={{ fontSize: '0.8rem', color: nookiTokens.colors.textMuted, margin: 0 }}>
            The Public Nook · Discuss, ask &amp; connect
          </p>
        </div>

        <PillButton variant="sage" size="sm" icon={<MessageSquarePlus size={15} />}>
          New Post
        </PillButton>
      </div>

      {/* Featured Community prompt */}
      <StoryCard
        variant="sage"
        style={{
          border: '1px solid #CFDEC6',
          padding: '18px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <StoryBadge label="The Square Spotlight" variant="sage" icon={<Compass size={12} />} />
          <span style={{ fontSize: '0.74rem', color: nookiTokens.colors.sageDeep, fontWeight: 700 }}>
            1.4k Nookies discussing
          </span>
        </div>

        <h3 style={{ fontSize: '1rem', fontWeight: 800, color: nookiTokens.colors.textPrimary, margin: '0 0 6px 0' }}>
          "How do you celebrate countdown days without feeling the physical distance ache?"
        </h3>

        <p style={{ fontSize: '0.8rem', color: nookiTokens.colors.textSecondary, margin: '0 0 12px 0' }}>
          Tips and little rituals from couples who have closed or are closing the gap.
        </p>

        <PillButton variant="sage" size="sm">
          Join Discussion
        </PillButton>
      </StoryCard>

      {/* Couple Question Deck */}
      <StoryCard variant="surface">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <h4 style={{ fontSize: '0.95rem', fontWeight: 800, color: nookiTokens.colors.textPrimary, margin: 0 }}>
            Deep Nook Question Decks
          </h4>
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: nookiTokens.colors.peachDeep }}>
            View All
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {[
            {
              title: 'Future Nesting & Living Together',
              cardsCount: '40 prompts',
              badge: 'Cozy Dreams',
              badgeVariant: 'peach' as const,
            },
            {
              title: 'Vulnerability & Gentle Fears',
              cardsCount: '25 prompts',
              badge: 'Heart to Heart',
              badgeVariant: 'lavender' as const,
            },
            {
              title: 'Silly Hypotheticals & Adventures',
              cardsCount: '50 prompts',
              badge: 'Playful',
              badgeVariant: 'green' as const,
            },
          ].map((deck, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 14px',
                borderRadius: '18px',
                backgroundColor: nookiTokens.colors.bgSurfaceAlt,
                border: `1px solid ${nookiTokens.colors.borderSubtle}`,
              }}
            >
              <div>
                <p style={{ fontSize: '0.86rem', fontWeight: 800, color: nookiTokens.colors.textPrimary, margin: '0 0 2px 0' }}>
                  {deck.title}
                </p>
                <span style={{ fontSize: '0.74rem', color: nookiTokens.colors.textMuted }}>
                  {deck.cardsCount}
                </span>
              </div>
              <StoryBadge label={deck.badge} variant={deck.badgeVariant} />
            </div>
          ))}
        </div>
      </StoryCard>
    </div>
  );
};

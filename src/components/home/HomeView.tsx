import React from 'react';
import { TodayCard } from './TodayCard';
import { DailyDecisionCard } from './DailyDecisionCard';
import { NookPhotoFrame, type NookPhotoFrameProps } from './NookPhotoFrame';
import { MissYouButton, type MissYouButtonProps } from './MissYouButton';
import { useNow } from '../../hooks/useNow';
import { tokens } from '../../tokens/designTokens';
import type { CoupleEvent } from '../../types/database';

interface HomeViewProps {
  everyday?: React.ReactNode;
  events: CoupleEvent[];
  anniversaryDate: string | null;
  eventsLoading: boolean;
  eventsError: string | null;
  onOpenCalendar: () => void;
  /** Realtime presence for the other partner; this phone is already active on Home. */
  partnerOnline?: boolean;
  onOpenDailyDecision?: () => void;
  /**
   * The couple's picture filling the nook (see `useCouplePhoto`).
   * Before the first upload, the photo area invites them to choose one.
   */
  photo?: NookPhotoFrameProps;
  /**
   * The "I miss you" button in the corner of the nook. Omitted (or hidden) whenever the
   * couple is not both paired and apart — the button is for the partner who is alone.
   */
  missYou?: MissYouButtonProps;
}

/**
 * Home tab — the centre tab and the default screen.
 *
 * It shows:
 * - The Today card: today's date, anything happening today, and what is coming within the next day.
 * - Today's shared decision.
 * - A shared cozy nook, with a small top-right caption, the couple's own picture
 *   filling the space below it with a thin coloured border and two hearts, and
 *   the "I miss you" button in the top-left corner. The button belongs to the half of the
 *   couple who is in the app alone (see `useMissYou`): it is only rendered while the partner
 *   is away, and each tap is counted for that partner to open later.
 */
export const HomeView: React.FC<HomeViewProps> = ({
  everyday,
  events,
  anniversaryDate,
  eventsLoading,
  eventsError,
  onOpenCalendar,
  partnerOnline = false,
  onOpenDailyDecision,
  photo,
  missYou,
}) => {
  // Minute granularity is plenty for a date, and it keeps the tab from re-rendering every second.
  const today = useNow(60_000);

  return (
    <section
      data-screen="home"
      aria-label="Home"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: '4px 16px 12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <TodayCard
        today={today}
        events={events}
        anniversaryDate={anniversaryDate}
        loading={eventsLoading}
        error={eventsError}
        onOpenCalendar={onOpenCalendar}
      />

      <div className="home-daily-cards" style={{ display: 'grid', gridTemplateColumns: everyday ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)', gap: '10px', flexShrink: 0 }}>
        <DailyDecisionCard onPlay={onOpenDailyDecision} />
        {everyday}
      </div>

      {/* The picture fills the nook below the miss-you button and caption. */}
      <div
        data-scene-placeholder
        data-area="animated-scene"
        data-nooki-nook="cozy"
        data-partner-online={partnerOnline ? 'true' : 'false'}
        role="region"
        aria-label="Our little nook — our favourite picture together"
        className="nooki-cozy-nook"
        style={{
          flex: '1 1 145px',
          minHeight: '145px',
          width: '100%',
          borderRadius: tokens.radii.lg,
          backgroundColor: '#FFFBF2',
          boxShadow: tokens.shadows.subtle,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          position: 'relative',
          overflow: 'hidden',
          // Reserve the caption / miss-you row, then fill down to the tab bar.
          padding: '44px 8px 8px',
        }}
      >
        <div
          data-nooki-caption
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '10px',
            right: '12px',
            zIndex: 2,
            display: 'inline-flex',
            alignItems: 'center',
            padding: '5px 9px',
            borderRadius: tokens.radii.pill,
            backgroundColor: 'rgba(255,255,255,0.82)',
            border: `1px solid ${tokens.colors.borderSubtle}`,
            boxShadow: tokens.shadows.subtle,
            color: tokens.colors.textMuted,
            fontFamily: tokens.typography.fontFamily,
            fontSize: '8.5px',
            fontWeight: 700,
            letterSpacing: '0.7px',
            lineHeight: 1.1,
            textTransform: 'uppercase',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          Our little nook
        </div>
        {/* "I miss you", for when the partner is away and this phone is the only one
            in the app. It stays exactly where it has always been, in the nook's
            top-left corner. */}
        {missYou && <MissYouButton {...missYou} />}
        <NookPhotoFrame
          src={photo?.src ?? null}
          uploading={photo?.uploading ?? false}
          error={photo?.error ?? null}
          onUpload={photo?.onUpload ?? (() => {})}
          altText={photo?.altText}
        />
      </div>
    </section>
  );
};

export default HomeView;

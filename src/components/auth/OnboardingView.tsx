import React, { useState } from 'react';
import { Sparkles, User, ArrowRight } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { saveOnboardingProfile } from '../../lib/authService';
import { LocationFields } from '../common/LocationFields';
import type { GeoSource } from '../../lib/geo/placeData';
import { emptyLocationDraft, validateLocationInput } from '../../lib/geo/location';
import type { LocationDraft } from '../../lib/geo/location';
import { getDetectedTimezone } from '../../lib/timezones';

interface OnboardingProps {
  userId: string;
  onComplete: () => void;
  /** Where the place data comes from; tests hand in a small world instead of the network. */
  geo?: GeoSource;
}

/**
 * The first form: a name, and where this person is.
 *
 * It used to ask for a timezone, which is the same question with the wrong shape. A
 * timezone is what Nooki actually needs — but nobody knows theirs, and a country is not
 * enough to guess it (the United States spans 29 zones), so the old picker offered 400
 * options and hoped. Asking for the place instead answers both things Nooki is for: the
 * clock in the header, derived rather than guessed, and the city a gift would be sent to
 * when the marketplace arrives.
 *
 * The place is required. The one exception is a browser that cannot fetch the place data at
 * all, where `LocationFields` becomes the timezone picker it replaced and signup saves a
 * zone and no location — a person is never stuck at the door because a JSON file did not
 * arrive.
 */
export const OnboardingView: React.FC<OnboardingProps> = ({ userId, onComplete, geo }) => {
  const [name, setName] = useState('');
  const [location, setLocation] = useState<LocationDraft>(() => emptyLocationDraft(getDetectedTimezone()));
  const [placesAvailable, setPlacesAvailable] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Please enter your first name.');
      return;
    }

    setLoading(true);
    try {
      await saveOnboardingProfile(userId, {
        name: name.trim(),
        // No country index means no country code, and a place without one cannot be keyed —
        // so the zone alone is saved and the city can be added later in Couple Settings.
        location: placesAvailable ? validateLocationInput(location) : null,
        timezone: location.timezone,
      });
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
        minHeight: 0,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '16px 20px',
      }}
    >
      <div
        style={{
          backgroundColor: tokens.colors.bgSurface,
          borderRadius: tokens.radii.card,
          padding: '28px 20px',
          boxShadow: tokens.shadows.card,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '16px',
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
            Your name, and the city you are in
          </p>
        </div>

        {error && (
          <div
            role="alert"
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
              htmlFor="first-name"
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
              id="first-name"
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

          {/* Country → state → city, and the timezone that place implies. */}
          <LocationFields
            value={location}
            onChange={setLocation}
            onUnavailable={() => setPlacesAvailable(false)}
            geo={geo}
            idPrefix="onboarding"
            disabled={loading}
          />

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

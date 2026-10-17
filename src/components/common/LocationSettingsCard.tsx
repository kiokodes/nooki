import React, { useState } from 'react';
import { MapPin, PencilLine, Store, X } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { updateMyLocation } from '../../lib/authService';
import { LocationFields } from './LocationFields';
import type { GeoSource } from '../../lib/geo/placeData';
import { describePlace, draftFromProfile, validateLocationInput } from '../../lib/geo/location';
import type { LocationDraft } from '../../lib/geo/location';
import { resolveMarketCities } from '../../lib/geo/marketplace';
import type { Profile } from '../../types/database';

interface LocationSettingsCardProps {
  /** This phone's person: the location being edited is theirs alone. */
  profile: Profile;
  /** The partner, whose city is the one the marketplace will open on. */
  partner: Profile | null;
  /** Called with the saved row, so the header's clock updates without reloading the app. */
  onSaved: (profile: Profile) => void;
  /** Where the place data comes from; tests hand in a small world instead of the network. */
  geo?: GeoSource;
}

/**
 * "Update location" — the one place a saved city can change.
 *
 * People move, and the reason a couple is on Nooki moves with them: going abroad for
 * school is what made them long-distance, coming home to the same country is not what makes
 * them stop using it. They are still in two cities, or still two hours apart, or still
 * sending each other things. So the place is a setting and not a signup detail — each
 * partner edits their own, and the other's clock and marketplace city follow at once.
 *
 * It is also where the marketplace scaffolding becomes visible: the line under the two
 * places says which city a gift would open on (`resolveMarketCities`), which is the
 * partner's, and what is missing when they have not added theirs yet. Nothing is for sale
 * here yet; this is the seam it will plug into.
 */
export const LocationSettingsCard: React.FC<LocationSettingsCardProps> = ({
  profile,
  partner,
  onSaved,
  geo,
}) => {
  const [draft, setDraft] = useState<LocationDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const partnerName = partner?.name?.trim() || 'Your partner';
  const market = resolveMarketCities(profile, partner);
  const yours = describePlace({
    cityName: profile.city_name,
    stateName: profile.state_name,
    countryName: profile.country_name,
  });
  const theirs = describePlace({
    cityName: partner?.city_name,
    stateName: partner?.state_name,
    countryName: partner?.country_name,
  });

  const openEditor = () => {
    setError(null);
    setSaved(false);
    setDraft(draftFromProfile(profile));
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateMyLocation(profile.id, validateLocationInput(draft));
      setDraft(null);
      setSaved(true);
      onSaved(updated);
    } catch (err: any) {
      setError(err?.message || 'Your location could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-location-card
      data-location-editing={draft ? 'true' : 'false'}
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
        <MapPin size={15} color={tokens.colors.accentSageDeep} />
        <span style={{ fontSize: '0.86rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
          Where you both are
        </span>
      </div>

      <p style={{ fontSize: '0.76rem', color: tokens.colors.textSecondary, margin: 0, lineHeight: 1.5 }}>
        Your city keeps {partnerName}’s clock right — a country the size of the United States
        spans 29 timezones, so the place settles it rather than a guess. Moved, or away for a
        while? Update it and their header changes with you.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <span
          data-location-yours
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 10px',
            borderRadius: tokens.radii.sm,
            backgroundColor: yours ? tokens.colors.primaryGreenSoft : tokens.colors.bgSurface,
            border: `1px solid ${tokens.colors.borderSubtle}`,
            fontSize: '0.76rem',
            fontWeight: 700,
            color: yours ? tokens.colors.primaryGreenDeep : tokens.colors.textMuted,
          }}
        >
          <span style={{ minWidth: 0 }}>You: {yours || 'not added yet'}</span>
        </span>
        <span
          data-location-partner
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 10px',
            borderRadius: tokens.radii.sm,
            backgroundColor: theirs ? tokens.colors.primaryPinkSoft : tokens.colors.bgSurface,
            border: `1px solid ${tokens.colors.borderSubtle}`,
            fontSize: '0.76rem',
            fontWeight: 700,
            color: theirs ? tokens.colors.primaryPinkDeep : tokens.colors.textMuted,
          }}
        >
          <span style={{ minWidth: 0 }}>{partnerName}: {theirs || 'not added yet'}</span>
        </span>
      </div>

      {/* The marketplace scaffolding, in one line: which city a gift would open on. */}
      <span
        data-location-market
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '6px',
          fontSize: '0.72rem',
          lineHeight: 1.45,
          color: market.ready ? tokens.colors.textSecondary : tokens.colors.textMuted,
        }}
      >
        <Store size={13} style={{ flexShrink: 0, marginTop: '1px' }} aria-hidden="true" />
        <span>
          {market.ready
            ? `The marketplace, when it arrives, opens on ${market.defaultCity?.name} — ${partnerName}’s city — and you can switch to ${market.cities.length > 1 ? 'the others you have saved' : 'another city'} for the weeks they are away.`
            : market.notice}
        </span>
      </span>

      {draft ? (
        <div data-location-form style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '2px' }}>
          <LocationFields
            value={draft}
            onChange={setDraft}
            geo={geo}
            idPrefix="settings"
            disabled={saving}
          />
          {error && (
            <span role="alert" style={{ fontSize: '0.76rem', color: '#B91C1C', fontWeight: 700 }}>
              {error}
            </span>
          )}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              data-location-save
              disabled={saving}
              onClick={() => { void handleSave(); }}
              style={{
                flex: 1,
                padding: '10px',
                borderRadius: tokens.radii.pill,
                backgroundColor: tokens.colors.primaryPink,
                color: tokens.colors.textWhite,
                border: 'none',
                fontSize: '0.8rem',
                fontWeight: 700,
                fontFamily: tokens.typography.fontFamily,
                cursor: saving ? 'not-allowed' : 'pointer',
                opacity: saving ? 0.6 : 1,
              }}
            >
              {saving ? 'Saving…' : 'Save location'}
            </button>
            <button
              type="button"
              aria-label="Cancel editing your location"
              disabled={saving}
              onClick={() => { setDraft(null); setError(null); }}
              style={{
                padding: '10px 14px',
                borderRadius: tokens.radii.pill,
                backgroundColor: tokens.colors.bgSurface,
                color: tokens.colors.textSecondary,
                border: `1px solid ${tokens.colors.borderSubtle}`,
                fontSize: '0.8rem',
                fontWeight: 700,
                fontFamily: tokens.typography.fontFamily,
                cursor: saving ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            type="button"
            data-location-edit
            onClick={openEditor}
            style={{
              padding: '9px 16px',
              borderRadius: tokens.radii.pill,
              backgroundColor: tokens.colors.bgSurface,
              border: `1px solid ${tokens.colors.borderSubtle}`,
              color: tokens.colors.textSecondary,
              fontSize: '0.78rem',
              fontWeight: 700,
              fontFamily: tokens.typography.fontFamily,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
            }}
          >
            <PencilLine size={13} />
            <span>Update location</span>
          </button>
          {saved && (
            <span role="status" style={{ fontSize: '0.74rem', fontWeight: 700, color: tokens.colors.primaryGreenDeep }}>
              Saved
            </span>
          )}
        </div>
      )}
    </div>
  );
};

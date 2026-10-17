import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, MapPin } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { geoSource as defaultGeoSource } from '../../lib/geo/placeData';
import type { GeoCountry, GeoCountryDataset, GeoSource } from '../../lib/geo/placeData';
import { deriveTimezone, isCompleteSelection, normalizePlaceName, stateBucket } from '../../lib/geo/location';
import type { LocationDraft } from '../../lib/geo/location';
import { formatTimezoneOffset, getDetectedTimezone, getTimezones } from '../../lib/timezones';

interface LocationFieldsProps {
  /** The working copy of this person's place. Every change is reported upward. */
  value: LocationDraft;
  onChange: (next: LocationDraft) => void;
  /** Where the place data comes from; tests hand it a three-country world instead of the network. */
  geo?: GeoSource;
  /** Id prefix, so onboarding and the settings sheet can each mount one. */
  idPrefix?: string;
  disabled?: boolean;
  /**
   * Called once if the country index itself cannot be fetched, when the fields are about to
   * become a plain timezone picker. The caller needs to know: with no country there is no
   * code to key a place by, so it must save no location rather than wait for a city that
   * the form is no longer asking for.
   */
  onUnavailable?: () => void;
}

/** The place a draft currently describes, so a manual timezone knows which place it belongs to. */
function placeKeyOf(value: LocationDraft): string {
  return [value.countryCode, value.stateCode ?? value.stateName ?? '', normalizePlaceName(value.cityName)].join('|');
}

/**
 * Country → state → city, and the timezone that place implies.
 *
 * One component, two callers: signup (where the place is collected for the first time) and
 * Couple Settings → Update location (where a partner who moved — or who is somewhere else
 * for a while — changes it). Both need the same three answers for the same two reasons:
 * the clock in the header, and the city the marketplace will open on.
 *
 * The timezone is derived rather than asked. Choosing Nigeria settles Africa/Lagos without
 * another question, because 219 of 250 countries have exactly one zone; choosing the
 * United States does not, so the state settles it (Idaho → America/Boise) and the city
 * corrects the states that straddle two (Gary, Indiana → America/Chicago). "Change" is
 * always there: a derived zone is a good guess, and a person knows better. A zone picked
 * by hand stays put until the place it was picked for changes.
 *
 * It degrades in two steps instead of breaking. If one country's file cannot be fetched,
 * that country's state and city become typed fields — the country code is still known, so
 * the place still gets its key. If the country index itself cannot be fetched there is
 * nothing to key a place by, so only the timezone picker Nooki always had is left, and the
 * caller is told to save no location rather than half of one.
 */
export const LocationFields: React.FC<LocationFieldsProps> = ({
  value,
  onChange,
  geo = defaultGeoSource,
  idPrefix = 'location',
  disabled = false,
  onUnavailable,
}) => {
  const [countries, setCountries] = useState<GeoCountry[] | null>(null);
  const [countriesFailed, setCountriesFailed] = useState(false);
  const [dataset, setDataset] = useState<GeoCountryDataset | null>(null);
  // The country whose file did not arrive, rather than a boolean that would have to be
  // cleared on every change of country (and clearing it in an effect is a second render
  // for nothing): a failure belongs to the request that failed.
  const [failedCountry, setFailedCountry] = useState<string | null>(null);
  // Which place the zone was chosen by hand for; null while it is still being derived. A
  // draft that arrives describing a whole place with a zone already on it (the settings
  // sheet, editing what was saved) counts as chosen, so opening the form never rewrites a
  // zone somebody picked deliberately. A blank form does not: its detected timezone belongs
  // to no place yet, and the first country chosen is allowed to improve on it.
  const [overrideFor, setOverrideFor] = useState<string | null>(
    () => (value.timezone && isCompleteSelection(value) ? placeKeyOf(value) : null),
  );

  // Requests belong to whichever country is selected now: a slow answer for a country that
  // has already been changed must not land on the one on screen.
  const requestRef = useRef(0);
  // Read through a ref so the derivation effect below can fire on the arrival of data
  // without re-running (and re-writing) on every keystroke in the city field.
  const latest = useRef({ value, onChange, onUnavailable });
  useEffect(() => { latest.current = { value, onChange, onUnavailable }; });

  const { countryCode, stateCode, stateName, cityName, timezone } = value;
  // Whether anything is still on its way is read off the data rather than tracked: the
  // index has arrived when there is an index, and a country has arrived when the dataset on
  // screen is that country's. Nothing here needs a render of its own.
  const countriesBusy = !countries && !countriesFailed;
  const datasetFailed = Boolean(countryCode) && failedCountry === countryCode;
  const countryBusy = Boolean(countryCode) && !countriesFailed && !datasetFailed && dataset?.code !== countryCode;
  const country = useMemo(
    () => countries?.find((item) => item.code === countryCode) ?? null,
    [countries, countryCode],
  );
  const derivation = useMemo(
    () => deriveTimezone(country, dataset, { stateCode, cityName }),
    [country, dataset, stateCode, cityName],
  );
  const overridden = overrideFor === placeKeyOf(value);

  // The index first: the country picker is the first field, and its zones already settle
  // the clock for most of the world.
  useEffect(() => {
    let cancelled = false;
    geo.countries()
      .then((loaded) => { if (!cancelled) { setCountries(loaded); setCountriesFailed(false); } })
      .catch(() => {
        if (cancelled) return;
        setCountriesFailed(true);
        latest.current.onUnavailable?.();
      });
    return () => { cancelled = true; };
  }, [geo]);

  // Then one country's states and cities, and only when that country is chosen.
  useEffect(() => {
    if (!countryCode || countriesFailed) return;
    const request = ++requestRef.current;
    let cancelled = false;
    geo.country(countryCode)
      .then((loaded) => {
        if (cancelled || request !== requestRef.current) return;
        // A file that is not the country asked for is a failed load, not an empty one:
        // otherwise the picker would say "loading" for a list that is never coming.
        if (loaded.code === countryCode) setDataset(loaded);
        else setFailedCountry(countryCode);
      })
      .catch(() => {
        if (cancelled || request !== requestRef.current) return;
        setDataset(null);
        setFailedCountry(countryCode);
      });
    return () => { cancelled = true; };
  }, [countryCode, countriesFailed, geo]);

  // Keep the stored zone in step with the place, unless that place carries a hand-picked one.
  useEffect(() => {
    if (!derivation.timezone) return;
    const { value: current, onChange: emit } = latest.current;
    if (overrideFor === placeKeyOf(current)) return;
    if (current.timezone === derivation.timezone) return;
    emit({ ...current, timezone: derivation.timezone });
  }, [derivation.timezone, overrideFor]);

  /** A change of place: the zone follows the new one unless it was picked by hand for it. */
  const update = useCallback((patch: Partial<LocationDraft>) => {
    onChange({ ...latest.current.value, ...patch });
  }, [onChange]);

  const chooseCountry = (code: string) => {
    const picked = countries?.find((item) => item.code === code) ?? null;
    setDataset(null);
    update({
      countryCode: code,
      countryName: picked?.name ?? '',
      stateCode: null,
      stateName: null,
      cityName: '',
    });
  };

  const chooseState = (key: string) => {
    const picked = dataset?.states.find((state) => (state.code || state.name) === key) ?? null;
    update({
      stateCode: picked?.code || null,
      stateName: picked?.name || normalizePlaceName(key) || null,
      cityName: '',
    });
  };

  const chooseTimezone = (zone: string) => {
    setOverrideFor(placeKeyOf(latest.current.value));
    onChange({ ...latest.current.value, timezone: zone });
  };

  const states = dataset?.states ?? [];
  const stateKey = stateCode || stateName || '';
  // The bucket the cities are filed under: the chosen state's code, or '' — which is where
  // a country with no subdivisions keeps its cities, and where the data puts a city it
  // could not attach to one.
  const cityOptions = dataset && !datasetFailed ? dataset.cities[stateBucket(dataset, stateCode)] ?? [] : [];
  const typingCities = cityOptions.length === 0;

  const zoneLabel = formatTimezoneOffset(timezone);
  const zoneChoices = useMemo(() => {
    const fromCountry = country?.zones ?? dataset?.zones ?? [];
    // This country's own zones first: "which of these 29" beats "which of the world's 400".
    return fromCountry.length > 1
      ? [...new Set([...fromCountry, timezone, getDetectedTimezone()].filter(Boolean))].sort()
      : getTimezones(timezone || getDetectedTimezone());
  }, [country, dataset, timezone]);

  const source = overridden ? 'override' : derivation.source;

  const fieldStyle: React.CSSProperties = {
    width: '100%',
    padding: '12px 16px',
    borderRadius: tokens.radii.pill,
    border: `1.5px solid ${tokens.colors.borderSubtle}`,
    backgroundColor: tokens.colors.bgSurfaceSubtle,
    fontSize: '0.88rem',
    fontFamily: tokens.typography.fontFamily,
    color: tokens.colors.textPrimary,
    outline: 'none',
  };
  const labelStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '0.8rem',
    fontWeight: 700,
    color: tokens.colors.textSecondary,
    marginBottom: '6px',
  };

  // No index, so nothing to key a place by: the timezone alone, as Nooki had it before.
  if (countriesFailed) {
    return (
      <div data-location-fields data-location-mode="timezone-only" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div>
          <label htmlFor={`${idPrefix}-timezone`} style={labelStyle}>
            <MapPin size={14} />
            <span>Timezone</span>
          </label>
          <select
            id={`${idPrefix}-timezone`}
            data-location-timezone
            required
            disabled={disabled}
            value={timezone}
            onChange={(event) => chooseTimezone(event.target.value)}
            style={fieldStyle}
          >
            {getTimezones(timezone || getDetectedTimezone()).map((zone) => (
              <option key={zone} value={zone}>{zone.replace(/_/g, ' ')}</option>
            ))}
          </select>
          <span style={hintStyle}>
            The place list could not be loaded, so choose your timezone — it is what Nooki
            uses to work out how far apart the two of you are.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-location-fields
      data-location-mode={datasetFailed ? 'typed' : 'picker'}
      data-location-zone-source={source}
      style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}
    >
      <div>
        <label htmlFor={`${idPrefix}-country`} style={labelStyle}>
          <MapPin size={14} />
          <span>Country</span>
        </label>
        <select
          id={`${idPrefix}-country`}
          data-location-country
          required
          disabled={disabled || countriesBusy}
          value={countryCode}
          onChange={(event) => chooseCountry(event.target.value)}
          style={fieldStyle}
        >
          <option value="">{countriesBusy ? 'Loading countries…' : 'Choose your country'}</option>
          {(countries ?? []).map((item) => (
            <option key={item.code} value={item.code}>
              {item.flag ? `${item.flag}  ${item.name}` : item.name}
            </option>
          ))}
        </select>
        {countryCode && !datasetFailed && (
          <span style={hintStyle}>
            {countryBusy
              ? 'Loading the places in it…'
              : 'Where you are: it settles your partner’s clock, and it is the city gifts get sent to.'}
          </span>
        )}
      </div>

      {/* A picker where the data has subdivisions, a typed field for the 53 countries it
          does not, and a typed field whenever this country's file did not arrive. */}
      <div>
        <label htmlFor={`${idPrefix}-state`} style={labelStyle}>
          <span>State / Region</span>
        </label>
        {states.length > 0 && !datasetFailed ? (
          <select
            id={`${idPrefix}-state`}
            data-location-state
            disabled={disabled}
            value={stateKey}
            onChange={(event) => chooseState(event.target.value)}
            style={fieldStyle}
          >
            <option value="">{countryBusy ? 'Loading states…' : 'Choose your state'}</option>
            {states.map((state) => (
              <option key={state.code || state.name} value={state.code || state.name}>{state.name}</option>
            ))}
          </select>
        ) : (
          <input
            id={`${idPrefix}-state`}
            data-location-state
            type="text"
            disabled={disabled || !countryCode}
            value={stateName ?? ''}
            placeholder={countryCode ? 'e.g. Rivers' : 'Choose a country first'}
            onChange={(event) => update({ stateCode: null, stateName: event.target.value })}
            style={fieldStyle}
          />
        )}
      </div>

      {/* A datalist rather than a select: one state can hold a thousand cities, and the
          town somebody actually lives in is not always in the data — typing it is as good
          an answer as picking it. */}
      <div>
        <label htmlFor={`${idPrefix}-city`} style={labelStyle}>
          <span>City</span>
        </label>
        <input
          id={`${idPrefix}-city`}
          data-location-city
          type="text"
          required
          autoComplete="off"
          list={typingCities ? undefined : `${idPrefix}-city-options`}
          disabled={disabled || !countryCode}
          value={cityName}
          placeholder={countryCode ? (typingCities ? 'Type your city' : 'Choose or type your city') : 'Choose a country first'}
          onChange={(event) => update({ cityName: event.target.value })}
          style={fieldStyle}
        />
        {!typingCities && (
          <datalist id={`${idPrefix}-city-options`}>
            {cityOptions.map((city) => <option key={city} value={city} />)}
          </datalist>
        )}
        {datasetFailed && countryCode && (
          <span style={hintStyle}>This country’s place list did not load, so type your state and city.</span>
        )}
      </div>

      {/* The zone, said out loud with its offset and where it came from, so it can be
          checked at a glance and corrected in one tap. */}
      <div
        data-location-timezone-row
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
          padding: '10px 14px',
          borderRadius: tokens.radii.md,
          backgroundColor: tokens.colors.primaryGreenSoft,
          border: `1px solid ${tokens.colors.borderSubtle}`,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <span
            data-location-timezone-label
            style={{ fontSize: '0.78rem', fontWeight: 800, color: tokens.colors.primaryGreenDeep, display: 'block' }}
          >
            {timezone ? `${timezone.replace(/_/g, ' ')}${zoneLabel ? ` · ${zoneLabel}` : ''}` : 'Timezone not set'}
          </span>
          <span style={{ fontSize: '0.7rem', color: tokens.colors.textSecondary }} data-location-timezone-source>
            {overridden ? 'You chose this'
              : derivation.source === 'city' ? 'From your city'
                : derivation.source === 'state' ? 'From your state'
                  : derivation.source === 'country' ? 'From your country'
                    : derivation.ambiguous ? 'Choose your state to settle this'
                      : countryBusy || countriesBusy ? 'Working it out…'
                        : 'Choose your country'}
          </span>
        </div>
        <select
          id={`${idPrefix}-timezone`}
          data-location-timezone
          aria-label="Change timezone"
          disabled={disabled}
          value={timezone}
          onChange={(event) => chooseTimezone(event.target.value)}
          style={{ ...fieldStyle, width: 'auto', maxWidth: '46%', padding: '8px 10px', fontSize: '0.74rem' }}
        >
          {timezone && !zoneChoices.includes(timezone) && (
            <option value={timezone}>{timezone.replace(/_/g, ' ')}</option>
          )}
          {zoneChoices.map((zone) => (
            <option key={zone} value={zone}>{zone.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </div>

      {(countriesBusy || countryBusy) && (
        <span
          data-location-loading
          style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.72rem', color: tokens.colors.textMuted }}
        >
          <Loader2 size={12} className="nooki-spin" aria-hidden="true" />
          Loading places…
        </span>
      )}
    </div>
  );
};

const hintStyle: React.CSSProperties = {
  fontSize: '0.72rem',
  color: tokens.colors.textMuted,
  marginTop: '4px',
  display: 'block',
  lineHeight: 1.45,
};

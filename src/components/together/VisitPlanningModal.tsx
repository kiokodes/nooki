import React, { useState, useEffect } from 'react';
import {
  Calendar,
  Clock,
  MapPin,
  Check,
  X,
  AlertCircle,
} from 'lucide-react';
import { tokens } from '../../tokens/designTokens';

interface VisitPlanningModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (startDate: string, endDate: string | null, location: string | null, timezone: string | null, isTentative: boolean) => Promise<void>;
  /**
   * Take the existing visit off the calendar entirely — plans change. Only shown
   * while editing an existing visit; someday ideas pinned to it keep their place
   * on the someday list (the database unlinks them rather than deleting them).
   */
  onClearVisit?: () => Promise<void>;
  existingVisit?: {
    id: string;
    start_date: string;
    end_date: string | null;
    location: string | null;
    timezone: string | null;
    is_tentative: boolean;
  } | null;
  userTimezone: string;
  partnerName: string;
}

export const VisitPlanningModal: React.FC<VisitPlanningModalProps> = ({
  isOpen,
  onClose,
  onSave,
  onClearVisit,
  existingVisit,
  userTimezone,
  partnerName,
}) => {
  const [startDate, setStartDate] = useState(existingVisit?.start_date || '');
  const [endDate, setEndDate] = useState(existingVisit?.end_date || '');
  const [location, setLocation] = useState(existingVisit?.location || '');
  const [timezone, setTimezone] = useState(existingVisit?.timezone || userTimezone);
  const [isTentative, setIsTentative] = useState(existingVisit?.is_tentative || false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Clearing a visit is two steps: ask once, in place, before anything is removed.
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  // Reset form when modal opens with no existing visit
  useEffect(() => {
    if (isOpen && !existingVisit) {
      setStartDate('');
      setEndDate('');
      setLocation('');
      setTimezone(userTimezone);
      setIsTentative(false);
      setError(null);
    }
    if (isOpen) setConfirmingClear(false);
  }, [isOpen, existingVisit, userTimezone]);

  // Populate form when existing visit changes
  useEffect(() => {
    if (existingVisit) {
      setStartDate(existingVisit.start_date);
      setEndDate(existingVisit.end_date || '');
      setLocation(existingVisit.location || '');
      setTimezone(existingVisit.timezone || userTimezone);
      setIsTentative(existingVisit.is_tentative);
    }
  }, [existingVisit, userTimezone]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!startDate) {
      setError('Please select a start date');
      return;
    }

    try {
      setSaving(true);
      await onSave(
        startDate,
        endDate || null,
        location || null,
        timezone || null,
        isTentative,
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save visit');
    } finally {
      setSaving(false);
    }
  };

  const handleClearVisit = async () => {
    if (!onClearVisit || clearing) return;
    setError(null);
    try {
      setClearing(true);
      await onClearVisit();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This visit could not be cleared');
    } finally {
      setClearing(false);
      setConfirmingClear(false);
    }
  };

  if (!isOpen) return null;

  // Format date for display
  const formatDate = (dateString: string) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        zIndex: 1000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          backgroundColor: tokens.colors.bgCanvas,
          borderRadius: tokens.radii.card,
          width: '100%',
          maxWidth: '400px',
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: tokens.shadows.modal,
        }}
      >
        {/* Header */}
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '18px 20px',
            borderBottom: `1px solid ${tokens.colors.borderSubtle}`,
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: '1.25rem',
              fontWeight: 800,
              color: tokens.colors.textPrimary,
            }}
          >
            {existingVisit ? 'Edit visit' : 'Plan a visit'}
          </h1>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: tokens.colors.textMuted,
              cursor: 'pointer',
              padding: '4px',
            }}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </header>

        <form onSubmit={handleSubmit}>
          <main style={{ padding: '20px' }}>
            {error && (
              <div
                role="alert"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '12px 14px',
                  borderRadius: tokens.radii.md,
                  backgroundColor: tokens.colors.primaryPinkSoft,
                  color: tokens.colors.primaryPinkDeep,
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  marginBottom: '16px',
                }}
              >
                <AlertCircle size={16} aria-hidden="true" />
                {error}
              </div>
            )}

            {/* Start Date */}
            <div style={{ marginBottom: '16px' }}>
              <label
                htmlFor="startDate"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '0.82rem',
                  fontWeight: 700,
                  color: tokens.colors.textPrimary,
                  marginBottom: '6px',
                }}
              >
                <Calendar size={16} />
                Arrival date
              </label>
              <input
                type="date"
                id="startDate"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: tokens.radii.md,
                  border: `1px solid ${tokens.colors.borderSoft}`,
                  backgroundColor: tokens.colors.bgSurface,
                  fontSize: '0.9rem',
                  fontFamily: tokens.typography.fontFamily,
                  color: tokens.colors.textPrimary,
                }}
              />
            </div>

            {/* End Date */}
            <div style={{ marginBottom: '16px' }}>
              <label
                htmlFor="endDate"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '0.82rem',
                  fontWeight: 700,
                  color: tokens.colors.textPrimary,
                  marginBottom: '6px',
                }}
              >
                <Calendar size={16} />
                Departure date (optional)
              </label>
              <input
                type="date"
                id="endDate"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: tokens.radii.md,
                  border: `1px solid ${tokens.colors.borderSoft}`,
                  backgroundColor: tokens.colors.bgSurface,
                  fontSize: '0.9rem',
                  fontFamily: tokens.typography.fontFamily,
                  color: tokens.colors.textPrimary,
                }}
              />
            </div>

            {/* Location */}
            <div style={{ marginBottom: '16px' }}>
              <label
                htmlFor="location"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '0.82rem',
                  fontWeight: 700,
                  color: tokens.colors.textPrimary,
                  marginBottom: '6px',
                }}
              >
                <MapPin size={16} />
                Location (optional)
              </label>
              <input
                type="text"
                id="location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder={`e.g., "${partnerName}'s place" or "Lagos, Nigeria"`}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: tokens.radii.md,
                  border: `1px solid ${tokens.colors.borderSoft}`,
                  backgroundColor: tokens.colors.bgSurface,
                  fontSize: '0.9rem',
                  fontFamily: tokens.typography.fontFamily,
                  color: tokens.colors.textPrimary,
                }}
              />
            </div>

            {/* Timezone */}
            <div style={{ marginBottom: '20px' }}>
              <label
                htmlFor="timezone"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '0.82rem',
                  fontWeight: 700,
                  color: tokens.colors.textPrimary,
                  marginBottom: '6px',
                }}
              >
                <Clock size={16} />
                Timezone
              </label>
              <select
                id="timezone"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: tokens.radii.md,
                  border: `1px solid ${tokens.colors.borderSoft}`,
                  backgroundColor: tokens.colors.bgSurface,
                  fontSize: '0.9rem',
                  fontFamily: tokens.typography.fontFamily,
                  color: tokens.colors.textPrimary,
                }}
              >
                <option value="">Select timezone...</option>
                {getTimezoneOptions().map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Tentative toggle */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '14px 16px',
                borderRadius: tokens.radii.md,
                backgroundColor: tokens.colors.bgSurface,
                marginBottom: '20px',
              }}
            >
              <input
                type="checkbox"
                id="isTentative"
                checked={isTentative}
                onChange={(e) => setIsTentative(e.target.checked)}
                style={{
                  width: '18px',
                  height: '18px',
                  accentColor: tokens.colors.primaryPinkDeep,
                }}
              />
              <label
                htmlFor="isTentative"
                style={{
                  fontSize: '0.86rem',
                  color: tokens.colors.textSecondary,
                  cursor: 'pointer',
                }}
              >
                This is a hopeful plan (not confirmed yet)
              </label>
            </div>

            {/* Preview */}
            {startDate && (
              <div
                style={{
                  padding: '14px 16px',
                  borderRadius: tokens.radii.md,
                  backgroundColor: tokens.colors.primaryPinkSoft,
                  marginBottom: '20px',
                }}
              >
                <p
                  style={{
                    margin: 0,
                    fontSize: '0.82rem',
                    color: tokens.colors.primaryPinkDeep,
                    fontWeight: 600,
                  }}
                >
                  Preview:
                </p>
                <p
                  style={{
                    margin: '6px 0 0',
                    fontSize: '0.95rem',
                    color: tokens.colors.primaryPinkDeep,
                    fontWeight: 800,
                  }}
                >
                  {isTentative ? 'Our hopeful plan' : `Visit with ${partnerName}`}
                  {location && ` in ${location}`}
                </p>
                <p
                  style={{
                    margin: '4px 0 0',
                    fontSize: '0.8rem',
                    color: tokens.colors.primaryPinkDeep,
                    opacity: 0.8,
                  }}
                >
                  {formatDate(startDate)} {endDate && `– ${formatDate(endDate)}`}
                </p>
              </div>
            )}
            {/* Plans change: an existing visit can come off the calendar altogether */}
            {existingVisit && onClearVisit && (
              <div
                data-clear-visit-section
                style={{
                  borderTop: `1px solid ${tokens.colors.borderSubtle}`,
                  paddingTop: '16px',
                }}
              >
                <p
                  style={{
                    margin: 0,
                    fontSize: '0.86rem',
                    fontWeight: 700,
                    color: tokens.colors.textPrimary,
                  }}
                >
                  Plans changed?
                </p>
                <p
                  style={{
                    margin: '5px 0 12px',
                    fontSize: '0.78rem',
                    lineHeight: 1.5,
                    color: tokens.colors.textSecondary,
                  }}
                >
                  Take this visit off the calendar — no hard feelings. Any someday ideas
                  pinned to it go back to your someday list.
                </p>
                {confirmingClear ? (
                  <div data-clear-visit-confirm style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: 700, color: tokens.colors.primaryPinkDeep }}>
                      Clear this visit for both of you?
                    </span>
                    <button
                      type="button"
                      data-confirm-clear-visit
                      disabled={clearing}
                      onClick={() => { void handleClearVisit(); }}
                      style={{
                        padding: '9px 16px',
                        borderRadius: tokens.radii.pill,
                        border: 'none',
                        backgroundColor: tokens.colors.primaryPinkDeep,
                        color: tokens.colors.textWhite,
                        fontSize: '0.8rem',
                        fontWeight: 700,
                        fontFamily: tokens.typography.fontFamily,
                        cursor: clearing ? 'default' : 'pointer',
                        opacity: clearing ? 0.6 : 1,
                      }}
                    >
                      {clearing ? 'Clearing…' : 'Yes, clear it'}
                    </button>
                    <button
                      type="button"
                      data-keep-visit
                      disabled={clearing}
                      onClick={() => setConfirmingClear(false)}
                      style={{
                        padding: '9px 16px',
                        borderRadius: tokens.radii.pill,
                        border: `1.5px solid ${tokens.colors.borderSoft}`,
                        backgroundColor: tokens.colors.bgSurface,
                        color: tokens.colors.textSecondary,
                        fontSize: '0.8rem',
                        fontWeight: 700,
                        fontFamily: tokens.typography.fontFamily,
                        cursor: 'pointer',
                      }}
                    >
                      Keep it
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    data-clear-visit
                    onClick={() => { setError(null); setConfirmingClear(true); }}
                    style={{
                      padding: '9px 16px',
                      borderRadius: tokens.radii.pill,
                      border: `1.5px solid ${tokens.colors.primaryPink}`,
                      backgroundColor: tokens.colors.bgSurface,
                      color: tokens.colors.primaryPinkDeep,
                      fontSize: '0.8rem',
                      fontWeight: 700,
                      fontFamily: tokens.typography.fontFamily,
                      cursor: 'pointer',
                    }}
                  >
                    Clear this visit
                  </button>
                )}
              </div>
            )}
          </main>

          {/* Footer with buttons */}
          <footer
            style={{
              display: 'flex',
              gap: '10px',
              padding: '16px 20px',
              borderTop: `1px solid ${tokens.colors.borderSubtle}`,
              justifyContent: 'flex-end',
            }}
          >
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '12px 24px',
                borderRadius: tokens.radii.pill,
                border: `1.5px solid ${tokens.colors.borderSoft}`,
                backgroundColor: tokens.colors.bgSurface,
                color: tokens.colors.textSecondary,
                fontSize: '0.88rem',
                fontWeight: 700,
                fontFamily: tokens.typography.fontFamily,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !startDate}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '12px 24px',
                borderRadius: tokens.radii.pill,
                border: 'none',
                backgroundColor: saving
                  ? tokens.colors.primaryPink
                  : tokens.colors.primaryPinkDeep,
                color: tokens.colors.textWhite,
                fontSize: '0.88rem',
                fontWeight: 700,
                fontFamily: tokens.typography.fontFamily,
                cursor: saving || !startDate ? 'default' : 'pointer',
                opacity: saving || !startDate ? 0.6 : 1,
              }}
            >
              {saving ? (
                <>
                  <div
                    style={{
                      width: '16px',
                      height: '16px',
                      border: '2px solid rgba(255,255,255,0.3)',
                      borderTopColor: 'transparent',
                      borderRadius: '50%',
                      animation: 'spin 0.8s linear infinite',
                    }}
                  />
                  Saving...
                </>
              ) : (
                <>
                  <Check size={16} />
                  {existingVisit ? 'Save changes' : 'Plan visit'}
                </>
              )}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};

// Helper function to get timezone options
function getTimezoneOptions() {
  return [
    { value: 'UTC', label: 'UTC' },
    { value: 'Africa/Lagos', label: 'Lagos (West Africa Time)' },
    { value: 'Africa/Accra', label: 'Accra (Ghana)' },
    { value: 'Africa/Abidjan', label: 'Abidjan (Côte d\'Ivoire)' },
    { value: 'Europe/London', label: 'London (GMT)' },
    { value: 'Europe/Paris', label: 'Paris (CET)' },
    { value: 'America/New_York', label: 'New York (EST)' },
    { value: 'America/Los_Angeles', label: 'Los Angeles (PST)' },
    { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
    { value: 'Asia/Shanghai', label: 'Shanghai (CST)' },
    { value: 'Asia/Kolkata', label: 'Mumbai (IST)' },
    { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
  ];
}

import { useCallback, useEffect, useState } from 'react';
import {
  createCoupleEvent,
  deleteCoupleEvent,
  fetchCoupleEvents,
  updateCoupleEvent,
  type CoupleEventInput,
} from '../lib/authService';
import type { CoupleEvent } from '../types/database';

interface UseCoupleEventsOptions {
  coupleId: string | null;
  userId: string | null;
}

export interface CoupleEventsState {
  events: CoupleEvent[];
  loading: boolean;
  error: string | null;
  saving: boolean;
  refresh: () => Promise<void>;
  addEvent: (input: CoupleEventInput) => Promise<void>;
  editEvent: (eventId: string, input: CoupleEventInput) => Promise<void>;
  removeEvent: (eventId: string) => Promise<void>;
  clearError: () => void;
}

interface LoadedEvents {
  /** Which couple these events belong to, so another couple's dates can never flash up. */
  coupleId: string;
  items: CoupleEvent[];
}

const byDate = (a: CoupleEvent, b: CoupleEvent) => a.event_date.localeCompare(b.event_date);

/**
 * One source of truth for the couple's calendar, shared by the Today card and the
 * calendar modal so both always show the same events.
 */
export function useCoupleEvents({ coupleId, userId }: UseCoupleEventsOptions): CoupleEventsState {
  const [loaded, setLoaded] = useState<LoadedEvents | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const events = loaded && loaded.coupleId === coupleId ? loaded.items : [];

  const applyItems = useCallback((forCoupleId: string, update: (items: CoupleEvent[]) => CoupleEvent[]) => {
    setLoaded((current) => ({
      coupleId: forCoupleId,
      items: update(current && current.coupleId === forCoupleId ? current.items : []),
    }));
  }, []);

  const load = useCallback(async (): Promise<CoupleEvent[]> => {
    if (!coupleId) return [];
    const fetched = await fetchCoupleEvents(coupleId);
    setLoaded({ coupleId, items: fetched });
    return fetched;
  }, [coupleId]);

  useEffect(() => {
    if (!coupleId) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        await load();
        if (!cancelled) setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Your calendar could not be loaded.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [coupleId, load]);

  const refresh = useCallback(async () => {
    if (!coupleId) return;
    setLoading(true);
    try {
      await load();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your calendar could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [coupleId, load]);

  const addEvent = useCallback(async (input: CoupleEventInput) => {
    if (!coupleId || !userId) throw new Error('Please sign in again to add an event.');
    setSaving(true);
    setError(null);
    try {
      const created = await createCoupleEvent(coupleId, userId, input);
      applyItems(coupleId, (items) => [...items, created].sort(byDate));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This event could not be saved.');
      throw err;
    } finally {
      setSaving(false);
    }
  }, [applyItems, coupleId, userId]);

  const editEvent = useCallback(async (eventId: string, input: CoupleEventInput) => {
    if (!coupleId) throw new Error('Please sign in again to edit an event.');
    setSaving(true);
    setError(null);
    try {
      const updated = await updateCoupleEvent(eventId, input);
      applyItems(coupleId, (items) => items.map((event) => (event.id === eventId ? updated : event)).sort(byDate));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This event could not be updated.');
      throw err;
    } finally {
      setSaving(false);
    }
  }, [applyItems, coupleId]);

  const removeEvent = useCallback(async (eventId: string) => {
    if (!coupleId) throw new Error('Please sign in again to delete an event.');
    setSaving(true);
    setError(null);
    try {
      await deleteCoupleEvent(eventId);
      applyItems(coupleId, (items) => items.filter((event) => event.id !== eventId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This event could not be deleted.');
      throw err;
    } finally {
      setSaving(false);
    }
  }, [applyItems, coupleId]);

  return {
    events,
    loading,
    saving,
    error,
    refresh,
    addEvent,
    editEvent,
    removeEvent,
    clearError: () => setError(null),
  };
}

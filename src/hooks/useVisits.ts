import { useState, useEffect, useCallback } from 'react';
import { requireSupabase } from '../lib/supabaseClient';
import { describeDatabaseError } from '../lib/authService';
import type { Visit } from '../types/database';

interface VisitsState {
  visit: Visit | null;
  visits: Visit[];
  loading: boolean;
  error: string | null;
  saving: boolean;
}

export function useVisits(coupleId: string | null, userId: string | null): VisitsState & {
  planVisit: (startDate: string, endDate: string | null, location: string | null, timezone: string | null, isTentative: boolean) => Promise<void>;
  updateVisit: (visitId: string, updates: Partial<Omit<Visit, 'id' | 'couple_id' | 'created_at' | 'updated_at'>>) => Promise<void>;
  deleteVisit: (visitId: string) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<VisitsState>({
    visit: null,
    visits: [],
    loading: true,
    error: null,
    saving: false,
  });

  const loadVisits = useCallback(async () => {
    if (!coupleId) {
      setState((prev) => ({ ...prev, loading: false, visits: [], visit: null }));
      return;
    }

    try {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      
      const { data, error } = await requireSupabase()
        .from('visits')
        .select('*')
        .eq('couple_id', coupleId)
        .order('start_date', { ascending: true });

      if (error) {
        throw new Error(describeDatabaseError(error));
      }

      const visits = (data as Visit[]) || [];
      
      // Find the next upcoming visit
      const now = new Date();
      const upcomingVisits = visits.filter(v => {
        const startDate = new Date(v.start_date);
        const endDate = v.end_date ? new Date(v.end_date) : null;
        
        // Visit is upcoming if start_date is in the future, or currently happening
        if (!endDate) {
          return startDate >= now;
        }
        return startDate >= now || (startDate <= now && endDate >= now);
      });
      
      const nextVisit = upcomingVisits.length > 0 ? upcomingVisits[0] : null;
      
      setState((prev) => ({
        ...prev,
        loading: false,
        visits,
        visit: nextVisit,
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load visits',
      }));
    }
  }, [coupleId]);

  useEffect(() => {
    void loadVisits();
  }, [loadVisits]);

  // Real-time subscription
  useEffect(() => {
    if (!coupleId) return;

    const supabase = requireSupabase();
    const channel = supabase
      .channel('visits_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'visits',
          filter: `couple_id=eq.${coupleId}`,
        },
        () => {
          void loadVisits();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [coupleId, loadVisits]);

  const planVisit = useCallback(async (startDate: string, endDate: string | null, location: string | null, timezone: string | null, isTentative: boolean) => {
    if (!coupleId) return;

    try {
      setState((prev) => ({ ...prev, saving: true, error: null }));
      
      const { error } = await requireSupabase()
        .from('visits')
        .insert({
          couple_id: coupleId,
          start_date: startDate,
          end_date: endDate,
          location,
          timezone,
          is_tentative: isTentative,
          created_by: userId,
        });

      if (error) {
        throw new Error(describeDatabaseError(error));
      }

      // Refresh the visits
      await loadVisits();
    } catch (err) {
      setState((prev) => ({
        ...prev,
        saving: false,
        error: err instanceof Error ? err.message : 'Failed to plan visit',
      }));
      throw err;
    } finally {
      setState((prev) => ({ ...prev, saving: false }));
    }
  }, [coupleId, userId, loadVisits]);

  const updateVisit = useCallback(async (visitId: string, updates: Partial<Omit<Visit, 'id' | 'couple_id' | 'created_at' | 'updated_at'>>) => {
    if (!coupleId) return;

    try {
      setState((prev) => ({ ...prev, saving: true, error: null }));
      
      const { error } = await requireSupabase()
        .from('visits')
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq('id', visitId);

      if (error) {
        throw new Error(describeDatabaseError(error));
      }

      await loadVisits();
    } catch (err) {
      setState((prev) => ({
        ...prev,
        saving: false,
        error: err instanceof Error ? err.message : 'Failed to update visit',
      }));
      throw err;
    } finally {
      setState((prev) => ({ ...prev, saving: false }));
    }
  }, [coupleId, loadVisits]);

  const deleteVisit = useCallback(async (visitId: string) => {
    if (!coupleId) return;

    try {
      setState((prev) => ({ ...prev, saving: true, error: null }));
      
      const { error } = await requireSupabase()
        .from('visits')
        .delete()
        .eq('id', visitId);

      if (error) {
        throw new Error(describeDatabaseError(error));
      }

      await loadVisits();
    } catch (err) {
      setState((prev) => ({
        ...prev,
        saving: false,
        error: err instanceof Error ? err.message : 'Failed to delete visit',
      }));
      throw err;
    } finally {
      setState((prev) => ({ ...prev, saving: false }));
    }
  }, [coupleId, loadVisits]);

  return {
    ...state,
    planVisit,
    updateVisit,
    deleteVisit,
    refresh: loadVisits,
  };
}

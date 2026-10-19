import { useCallback, useEffect, useState } from 'react';
import { requireSupabase } from '../lib/supabaseClient';
import { describeDatabaseError } from '../lib/authService';
import type { TogetherActivityType, TogetherTimeSession } from '../types/database';

interface TogetherTimeData {
  sessions: TogetherTimeSession[];
  loading: boolean;
  saving: boolean;
  error: string | null;
}

/** Shared date-night schedule. The push sender handles the due-time reminder sweep. */
export function useTogetherTime(coupleId: string | null, userId: string | null) {
  const [state, setState] = useState<TogetherTimeData>({ sessions: [], loading: false, saving: false, error: null });

  const refresh = useCallback(async () => {
    if (!coupleId) {
      setState((current) => ({ ...current, sessions: [], loading: false, error: null }));
      return;
    }
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const { data, error } = await requireSupabase().from('together_time_sessions')
        .select('*').eq('couple_id', coupleId).order('scheduled_at', { ascending: true });
      if (error) throw new Error(describeDatabaseError(error));
      setState((current) => ({ ...current, sessions: (data as TogetherTimeSession[]) || [], loading: false, error: null }));
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : 'Together time could not be loaded.' }));
    }
  }, [coupleId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!coupleId) return;
    const supabase = requireSupabase();
    const channel = supabase.channel('together-time-sessions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'together_time_sessions', filter: `couple_id=eq.${coupleId}` }, () => { void refresh(); })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [coupleId, refresh]);

  const schedule = useCallback(async (input: {
    activityType: TogetherActivityType;
    activityId: string;
    activityName: string;
    scheduledAt: string;
    timezone: string;
  }) => {
    if (!coupleId || !userId) throw new Error('Sign in again to schedule your date.');
    const scheduledMs = new Date(input.scheduledAt).getTime();
    if (!Number.isFinite(scheduledMs) || scheduledMs < Date.now() - 60_000) {
      throw new Error('Pick a time in the future.');
    }
    setState((current) => ({ ...current, saving: true, error: null }));
    try {
      const { error } = await requireSupabase().from('together_time_sessions').insert({
        couple_id: coupleId,
        created_by: userId,
        activity_type: input.activityType,
        activity_id: input.activityId,
        activity_name: input.activityName.trim(),
        scheduled_at: new Date(input.scheduledAt).toISOString(),
        timezone: input.timezone || 'UTC',
        status: 'scheduled',
      });
      if (error) throw new Error(describeDatabaseError(error));
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Your Together time could not be scheduled.';
      setState((current) => ({ ...current, error: message }));
      throw error;
    } finally {
      setState((current) => ({ ...current, saving: false }));
    }
  }, [coupleId, userId, refresh]);

  const setStatus = useCallback(async (session: TogetherTimeSession, status: 'done' | 'cancelled') => {
    if (!coupleId) return;
    setState((current) => ({ ...current, saving: true, error: null }));
    try {
      const { error } = await requireSupabase().from('together_time_sessions')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', session.id).eq('couple_id', coupleId);
      if (error) throw new Error(describeDatabaseError(error));
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'This Together time could not be updated.';
      setState((current) => ({ ...current, error: message }));
      throw error;
    } finally {
      setState((current) => ({ ...current, saving: false }));
    }
  }, [coupleId, refresh]);

  return {
    ...state,
    refresh,
    schedule,
    complete: (session: TogetherTimeSession) => setStatus(session, 'done'),
    cancel: (session: TogetherTimeSession) => setStatus(session, 'cancelled'),
  };
}

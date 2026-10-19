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

/**
 * Shared date nights, agreed by both partners. Suggesting a time only ever makes a
 * proposal; the other partner agreeing is what locks it in (the database enforces
 * that split), and the push sender handles the due-time reminder sweep after that.
 */
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

  /** Suggest a date and time. Nothing is locked in until the partner agrees to it. */
  const propose = useCallback(async (input: {
    activityType: TogetherActivityType;
    activityId: string;
    activityName: string;
    scheduledAt: string;
    timezone: string;
  }) => {
    if (!coupleId || !userId) throw new Error('Sign in again to suggest a time.');
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
        status: 'proposed',
        proposed_by: userId,
      });
      if (error) throw new Error(describeDatabaseError(error));
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Your suggestion could not be sent.';
      setState((current) => ({ ...current, error: message }));
      throw error;
    } finally {
      setState((current) => ({ ...current, saving: false }));
    }
  }, [coupleId, userId, refresh]);

  /**
   * Agree to the partner's suggestion exactly as it stands, which locks it in. The
   * database refuses this from the partner who suggested the time, and stamps who
   * agreed — the client never writes the agreement columns itself.
   */
  const agree = useCallback(async (session: TogetherTimeSession) => {
    if (!coupleId || !userId) throw new Error('Sign in again to agree to this time.');
    setState((current) => ({ ...current, saving: true, error: null }));
    try {
      const { error } = await requireSupabase().from('together_time_sessions')
        .update({ status: 'scheduled', updated_at: new Date().toISOString() })
        .eq('id', session.id).eq('couple_id', coupleId).eq('status', 'proposed');
      if (error) throw new Error(describeDatabaseError(error));
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'This time could not be locked in.';
      setState((current) => ({ ...current, error: message }));
      throw error;
    } finally {
      setState((current) => ({ ...current, saving: false }));
    }
  }, [coupleId, userId, refresh]);

  /**
   * Counter-suggest a different time (or reopen a locked-in one): the date goes back
   * to 'proposed' with this partner as the suggester, so the other has to agree to
   * the new time before it locks in again.
   */
  const suggestTime = useCallback(async (session: TogetherTimeSession, scheduledAt: string, timezone: string) => {
    if (!coupleId || !userId) throw new Error('Sign in again to suggest a time.');
    const scheduledMs = new Date(scheduledAt).getTime();
    if (!Number.isFinite(scheduledMs) || scheduledMs < Date.now() - 60_000) {
      throw new Error('Pick a time in the future.');
    }
    setState((current) => ({ ...current, saving: true, error: null }));
    try {
      const { error } = await requireSupabase().from('together_time_sessions')
        .update({
          scheduled_at: new Date(scheduledAt).toISOString(),
          timezone: timezone || 'UTC',
          status: 'proposed',
          proposed_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', session.id).eq('couple_id', coupleId);
      if (error) throw new Error(describeDatabaseError(error));
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Your suggestion could not be sent.';
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
    propose,
    agree,
    suggestTime,
    complete: (session: TogetherTimeSession) => setStatus(session, 'done'),
    cancel: (session: TogetherTimeSession) => setStatus(session, 'cancelled'),
  };
}

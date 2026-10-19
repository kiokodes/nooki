import { useCallback, useEffect, useState } from 'react';
import { requireSupabase } from '../lib/supabaseClient';
import { fetchVisitMemories, saveVisitMemory } from '../lib/visitMemoryService';
import type { VisitMemoryEntry } from '../types/database';

interface VisitMemoriesData {
  entries: VisitMemoryEntry[];
  loading: boolean;
  saving: boolean;
  error: string | null;
}

/** A shared timeline, with one contribution per partner for each finished visit. */
export function useVisitMemories(coupleId: string | null, userId: string | null) {
  const [state, setState] = useState<VisitMemoriesData>({ entries: [], loading: false, saving: false, error: null });

  const refresh = useCallback(async () => {
    if (!coupleId) {
      setState((current) => ({ ...current, entries: [], loading: false, error: null }));
      return;
    }
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const entries = await fetchVisitMemories(coupleId);
      setState((current) => ({ ...current, entries, loading: false, error: null }));
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : 'Memories could not be loaded.' }));
    }
  }, [coupleId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!coupleId) return;
    const supabase = requireSupabase();
    const channel = supabase.channel('visit-memory-entries')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'visit_memory_entries', filter: `couple_id=eq.${coupleId}` }, () => { void refresh(); })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [coupleId, refresh]);

  const save = useCallback(async (visitId: string, file: Blob | null, note: string) => {
    if (!coupleId || !userId) throw new Error('Sign in again to save your memory.');
    const existing = state.entries.find((entry) => entry.visit_id === visitId && entry.user_id === userId) ?? null;
    setState((current) => ({ ...current, saving: true, error: null }));
    try {
      const entry = await saveVisitMemory({ coupleId, userId, visitId, file, note, existing });
      setState((current) => ({
        ...current,
        entries: [entry, ...current.entries.filter((row) => !(row.visit_id === visitId && row.user_id === userId))]
          .sort((a, b) => b.created_at.localeCompare(a.created_at)),
        error: null,
      }));
      return entry;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Your memory could not be saved.';
      setState((current) => ({ ...current, error: message }));
      throw error;
    } finally {
      setState((current) => ({ ...current, saving: false }));
    }
  }, [coupleId, userId, state.entries]);

  return { ...state, refresh, save };
}

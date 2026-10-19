import { useState, useEffect, useCallback } from 'react';
import { requireSupabase } from '../lib/supabaseClient';
import { describeDatabaseError } from '../lib/authService';
import { cleanSomedayText, nextSomedaySortOrder, sortSomedayItems } from '../lib/somedayService';
import type { SomedayItem } from '../types/database';

interface SomedayListState {
  items: SomedayItem[];
  loading: boolean;
  error: string | null;
  saving: boolean;
}

/** The couple's shared, manually ordered notebook of simple task titles. */
export function useSomedayList(coupleId: string | null, userId: string | null): SomedayListState & {
  addItem: (text: string) => Promise<SomedayItem | null>;
  toggleItem: (item: SomedayItem) => Promise<void>;
  deleteItem: (item: SomedayItem) => Promise<void>;
  reorderItems: (orderedIds: string[]) => Promise<void>;
  attachToVisit: (item: SomedayItem, visitId: string | null, visitDate?: string | null) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<SomedayListState>({ items: [], loading: true, error: null, saving: false });

  const loadItems = useCallback(async () => {
    if (!coupleId) {
      setState((prev) => ({ ...prev, loading: false, items: [] }));
      return;
    }
    try {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      const { data, error } = await requireSupabase().from('someday_items')
        .select('*').eq('couple_id', coupleId).order('sort_order', { ascending: true });
      if (error) throw new Error(describeDatabaseError(error));
      setState((prev) => ({ ...prev, loading: false, items: sortSomedayItems((data as SomedayItem[]) || []) }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load the shared list.',
      }));
    }
  }, [coupleId]);

  useEffect(() => { void loadItems(); }, [loadItems]);
  useEffect(() => {
    if (!coupleId) return;
    const supabase = requireSupabase();
    const channel = supabase.channel(`someday-items-${coupleId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'someday_items', filter: `couple_id=eq.${coupleId}` }, () => { void loadItems(); })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [coupleId, loadItems]);

  const addItem = useCallback(async (text: string): Promise<SomedayItem | null> => {
    if (!coupleId || !userId) return null;
    try {
      const cleanText = cleanSomedayText(text);
      setState((prev) => ({ ...prev, saving: true, error: null }));
      const sortOrder = nextSomedaySortOrder(state.items);
      const { data, error } = await requireSupabase().from('someday_items').insert({
        couple_id: coupleId,
        text: cleanText,
        sort_order: sortOrder,
        completed: false,
        created_by: userId,
      }).select();
      if (error) throw new Error(describeDatabaseError(error));
      await loadItems();
      return ((data as SomedayItem[]) || [])[0] ?? null;
    } catch (err) {
      setState((prev) => ({ ...prev, error: err instanceof Error ? err.message : 'Failed to add task.' }));
      throw err;
    } finally {
      setState((prev) => ({ ...prev, saving: false }));
    }
  }, [coupleId, userId, state.items, loadItems]);

  const toggleItem = useCallback(async (item: SomedayItem) => {
    if (!coupleId) return;
    const completed = !item.completed;
    const { error } = await requireSupabase().from('someday_items').update({
      completed,
      completed_at: completed ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }).eq('id', item.id).eq('couple_id', coupleId);
    if (error) throw new Error(describeDatabaseError(error));
    await loadItems();
  }, [coupleId, loadItems]);

  const deleteItem = useCallback(async (item: SomedayItem) => {
    if (!coupleId) return;
    const { error } = await requireSupabase().from('someday_items').delete().eq('id', item.id).eq('couple_id', coupleId);
    if (error) throw new Error(describeDatabaseError(error));
    await loadItems();
  }, [coupleId, loadItems]);

  const reorderItems = useCallback(async (orderedIds: string[]) => {
    if (!coupleId || orderedIds.length === 0) return;
    setState((prev) => ({ ...prev, saving: true, error: null }));
    try {
      const { error } = await requireSupabase().rpc('reorder_someday_items', { p_ids: orderedIds });
      if (error) throw new Error(describeDatabaseError(error));
      await loadItems();
    } catch (err) {
      setState((prev) => ({ ...prev, error: err instanceof Error ? err.message : 'The list order could not be saved.' }));
      throw err;
    } finally {
      setState((prev) => ({ ...prev, saving: false }));
    }
  }, [coupleId, loadItems]);

  const attachToVisit = useCallback(async (item: SomedayItem, visitId: string | null, visitDate: string | null = null) => {
    if (!coupleId) return;
    const { error } = await requireSupabase().from('someday_items').update({
      visit_id: visitId,
      visit_date: visitId ? visitDate : null,
      updated_at: new Date().toISOString(),
    }).eq('id', item.id).eq('couple_id', coupleId);
    if (error) throw new Error(describeDatabaseError(error));
    await loadItems();
  }, [coupleId, loadItems]);

  return { ...state, addItem, toggleItem, deleteItem, reorderItems, attachToVisit, refresh: loadItems };
}

import { useState, useEffect, useCallback } from 'react';
import { requireSupabase } from '../lib/supabaseClient';
import { describeDatabaseError } from '../lib/authService';
import {
  cleanSomedayDetails,
  cleanSomedayText,
  nextSomedaySortOrder,
  sortSomedayItems,
} from '../lib/somedayService';
import type { SomedayItem } from '../types/database';

interface SomedayListState {
  items: SomedayItem[];
  loading: boolean;
  error: string | null;
  saving: boolean;
}

export function useSomedayList(coupleId: string | null, userId: string | null): SomedayListState & {
  addItem: (text: string, details?: string | null) => Promise<SomedayItem | null>;
  updateItem: (item: SomedayItem, text: string, details: string | null) => Promise<void>;
  toggleItem: (item: SomedayItem) => Promise<void>;
  deleteItem: (item: SomedayItem) => Promise<void>;
  /** Reorder the visible list; the ids arrive top to bottom. */
  reorderItems: (orderedIds: string[]) => Promise<void>;
  /** Pin an idea to a visit, or pass null to put it back on the someday list. */
  attachToVisit: (item: SomedayItem, visitId: string | null) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<SomedayListState>({
    items: [],
    loading: true,
    error: null,
    saving: false,
  });

  const loadItems = useCallback(async () => {
    if (!coupleId) {
      setState((prev) => ({ ...prev, loading: false, items: [] }));
      return;
    }

    try {
      setState((prev) => ({ ...prev, loading: true, error: null }));

      const { data, error } = await requireSupabase()
        .from('someday_items')
        .select('*')
        .eq('couple_id', coupleId)
        .order('sort_order', { ascending: true });

      if (error) {
        throw new Error(describeDatabaseError(error));
      }

      setState((prev) => ({
        ...prev,
        loading: false,
        items: sortSomedayItems((data as SomedayItem[]) || []),
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load someday list',
      }));
    }
  }, [coupleId]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  // Real-time subscription
  useEffect(() => {
    if (!coupleId) return;

    const supabase = requireSupabase();
    const channel = supabase
      .channel('someday_items_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'someday_items',
          filter: `couple_id=eq.${coupleId}`,
        },
        () => {
          void loadItems();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [coupleId, loadItems]);

  const addItem = useCallback(async (text: string, details: string | null = null): Promise<SomedayItem | null> => {
    if (!coupleId || !userId) {
      return null;
    }

    try {
      const cleanText = cleanSomedayText(text);
      const cleanDetails = cleanSomedayDetails(details);
      setState((prev) => ({ ...prev, saving: true, error: null }));

      // A fresh idea joins the top of the couple's own order, exactly where a
      // newest-first list used to put it. `sort_order` keeps that position through
      // every later drag.
      const sortOrder = nextSomedaySortOrder(state.items);

      const { data, error } = await requireSupabase()
        .from('someday_items')
        .insert({
          couple_id: coupleId,
          text: cleanText,
          details: cleanDetails,
          sort_order: sortOrder,
          completed: false,
          created_by: userId,
        })
        .select();

      if (error) {
        throw new Error(describeDatabaseError(error));
      }

      const newItem = (data as SomedayItem[])[0];
      await loadItems();
      return newItem;
    } catch (err) {
      setState((prev) => ({
        ...prev,
        saving: false,
        error: err instanceof Error ? err.message : 'Failed to add item',
      }));
      throw err;
    } finally {
      setState((prev) => ({ ...prev, saving: false }));
    }
  }, [coupleId, userId, state.items, loadItems]);

  const updateItem = useCallback(async (item: SomedayItem, text: string, details: string | null) => {
    if (!coupleId) return;

    try {
      const cleanText = cleanSomedayText(text);
      const cleanDetails = cleanSomedayDetails(details);
      setState((prev) => ({ ...prev, saving: true, error: null }));

      const { error } = await requireSupabase()
        .from('someday_items')
        .update({
          text: cleanText,
          details: cleanDetails,
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id)
        .eq('couple_id', coupleId);

      if (error) {
        throw new Error(describeDatabaseError(error));
      }

      await loadItems();
    } catch (err) {
      setState((prev) => ({
        ...prev,
        saving: false,
        error: err instanceof Error ? err.message : 'Failed to save this idea',
      }));
      throw err;
    } finally {
      setState((prev) => ({ ...prev, saving: false }));
    }
  }, [coupleId, loadItems]);

  const toggleItem = useCallback(async (item: SomedayItem) => {
    if (!coupleId) return;

    try {
      setState((prev) => ({ ...prev, saving: true, error: null }));

      const completedAt = item.completed ? null : new Date().toISOString();

      const { error } = await requireSupabase()
        .from('someday_items')
        .update({
          completed: !item.completed,
          completed_at: completedAt,
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id)
        .eq('couple_id', coupleId);

      if (error) {
        throw new Error(describeDatabaseError(error));
      }

      await loadItems();
    } catch (err) {
      setState((prev) => ({
        ...prev,
        saving: false,
        error: err instanceof Error ? err.message : 'Failed to toggle item',
      }));
      throw err;
    } finally {
      setState((prev) => ({ ...prev, saving: false }));
    }
  }, [coupleId, loadItems]);

  const deleteItem = useCallback(async (item: SomedayItem) => {
    if (!coupleId) return;

    try {
      setState((prev) => ({ ...prev, saving: true, error: null }));

      const { error } = await requireSupabase()
        .from('someday_items')
        .delete()
        .eq('id', item.id)
        .eq('couple_id', coupleId);

      if (error) {
        throw new Error(describeDatabaseError(error));
      }

      await loadItems();
    } catch (err) {
      setState((prev) => ({
        ...prev,
        saving: false,
        error: err instanceof Error ? err.message : 'Failed to delete item',
      }));
      throw err;
    } finally {
      setState((prev) => ({ ...prev, saving: false }));
    }
  }, [coupleId, loadItems]);

  const reorderItems = useCallback(async (orderedIds: string[]) => {
    if (!coupleId || orderedIds.length === 0) return;

    // The drag already moved the rows on screen; write the order in one atomic
    // server call so both partners read the same list next time. On failure, reload
    // the stored order rather than leaving an order only this phone believes in.
    const byId = new Map(state.items.map((item) => [item.id, item]));
    const reordered = orderedIds
      .map((id) => byId.get(id))
      .filter((item): item is SomedayItem => Boolean(item))
      .map((item, index) => ({ ...item, sort_order: index }));
    if (reordered.length !== orderedIds.length) return;
    // The completed group is not part of the drag; keep its rows on screen while
    // the new active order is saved.
    const optimistic = [...reordered, ...state.items.filter((item) => item.completed)];
    const previous = state.items;
    setState((prev) => ({ ...prev, items: optimistic, error: null }));

    try {
      const { error } = await requireSupabase().rpc('reorder_someday_items', { p_ids: orderedIds });
      if (error) {
        throw new Error(describeDatabaseError(error));
      }
      await loadItems();
    } catch (err) {
      setState((prev) => ({
        ...prev,
        items: previous,
        error: err instanceof Error ? err.message : 'Failed to reorder the list',
      }));
      throw err;
    }
  }, [coupleId, state.items, loadItems]);

  const attachToVisit = useCallback(async (item: SomedayItem, visitId: string | null) => {
    if (!coupleId) return;

    try {
      setState((prev) => ({ ...prev, saving: true, error: null }));

      const { error } = await requireSupabase()
        .from('someday_items')
        .update({
          visit_id: visitId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id)
        .eq('couple_id', coupleId);

      if (error) {
        throw new Error(describeDatabaseError(error));
      }

      await loadItems();
    } catch (err) {
      setState((prev) => ({
        ...prev,
        saving: false,
        error: err instanceof Error ? err.message : 'Failed to update this idea',
      }));
      throw err;
    } finally {
      setState((prev) => ({ ...prev, saving: false }));
    }
  }, [coupleId, loadItems]);

  return {
    ...state,
    addItem,
    updateItem,
    toggleItem,
    deleteItem,
    reorderItems,
    attachToVisit,
    refresh: loadItems,
  };
}

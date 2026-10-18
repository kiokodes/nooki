import { useState, useEffect, useCallback } from 'react';
import { requireSupabase } from '../lib/supabaseClient';
import { describeDatabaseError } from '../lib/authService';
import type { SomedayItem } from '../types/database';

interface SomedayListState {
  items: SomedayItem[];
  loading: boolean;
  error: string | null;
  saving: boolean;
}

export function useSomedayList(coupleId: string | null, userId: string | null): SomedayListState & {
  addItem: (text: string) => Promise<SomedayItem | null>;
  toggleItem: (item: SomedayItem) => Promise<void>;
  deleteItem: (item: SomedayItem) => Promise<void>;
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
        .order('created_at', { ascending: false });

      if (error) {
        throw new Error(describeDatabaseError(error));
      }

      const items = (data as SomedayItem[]) || [];
      
      setState((prev) => ({
        ...prev,
        loading: false,
        items,
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

  const addItem = useCallback(async (text: string): Promise<SomedayItem | null> => {
    if (!coupleId || !userId || !text.trim()) {
      return null;
    }

    try {
      setState((prev) => ({ ...prev, saving: true, error: null }));
      
      const { data, error } = await requireSupabase()
        .from('someday_items')
        .insert({
          couple_id: coupleId,
          text: text.trim(),
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
  }, [coupleId, userId, loadItems]);

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
        .eq('id', item.id);

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
        .eq('id', item.id);

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

  return {
    ...state,
    addItem,
    toggleItem,
    deleteItem,
    refresh: loadItems,
  };
}

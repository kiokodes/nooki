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

function sortByMatches(items: SomedayItem[]): SomedayItem[] {
  return [...items].sort((a, b) => {
    const aMatched = (a.wanters?.length ?? 0) >= 2 ? 1 : 0;
    const bMatched = (b.wanters?.length ?? 0) >= 2 ? 1 : 0;
    if (aMatched !== bMatched) return bMatched - aMatched;
    const orderDifference = (a.sort_order ?? 0) - (b.sort_order ?? 0);
    if (orderDifference !== 0) return orderDifference;
    const aDate = a.created_at || '';
    const bDate = b.created_at || '';
    return bDate.localeCompare(aDate);
  });
}

export function useSomedayList(coupleId: string | null, userId: string | null): SomedayListState & {
  addItem: (text: string, details?: string | null, visibility?: 'open' | 'private') => Promise<SomedayItem | null>;
  updateItem: (item: SomedayItem, text: string, details: string | null, visibility?: 'open' | 'private') => Promise<void>;
  toggleWant: (item: SomedayItem) => Promise<void>;
  toggleItem: (item: SomedayItem) => Promise<void>;
  deleteItem: (item: SomedayItem) => Promise<void>;
  /** Legacy API retained for old clients; the Together tab no longer exposes manual ordering. */
  reorderItems: (orderedIds: string[]) => Promise<void>;
  /** Pin an open idea to a visit, optionally choosing a specific day. */
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
      const supabase = requireSupabase();
      const [itemsResult, votesResult] = await Promise.all([
        supabase.from('someday_items').select('*').eq('couple_id', coupleId).order('sort_order', { ascending: true }),
        supabase.from('someday_item_votes').select('idea_id, user_id').eq('couple_id', coupleId),
      ]);
      if (itemsResult.error) throw new Error(describeDatabaseError(itemsResult.error));
      if (votesResult.error) throw new Error(describeDatabaseError(votesResult.error));
      const votesByIdea = new Map<string, string[]>();
      for (const vote of (votesResult.data || []) as Array<{ idea_id: string; user_id: string }>) {
        votesByIdea.set(vote.idea_id, [...(votesByIdea.get(vote.idea_id) || []), vote.user_id]);
      }
      const items = sortByMatches(sortSomedayItems((itemsResult.data as SomedayItem[] || []).map((item) => ({
        ...item,
        wanters: votesByIdea.get(item.id) || [],
      }))));
      setState((prev) => ({ ...prev, loading: false, items }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load someday list',
      }));
    }
  }, [coupleId]);

  useEffect(() => { void loadItems(); }, [loadItems]);
  useEffect(() => {
    if (!coupleId) return;
    const supabase = requireSupabase();
    const channel = supabase.channel('someday-items-and-matches')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'someday_items', filter: `couple_id=eq.${coupleId}` }, () => { void loadItems(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'someday_item_votes', filter: `couple_id=eq.${coupleId}` }, () => { void loadItems(); })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [coupleId, loadItems]);

  const addItem = useCallback(async (text: string, details: string | null = null, visibility: 'open' | 'private' = 'open'): Promise<SomedayItem | null> => {
    if (!coupleId || !userId) return null;
    try {
      const cleanText = cleanSomedayText(text);
      const cleanDetails = cleanSomedayDetails(details);
      setState((prev) => ({ ...prev, saving: true, error: null }));
      const sortOrder = nextSomedaySortOrder(state.items);
      const { data, error } = await requireSupabase().from('someday_items').insert({
        couple_id: coupleId,
        text: cleanText,
        details: cleanDetails,
        visibility,
        sort_order: sortOrder,
        completed: false,
        created_by: userId,
      }).select();
      if (error) throw new Error(describeDatabaseError(error));
      await loadItems();
      return ((data as SomedayItem[]) || [])[0] ?? null;
    } catch (err) {
      setState((prev) => ({ ...prev, error: err instanceof Error ? err.message : 'Failed to add item' }));
      throw err;
    } finally {
      setState((prev) => ({ ...prev, saving: false }));
    }
  }, [coupleId, userId, state.items, loadItems]);

  const updateItem = useCallback(async (item: SomedayItem, text: string, details: string | null, visibility?: 'open' | 'private') => {
    if (!coupleId) return;
    try {
      const cleanText = cleanSomedayText(text);
      const cleanDetails = cleanSomedayDetails(details);
      setState((prev) => ({ ...prev, saving: true, error: null }));
      const { error } = await requireSupabase().from('someday_items').update({
        text: cleanText,
        details: cleanDetails,
        ...(visibility ? { visibility, ...(visibility === 'private' ? { visit_id: null, visit_date: null } : {}) } : {}),
        updated_at: new Date().toISOString(),
      }).eq('id', item.id).eq('couple_id', coupleId);
      if (error) throw new Error(describeDatabaseError(error));
      await loadItems();
    } catch (err) {
      setState((prev) => ({ ...prev, error: err instanceof Error ? err.message : 'Failed to save this idea' }));
      throw err;
    } finally {
      setState((prev) => ({ ...prev, saving: false }));
    }
  }, [coupleId, loadItems]);

  const toggleWant = useCallback(async (item: SomedayItem) => {
    if (!coupleId || !userId) return;
    const alreadyWants = (item.wanters || []).includes(userId);
    setState((prev) => ({ ...prev, saving: true, error: null }));
    try {
      const query = requireSupabase().from('someday_item_votes');
      const result = alreadyWants
        ? await query.delete().eq('idea_id', item.id).eq('user_id', userId)
        : await query.insert({ idea_id: item.id, couple_id: coupleId, user_id: userId });
      if (result.error) throw new Error(describeDatabaseError(result.error));
      await loadItems();
    } catch (err) {
      setState((prev) => ({ ...prev, error: err instanceof Error ? err.message : 'Your vote could not be saved.' }));
      throw err;
    } finally {
      setState((prev) => ({ ...prev, saving: false }));
    }
  }, [coupleId, userId, loadItems]);

  const toggleItem = useCallback(async (item: SomedayItem) => {
    if (!coupleId) return;
    const { error } = await requireSupabase().from('someday_items').update({
      completed: !item.completed,
      completed_at: item.completed ? null : new Date().toISOString(),
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
    const { error } = await requireSupabase().rpc('reorder_someday_items', { p_ids: orderedIds });
    if (error) throw new Error(describeDatabaseError(error));
    await loadItems();
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

  return { ...state, addItem, updateItem, toggleWant, toggleItem, deleteItem, reorderItems, attachToVisit, refresh: loadItems };
}

import { useCallback, useEffect, useState } from 'react';
import { requireSupabase } from '../lib/supabaseClient';
import { describeDatabaseError } from '../lib/authService';
import type { VisitChecklistItem, VisitWish } from '../types/database';

interface VisitPlanningData {
  wishes: VisitWish[];
  checklist: VisitChecklistItem[];
  loading: boolean;
  saving: boolean;
  error: string | null;
}

/** Per-visit private wishes and the shared, owner-assigned prep checklist. */
export function useVisitPlanning(coupleId: string | null, visitId: string | null, userId: string | null) {
  const [state, setState] = useState<VisitPlanningData>({
    wishes: [], checklist: [], loading: false, saving: false, error: null,
  });

  const refresh = useCallback(async () => {
    if (!coupleId || !visitId) {
      setState((current) => ({ ...current, wishes: [], checklist: [], loading: false, error: null }));
      return;
    }
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const supabase = requireSupabase();
      const [wishesResult, checklistResult] = await Promise.all([
        supabase.from('visit_wishes').select('*').eq('visit_id', visitId),
        supabase.from('visit_checklist_items').select('*').eq('visit_id', visitId).order('created_at', { ascending: true }),
      ]);
      if (wishesResult.error) throw new Error(describeDatabaseError(wishesResult.error));
      if (checklistResult.error) throw new Error(describeDatabaseError(checklistResult.error));
      setState((current) => ({
        ...current,
        wishes: (wishesResult.data as VisitWish[]) || [],
        checklist: (checklistResult.data as VisitChecklistItem[]) || [],
        loading: false,
        error: null,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : 'Visit plans could not be loaded.',
      }));
    }
  }, [coupleId, visitId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!coupleId || !visitId) return;
    const supabase = requireSupabase();
    const channel = supabase.channel(`visit-planning-${visitId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'visit_wishes', filter: `couple_id=eq.${coupleId}` }, () => { void refresh(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'visit_checklist_items', filter: `couple_id=eq.${coupleId}` }, () => { void refresh(); })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [coupleId, visitId, refresh]);

  const saveWish = useCallback(async (wish: string) => {
    if (!coupleId || !visitId || !userId) throw new Error('Choose a visit first.');
    const cleanWish = wish.trim();
    if (!cleanWish) throw new Error('Write one small thing you want from this visit.');
    if (cleanWish.length > 240) throw new Error('Keep your wish under 240 characters.');
    setState((current) => ({ ...current, saving: true, error: null }));
    try {
      const { error } = await requireSupabase().from('visit_wishes').upsert({
        couple_id: coupleId, visit_id: visitId, user_id: userId, wish: cleanWish,
      }, { onConflict: 'visit_id,user_id' });
      if (error) throw new Error(describeDatabaseError(error));
      await refresh();
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : 'Your wish could not be saved.' }));
      throw error;
    } finally {
      setState((current) => ({ ...current, saving: false }));
    }
  }, [coupleId, visitId, userId, refresh]);

  const addChecklistItem = useCallback(async (text: string, assignedTo: string) => {
    if (!coupleId || !visitId || !userId) throw new Error('Choose a visit first.');
    const cleanText = text.trim();
    if (!cleanText) throw new Error('Add a short checklist item.');
    if (cleanText.length > 120) throw new Error('Checklist items can be up to 120 characters.');
    setState((current) => ({ ...current, saving: true, error: null }));
    try {
      const { error } = await requireSupabase().from('visit_checklist_items').insert({
        couple_id: coupleId, visit_id: visitId, text: cleanText,
        assigned_to: assignedTo || userId, created_by: userId,
      });
      if (error) throw new Error(describeDatabaseError(error));
      await refresh();
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : 'The checklist item could not be added.' }));
      throw error;
    } finally {
      setState((current) => ({ ...current, saving: false }));
    }
  }, [coupleId, visitId, userId, refresh]);

  const updateChecklistItem = useCallback(async (itemId: string, updates: Partial<Pick<VisitChecklistItem, 'completed' | 'assigned_to' | 'text'>>) => {
    if (!coupleId) return;
    setState((current) => ({ ...current, saving: true, error: null }));
    try {
      const { error } = await requireSupabase().from('visit_checklist_items').update({
        ...updates, updated_at: new Date().toISOString(),
      }).eq('id', itemId).eq('couple_id', coupleId);
      if (error) throw new Error(describeDatabaseError(error));
      await refresh();
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : 'The checklist could not be updated.' }));
      throw error;
    } finally {
      setState((current) => ({ ...current, saving: false }));
    }
  }, [coupleId, refresh]);

  const deleteChecklistItem = useCallback(async (itemId: string) => {
    if (!coupleId) return;
    const { error } = await requireSupabase().from('visit_checklist_items').delete().eq('id', itemId).eq('couple_id', coupleId);
    if (error) throw new Error(describeDatabaseError(error));
    await refresh();
  }, [coupleId, refresh]);

  return { ...state, refresh, saveWish, addChecklistItem, updateChecklistItem, deleteChecklistItem };
}

import type { SomedayItem } from '../types/database';

/**
 * The Together tab's someday list.
 *
 * The list itself lives in `someday_items`; the rules below are the parts worth keeping
 * in one place: what a title and its notes may contain, how the couple's manual order
 * is read, and where a newly added idea lands. The database enforces the same limits
 * (`202610180008_someday_details_order_and_visit_link.sql`), so a client bug cannot
 * store something the app can no longer render.
 */

/** The idea itself — the line that shows on the Together tab. */
export const SOMEDAY_TEXT_MAX = 500;

/** The extra context a partner adds after tapping the idea. */
export const SOMEDAY_DETAILS_MAX = 1000;

/** Trimmed title, or a helpful error. */
export function cleanSomedayText(text: string): string {
  const cleaned = (text || '').trim();
  if (!cleaned) throw new Error('Give this idea a few words first.');
  if (cleaned.length > SOMEDAY_TEXT_MAX) {
    throw new Error(`Ideas can be up to ${SOMEDAY_TEXT_MAX} characters.`);
  }
  return cleaned;
}

/** Trimmed notes, or null when the notes are empty. */
export function cleanSomedayDetails(details: string | null | undefined): string | null {
  const cleaned = (details || '').trim();
  if (!cleaned) return null;
  if (cleaned.length > SOMEDAY_DETAILS_MAX) {
    throw new Error(`Notes can be up to ${SOMEDAY_DETAILS_MAX} characters.`);
  }
  return cleaned;
}

/** The couple's manual order, oldest tie-breaker last. Never mutates the input. */
export function sortSomedayItems(items: SomedayItem[]): SomedayItem[] {
  return [...items].sort((a, b) => {
    const aOrder = Number.isFinite(a.sort_order) ? a.sort_order : 0;
    const bOrder = Number.isFinite(b.sort_order) ? b.sort_order : 0;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
}

/**
 * Where a fresh idea goes: above everything else, matching what the list already did
 * when it ordered by newest first. The sort value is the current minimum minus one, so
 * a new idea needs no reshuffle of the rows already on the list.
 */
export function nextSomedaySortOrder(items: SomedayItem[]): number {
  const orders = items
    .map((item) => item.sort_order)
    .filter((value): value is number => Number.isFinite(value));
  return orders.length ? Math.min(...orders) - 1 : 0;
}

/** Move one item to a zero-based position. Never mutates the input. */
export function moveSomedayItem(items: SomedayItem[], itemId: string, toIndex: number): SomedayItem[] {
  const fromIndex = items.findIndex((item) => item.id === itemId);
  if (fromIndex < 0) return [...items];
  const target = Math.max(0, Math.min(items.length - 1, toIndex));
  if (target === fromIndex) return [...items];
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(target, 0, moved);
  return next;
}

/** The ideas this couple pinned to one visit, in the couple's own order. */
export function somedayItemsForVisit(items: SomedayItem[], visitId: string | null | undefined): SomedayItem[] {
  if (!visitId) return [];
  return sortSomedayItems(items.filter((item) => item.visit_id === visitId));
}

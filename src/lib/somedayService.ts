import type { SomedayItem } from '../types/database';

/** The shared notebook's one-line task title limit. */
export const SOMEDAY_TEXT_MAX = 500;

/** Trimmed task title, or a helpful error. */
export function cleanSomedayText(text: string): string {
  const cleaned = (text || '').trim();
  if (!cleaned) throw new Error('Write a task title first.');
  if (cleaned.length > SOMEDAY_TEXT_MAX) {
    throw new Error(`Tasks can be up to ${SOMEDAY_TEXT_MAX} characters.`);
  }
  return cleaned;
}

/** Keep the shared manual order exactly as both partners arranged it. */
export function sortSomedayItems(items: SomedayItem[]): SomedayItem[] {
  return [...items].sort((a, b) => {
    const aOrder = Number.isFinite(a.sort_order) ? a.sort_order : 0;
    const bOrder = Number.isFinite(b.sort_order) ? b.sort_order : 0;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return (a.created_at || '').localeCompare(b.created_at || '');
  });
}

/** New notes go at the end so they don't displace a task the couple already ordered. */
export function nextSomedaySortOrder(items: SomedayItem[]): number {
  const orders = items
    .map((item) => item.sort_order)
    .filter((value): value is number => Number.isFinite(value));
  return orders.length ? Math.max(...orders) + 1 : 0;
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

/** Visit-linked entries keep their manual order if a future visit view uses them. */
export function somedayItemsForVisit(items: SomedayItem[], visitId: string | null | undefined): SomedayItem[] {
  if (!visitId) return [];
  return sortSomedayItems(items.filter((item) => item.visit_id === visitId));
}

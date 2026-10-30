import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchRaiseChildChatLinks } from '../lib/raiseChildService';

/**
 * The way back from the chat: a "Talk it out" message carries a link to its moment, so
 * tapping the bubble opens that decision card again.
 *
 * Only the ids already on screen are asked about, and each page of messages is looked up
 * once — a chat that never shared a moment costs nothing.
 */
export function useRaiseChildChatLinks(
  messageIds: string[],
  enabled: boolean,
): Record<string, string> {
  const [links, setLinks] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());

  // The set, not the array: a new render with the same messages must not re-query.
  const key = useMemo(() => messageIds.join(','), [messageIds]);
  const ids = useMemo(() => (key ? key.split(',') : []), [key]);

  useEffect(() => {
    if (!enabled) return;
    const fresh = ids.filter((id) => id && !asked.current.has(id));
    if (!fresh.length) return;
    for (const id of fresh) asked.current.add(id);
    let cancelled = false;
    void (async () => {
      try {
        const found = await fetchRaiseChildChatLinks(fresh);
        if (cancelled || !Object.keys(found).length) return;
        setLinks((current) => ({ ...current, ...found }));
      } catch {
        // A link is a shortcut, never the only way back: a failure leaves the chat as is.
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, ids]);

  return links;
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchRaiseChildChatLinks } from '../lib/raiseChildService';
import { fetchDailyDecisionChatLinks } from '../lib/dailyDecisionService';

export interface ChatCardLinks {
  /** "Talk it out" messages: message id → Raise a Child moment id. */
  raiseChild: Record<string, string>;
  /** "Take to chat" messages: message id → the daily decision's question id. */
  dailyDecision: Record<string, string>;
}

const EMPTY: ChatCardLinks = { raiseChild: {}, dailyDecision: {} };

/**
 * The way back from the chat. A shared moment and a shared daily decision both leave one
 * honest message behind, and both carry a link to the card they came from, so neither
 * partner has to hunt for the sheet again.
 *
 * Only the ids already on screen are asked about, and each page of messages is looked up
 * once — a chat that never shared either costs nothing.
 */
export function useChatCardLinks(messageIds: string[], enabled: boolean): ChatCardLinks {
  const [links, setLinks] = useState<ChatCardLinks>(EMPTY);
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
      const [raiseChild, dailyDecision] = await Promise.all([
        fetchRaiseChildChatLinks(fresh).catch(() => ({})),
        fetchDailyDecisionChatLinks(fresh).catch(() => ({})),
      ]);
      if (cancelled) return;
      if (!Object.keys(raiseChild).length && !Object.keys(dailyDecision).length) return;
      // A link is a shortcut, never the only way back: a failure leaves the chat as is.
      setLinks((current) => ({
        raiseChild: { ...current.raiseChild, ...raiseChild },
        dailyDecision: { ...current.dailyDecision, ...dailyDecision },
      }));
    })();
    return () => { cancelled = true; };
  }, [enabled, ids]);

  return links;
}

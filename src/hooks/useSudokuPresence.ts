import { useEffect, useState } from 'react';
import { requireSupabase } from '../lib/supabaseClient';

type PresenceSnapshot = { scope: string; partnerReady: boolean };

/**
 * A collaboration-ready signal for the Sudoku room. Presence is scoped to the couple
 * and is only tracked while a player has the Sudoku screen open. Each player must also
 * select Collaboration, so a partner browsing another game (or practising solo) cannot
 * accidentally unlock a shared session.
 */
export function useSudokuPresence(
  coupleId: string | null | undefined,
  userId: string | null | undefined,
  partnerId: string | null | undefined,
  collaborationSelected: boolean,
): boolean {
  const scope = coupleId && userId ? `${coupleId}:${userId}:${collaborationSelected}` : null;
  const [snapshot, setSnapshot] = useState<PresenceSnapshot | null>(null);

  useEffect(() => {
    if (!coupleId || !userId || !partnerId || !scope) return;

    let client;
    try {
      client = requireSupabase();
    } catch {
      return;
    }

    let active = true;
    const channel = client.channel(`nooki-sudoku-${coupleId}`, {
      config: { presence: { key: userId } },
    });

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState() as Record<string, Array<{ game?: string; mode?: string }>>;
      const currentPlayerEntries = state[userId] ?? [];
      const partnerEntries = state[partnerId] ?? [];
      const inCollaboration = (entries: Array<{ game?: string; mode?: string }>) =>
        entries.some(entry => entry.game === 'sudoku' && entry.mode === 'collaboration');
      // Require this phone's own presence echo as well as the partner's. A locally
      // mounted screen alone is not enough if this phone has lost its realtime link.
      const partnerReady = inCollaboration(currentPlayerEntries) && inCollaboration(partnerEntries);
      setSnapshot({ scope, partnerReady });
    });

    channel.subscribe(status => {
      if (!active) return;
      if (status === 'SUBSCRIBED') {
        void channel.track({
          user_id: userId,
          game: 'sudoku',
          mode: collaborationSelected ? 'collaboration' : 'other',
        }).catch(() => {
          // Room presence is a readiness hint; a network blip must not crash Sudoku.
        });
      } else {
        // Drop a formerly-ready state as soon as this phone loses the live room.
        setSnapshot({ scope, partnerReady: false });
      }
    });

    return () => {
      active = false;
      const removed = client.removeChannel(channel);
      if (removed && typeof removed.catch === 'function') removed.catch(() => {});
    };
  }, [coupleId, userId, partnerId, scope, collaborationSelected]);

  return snapshot?.scope === scope && snapshot.partnerReady;
}

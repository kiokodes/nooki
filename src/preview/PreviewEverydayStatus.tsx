import { useMemo } from 'react';
import { EverydayStatusCards } from '../components/home/EverydayStatusCards';
import type { EverydayStatus } from '../lib/everydayStatusService';

/** Dev-only in-memory transport. Reuses the real cards without a live account. */
export function PreviewEverydayStatus({ userId, partnerId, partnerName, coupleId, onMessage }: {
  userId: string; partnerId: string; partnerName: string; coupleId: string; onMessage: () => void;
}) {
  const transport = useMemo(() => {
    let rows: EverydayStatus[] = [{ user_id: partnerId, couple_id: coupleId,
      mood: 'Calm', activity: 'Working', note: 'A busy afternoon, but looking forward to our call 💛',
      updated_at: new Date(Date.now() - 40 * 60_000).toISOString(),
      expires_at: new Date(Date.now() + 12 * 3600_000).toISOString(), acknowledged_at: null }];
    return {
      fetch: async () => rows.map(row => ({ ...row })),
      save: async (mood: string, activity: string, note: string, hours: number) => {
        rows = rows.filter(row => row.user_id !== userId);
        rows.push({ user_id: userId, couple_id: coupleId, mood: mood || null, activity: activity || null,
          note: note.trim(), updated_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + hours * 3600_000).toISOString(), acknowledged_at: null });
      },
      clear: async () => { rows = rows.filter(row => row.user_id !== userId); },
      acknowledge: async (status: EverydayStatus) => {
        rows = rows.map(row => row.user_id === status.user_id ? { ...row, acknowledged_at: new Date().toISOString() } : row);
      },
      subscribe: () => () => {},
    };
  }, [userId, partnerId, coupleId]);
  return <EverydayStatusCards {...{ userId, partnerId, partnerName, coupleId, onMessage, transport }} />;
}

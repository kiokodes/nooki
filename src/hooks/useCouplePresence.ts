import { useCallback, useEffect, useRef, useState } from 'react';
import { requireSupabase } from '../lib/supabaseClient';
import { fetchProfile, touchLastSeen } from '../lib/authService';
import type { Profile } from '../types/database';

interface UseCouplePresenceOptions {
  /** The shared couple, or null while the account is still unpaired. */
  coupleId: string | null;
  /** The signed-in account (partner 1 — this phone). */
  userId: string | null;
  /** The other partner, used to refresh their row when presence changes. */
  partnerId: string | null;
  onPartnerProfile?: (profile: Profile) => void;
}

export interface CouplePresence {
  /** True while the partner has this app open and is present on the couple channel. */
  partnerOnline: boolean;
}

interface PresenceSnapshot {
  /** The couple + account this reading belongs to, so stale readings are never shown. */
  scope: string;
  online: boolean;
}

const HEARTBEAT_INTERVAL_MS = 60_000;
/** Never write `last_seen_at` more often than this, even across visibility flips. */
const HEARTBEAT_MIN_GAP_MS = 10_000;

/** Realtime topic shared by exactly the two members of a couple. */
export function couplePresenceTopic(coupleId: string): string {
  return `nooki-couple-${coupleId}`;
}

export function useCouplePresence({
  coupleId,
  userId,
  partnerId,
  onPartnerProfile,
}: UseCouplePresenceOptions): CouplePresence {
  const [snapshot, setSnapshot] = useState<PresenceSnapshot | null>(null);
  const onPartnerProfileRef = useRef(onPartnerProfile);
  const lastHeartbeatRef = useRef(0);
  const scope = coupleId && userId ? `${coupleId}:${userId}` : null;

  useEffect(() => {
    onPartnerProfileRef.current = onPartnerProfile;
  }, [onPartnerProfile]);

  // "Last seen" must fall back to a database timestamp, so pull the partner's row
  // whenever presence changes instead of trusting a stale value held in memory.
  const refreshPartnerProfile = useCallback(async () => {
    if (!partnerId) return;
    try {
      const profile = await fetchProfile(partnerId);
      if (profile) onPartnerProfileRef.current?.(profile);
    } catch {
      // A missed refresh only delays a label; never break the screen over it.
    }
  }, [partnerId]);

  useEffect(() => {
    if (!coupleId || !userId || !scope) return;

    let client;
    try {
      client = requireSupabase();
    } catch {
      return;
    }

    const channel = client.channel(couplePresenceTopic(coupleId), {
      config: { presence: { key: userId } },
    });

    // `sync` fires once on subscribe and again after every join/leave from either
    // partner, so reading the whole presence state keeps the status correct either way.
    channel.on('presence', { event: 'sync' }, () => {
      const present = Object.entries(channel.presenceState());
      setSnapshot({ scope, online: present.some(([key]) => key !== userId) });
      void refreshPartnerProfile();
    });

    channel.subscribe((status) => {
      if (status !== 'SUBSCRIBED') return;
      void (async () => {
        try {
          await channel.track({ user_id: userId, online_at: new Date().toISOString() });
        } catch {
          // Presence is a nicety; a failed track must not surface as an app error.
        }
      })();
    });

    return () => {
      const removed = client.removeChannel(channel);
      if (removed && typeof removed.catch === 'function') removed.catch(() => {});
    };
  }, [coupleId, userId, scope, refreshPartnerProfile]);

  // Heartbeat: keep `last_seen_at` fresh while the app is open so the partner's
  // "Last seen ..." line is accurate the moment this phone goes away.
  useEffect(() => {
    if (!coupleId || !userId) return;

    const writeLastSeen = async (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastHeartbeatRef.current < HEARTBEAT_MIN_GAP_MS) return;
      if (!force && document.visibilityState === 'hidden') return;
      lastHeartbeatRef.current = now;
      try {
        await touchLastSeen(userId);
      } catch {
        // Offline or a rejected write is not fatal: presence still covers "online".
      }
    };

    void writeLastSeen(true);
    const timer = window.setInterval(() => void writeLastSeen(false), HEARTBEAT_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') void writeLastSeen(true);
      else void writeLastSeen(false);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [coupleId, userId]);

  return { partnerOnline: snapshot?.scope === scope && snapshot.online };
}

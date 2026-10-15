import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchGames, playGame, startGame, type GameId, type GameMatch, type GamesSnapshot } from '../lib/gamesService';
export function useGames(coupleId: string | null, userId: string | null) {
  const scope = `${coupleId}:${userId}`;
  const current = useRef(scope);
  useEffect(() => { current.current = scope; }, [scope]);
  const [stored, setStored] = useState<{ scope: string; data: GamesSnapshot } | null>(null);
  const [selected, setSelected] = useState<{ scope: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    if (!coupleId || !userId) return;
    const version = ++request.current;
    try {
      const data = await fetchGames();
      if (current.current === scope && version === request.current) { setStored({ scope, data }); setError(null); }
    } catch (e) { if (current.current === scope && version === request.current) setError((e as Error).message); }
  }, [scope, coupleId, userId]);
  useEffect(() => {
    // Network reads update state asynchronously, not during effect setup.
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [refresh]);
  const data = stored?.scope === scope ? stored.data : null;
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try { await action(); await refresh(); }
    catch (e) { if (current.current === scope) setError((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
  };
  return {
    data, error, busy, refresh,
    match: data?.matches.find(m => selected?.scope === scope && m.id === selected.id),
    select: (id: string | null) => setSelected(id ? { scope, id } : null),
    start: (game: GameId, daily = false, bestOf = 3) => run(async () => {
      const id = await startGame(game, daily, bestOf);
      if (current.current === scope) setSelected({ scope, id });
    }),
    play: (match: GameMatch, move: string) => run(async () => { await playGame(match, move); }),
  };
}
export type GamesState = ReturnType<typeof useGames>;

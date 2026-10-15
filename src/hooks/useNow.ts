import { useEffect, useState } from 'react';

/**
 * A live "now" that re-renders the caller on an interval, so the everyday counter,
 * the partner's clock and "last seen" labels never go stale while the app is open.
 */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const tick = () => setNow(new Date());
    const timer = window.setInterval(tick, intervalMs);
    // Background tabs throttle timers; re-sync as soon as the app is looked at again.
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') tick();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs]);

  return now;
}

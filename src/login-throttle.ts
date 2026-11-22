const windowMs = 5 * 60 * 1000;
const maxTrackedWindows = 10_000;

type AttemptWindow = { used: number; expiresAt: number };
type Reservation = { retryAfter: number } | { release: () => void };

export function createLoginThrottle() {
  const windows = new Map<string, AttemptWindow>();
  let sweepAt = 0;

  return function reserve(username: string, address: string): Reservation {
    const now = Date.now();
    if (now >= sweepAt) {
      for (const [key, window] of windows) {
        if (window.expiresAt <= now) windows.delete(key);
      }
      sweepAt = now + 60_000;
    }

    const limits = [
      { key: `account:${username}`, maximum: 5 },
      { key: `address:${address}`, maximum: 25 },
    ];
    const attempts = limits.map(({ key, maximum }) => {
      const existing = windows.get(key);
      const window = existing && existing.expiresAt > now ? existing : { used: 0, expiresAt: now + windowMs };
      return { key, maximum, window };
    });
    const retryAt = attempts.reduce((latest, { window, maximum }) => window.used >= maximum ? Math.max(latest, window.expiresAt) : latest, now);
    if (retryAt > now) return { retryAfter: Math.ceil((retryAt - now) / 1000) };

    const newWindows = attempts.filter(({ key }) => !windows.has(key)).length;
    if (windows.size + newWindows > maxTrackedWindows) {
      return { retryAfter: Math.ceil((sweepAt - now) / 1000) };
    }

    // Reserve before hashing so simultaneous requests share the same budget.
    for (const { key, window } of attempts) {
      window.used++;
      windows.set(key, window);
    }

    return {
      release() {
        for (const { key, window } of attempts) {
          window.used--;
          if (window.used === 0 && windows.get(key) === window) windows.delete(key);
        }
      },
    };
  };
}

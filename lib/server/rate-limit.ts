interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

export interface RateLimitConfig {
  maxAttempts: number;
  windowMs: number; // milliseconds
}

export const RATE_LIMIT_DEFAULTS = {
  authEndpoints: { maxAttempts: 5, windowMs: 15 * 60 * 1000 }, // 5 per 15 mins
  resetPassword: { maxAttempts: 3, windowMs: 60 * 60 * 1000 }, // 3 per hour
  register: { maxAttempts: 10, windowMs: 60 * 60 * 1000 } // 10 per hour
};

function getKey(type: string, identifier: string): string {
  return `${type}:${identifier}`;
}

export function checkRateLimit(type: string, identifier: string, config: RateLimitConfig): {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
} {
  const now = Date.now();
  const key = getKey(type, identifier);
  let entry = rateLimitStore.get(key);

  // Initialize or reset if window expired
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + config.windowMs };
    rateLimitStore.set(key, entry);
  }

  const remaining = Math.max(0, config.maxAttempts - entry.count - 1);
  const allowed = entry.count < config.maxAttempts;

  if (allowed) {
    entry.count += 1;
  }

  return {
    allowed,
    remaining,
    resetAt: new Date(entry.resetAt)
  };
}

export function incrementRateLimit(type: string, identifier: string, config: RateLimitConfig): void {
  const now = Date.now();
  const key = getKey(type, identifier);
  let entry = rateLimitStore.get(key);

  if (!entry || now >= entry.resetAt) {
    entry = { count: 1, resetAt: now + config.windowMs };
  } else {
    entry.count += 1;
  }

  rateLimitStore.set(key, entry);
}

export function resetRateLimit(type: string, identifier: string): void {
  rateLimitStore.delete(getKey(type, identifier));
}

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  const entriesToDelete: string[] = [];

  rateLimitStore.forEach((entry, key) => {
    if (now >= entry.resetAt) {
      entriesToDelete.push(key);
    }
  });

  entriesToDelete.forEach((key) => rateLimitStore.delete(key));
}, 5 * 60 * 1000);

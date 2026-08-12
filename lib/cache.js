'use strict';

const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DEBUG = process.env.DEBUG === 'true';

class Cache {
  #redis = null;
  #fallback = new Map();
  #connected = false;

  constructor() {
    try {
      this.#redis = new Redis(REDIS_URL, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
        lazyConnect: true,
      });

      this.#redis.on('connect', () => {
        this.#connected = true;
        if (DEBUG) console.log('[cache] Redis connected');
      });

      this.#redis.on('error', (err) => {
        this.#connected = false;
        if (DEBUG) console.warn('[cache] Redis error:', err.message);
      });

      this.#redis.connect().catch(() => {
        this.#connected = false;
        if (DEBUG) console.warn('[cache] Redis unavailable, using in-memory fallback');
      });
    } catch {
      this.#connected = false;
    }
  }

  async set(key, value, ttlMs = 300_000) {
    const serialized = JSON.stringify(value);
    
    if (this.#connected) {
      try {
        await this.#redis.setex(key, Math.ceil(ttlMs / 1000), serialized);
        return;
      } catch (err) {
        if (DEBUG) console.warn('[cache] Redis set error:', err.message);
      }
    }

    // Fallback
    this.#fallback.set(key, { value, expires: Date.now() + ttlMs });
  }

  async get(key) {
    if (this.#connected) {
      try {
        const data = await this.#redis.get(key);
        return data ? JSON.parse(data) : null;
      } catch (err) {
        if (DEBUG) console.warn('[cache] Redis get error:', err.message);
      }
    }

    // Fallback
    const entry = this.#fallback.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.#fallback.delete(key);
      return null;
    }
    return entry.value;
  }

  async del(key) {
    if (this.#connected) {
      try {
        await this.#redis.del(key);
      } catch {}
    }
    this.#fallback.delete(key);
  }

  prune() {
    const now = Date.now();
    for (const [k, v] of this.#fallback) {
      if (now > v.expires) this.#fallback.delete(k);
    }
  }

  get size() {
    return this.#fallback.size;
  }
}

module.exports = new Cache();

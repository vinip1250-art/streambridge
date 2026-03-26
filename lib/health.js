'use strict';

const CACHE_TTL = parseInt(process.env.HEALTH_CACHE_TTL ?? '30000');

class HealthManager {
  #cache = new Map(); // jellyfinUrl -> { healthy, latencyMs, checkedAt }

  async ping(jellyfinUrl, apiKey) {
    const cached = this.#cache.get(jellyfinUrl);
    if (cached && Date.now() - cached.checkedAt < CACHE_TTL) {
      return cached.healthy;
    }
    return this.#doCheck(jellyfinUrl, apiKey);
  }

  async #doCheck(jellyfinUrl, apiKey) {
    const start = Date.now();
    try {
      const res = await fetch(`${jellyfinUrl}/System/Ping`, {
        headers: { 'X-MediaBrowser-Token': apiKey },
        signal: AbortSignal.timeout(5_000),
      });
      const entry = { healthy: res.ok, latencyMs: Date.now() - start, checkedAt: Date.now() };
      this.#cache.set(jellyfinUrl, entry);
      return res.ok;
    } catch {
      this.#cache.set(jellyfinUrl, { healthy: false, latencyMs: null, checkedAt: Date.now() });
      return false;
    }
  }

  getAll() {
    const out = {};
    for (const [url, s] of this.#cache) out[url] = s;
    return out;
  }
}

module.exports = new HealthManager();

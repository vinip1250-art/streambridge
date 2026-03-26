'use strict';

class Cache {
  #store = new Map();

  set(key, value, ttlMs = 300_000) {
    this.#store.set(key, { value, expires: Date.now() + ttlMs });
  }

  get(key) {
    const entry = this.#store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.#store.delete(key);
      return null;
    }
    return entry.value;
  }

  del(key) { this.#store.delete(key); }

  prune() {
    const now = Date.now();
    for (const [k, v] of this.#store) {
      if (now > v.expires) this.#store.delete(k);
    }
  }

  get size() { return this.#store.size; }
}

module.exports = new Cache();

// Short, page-local caching prevents repeated aggregate scans while an owner
// searches or pages through the same project. Explicit Refresh clears it.
export function queryCache({ ttl = 60000, now = Date.now, max = 32 } = {}) {
  const entries = new Map();
  return {
    clear() {
      entries.clear();
    },
    get(key, load) {
      const existing = entries.get(key);
      if (existing && existing.expires > now()) return existing.promise;
      const promise = Promise.resolve().then(load);
      const entry = { expires: now() + ttl, promise };
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > max) entries.delete(entries.keys().next().value);
      promise.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      return promise;
    },
  };
}

// server/sim/rng.js - seedable random helpers (no dependencies)
// Same seed -> same sequence, which makes debugging possible.

function hashSeed(seed) {
  // turn any string/number seed into a 32-bit integer
  let h = 1779033703 ^ String(seed).length;
  for (const ch of String(seed)) {
    h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function makeRng(seed) {
  let a = hashSeed(seed);
  // mulberry32: small, fast, good enough for simulation
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)), // inclusive
    normal: (mean = 0, sd = 1) => {                                 // Box-Muller
      const u = 1 - next(), v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    poisson: (lambda) => {
      if (lambda <= 0) return 0;
      if (lambda > 30) return Math.max(0, Math.round(rng.normal(lambda, Math.sqrt(lambda))));
      const L = Math.exp(-lambda);
      let k = 0, p = 1;
      do { k++; p *= next(); } while (p > L);
      return k - 1;
    },
    // pick one entry using weights: weights is an array parallel to items
    weighted: (items, weights) => {
      const total = weights.reduce((s, w) => s + w, 0);
      let r = next() * total;
      for (let i = 0; i < items.length; i++) {
        r -= weights[i];
        if (r <= 0) return items[i];
      }
      return items[items.length - 1];
    },
    // pick from an object like { 1: 0.2, 2: 0.5, 3: 0.3 } -> returns the key as a number
    fromTable: (table) => {
      const keys = Object.keys(table);
      return Number(rng.weighted(keys, keys.map((k) => table[k])));
    },
  };
  return rng;
}

module.exports = { makeRng };

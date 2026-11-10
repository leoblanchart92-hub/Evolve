/**
 * Evolve — Émetteur d'événements minimal et magasin d'état réactif.
 */

export class Emitter {
  #listeners = new Map();

  /** Abonne `fn` à l'événement ; renvoie une fonction de désabonnement. */
  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this.#listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) fn(payload);
  }
}

/**
 * Magasin d'état clé/valeur : `subscribe(clé, fn)` est rappelé à chaque
 * changement (et une première fois immédiatement, sauf indication contraire).
 */
export function createStore(initial) {
  const state = { ...initial };
  const emitter = new Emitter();

  return {
    get(key) {
      return state[key];
    },
    set(key, value) {
      if (Object.is(state[key], value)) return;
      state[key] = value;
      emitter.emit(key, value);
      emitter.emit('*', { key, value });
    },
    toggle(key) {
      this.set(key, !state[key]);
    },
    subscribe(key, fn, { immediate = true } = {}) {
      const off = emitter.on(key, fn);
      if (immediate && key !== '*') fn(state[key]);
      return off;
    },
    snapshot() {
      return { ...state };
    },
  };
}

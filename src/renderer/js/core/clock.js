/**
 * Evolve — Horloge partagée.
 * Émet un « tic » à chaque seconde, calé sur le changement de seconde, pour
 * que toutes les horloges de l'interface restent synchronisées.
 */

const listeners = new Set();
let timer = 0;

function schedule() {
  const untilNextSecond = 1000 - (Date.now() % 1000);
  timer = setTimeout(() => {
    const now = new Date();
    for (const fn of [...listeners]) fn(now);
    schedule();
  }, untilNextSecond + 4);
}

/**
 * Abonne `fn(date)` aux tics de l'horloge (appelé une première fois aussitôt).
 * @returns {() => void} fonction de désabonnement
 */
export function onTick(fn) {
  listeners.add(fn);
  fn(new Date());
  if (!timer) schedule();
  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      clearTimeout(timer);
      timer = 0;
    }
  };
}

/**
 * Evolve — Modèle de calendrier mensuel (pur, sans DOM).
 */

/** Initiales des jours, semaine commençant le lundi (usage français). */
export const WEEKDAY_LABELS = Object.freeze(['lu', 'ma', 'me', 'je', 've', 'sa', 'di']);

const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * Grille d'un mois : toujours 6 semaines (42 cases) pour une hauteur stable,
 * complétée par les jours des mois voisins.
 * @param {number} year
 * @param {number} month  0 = janvier
 * @param {Date} [today]
 * @returns {{ date: Date, day: number, inMonth: boolean, isToday: boolean }[]}
 */
export function monthGrid(year, month, today = new Date()) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // lundi = 0
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(year, month, 1 - offset + index);
    return {
      date,
      day: date.getDate(),
      inMonth: date.getMonth() === first.getMonth(),
      isToday: sameDay(date, today),
    };
  });
}

/** Décale un couple (année, mois) de `delta` mois. */
export function shiftMonth(year, month, delta) {
  const date = new Date(year, month + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
}

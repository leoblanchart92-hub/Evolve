'use strict';

/**
 * Evolve — Service de l'agenda.
 *
 * Les rendez-vous que l'utilisateur inscrit dans le calendrier : une date et
 * un intitulé. Ils sont conservés dans un fichier du dossier de données
 * d'Evolve (agenda.json, à côté des réglages). Voir records.js pour les
 * garanties d'enregistrement.
 */

const { ServiceError } = require('./hub');
const { createRecordStore } = require('./records');

/** Limites de l'agenda. */
const AGENDA_LIMITS = Object.freeze({ count: 2000, title: 120, minYear: 1900, maxYear: 2199 });

/** Nom du fichier de l'agenda, dans le dossier de données d'Evolve. */
const AGENDA_FILE = 'agenda.json';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONTROL = /[\u0000-\u001F\u007F]/;

/** Vrai si `text` désigne un jour réel du calendrier, « AAAA-MM-JJ », dans les années admises. */
function isCalendarDay(text) {
  const match = typeof text === 'string' ? text.match(DAY) : null;
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < AGENDA_LIMITS.minYear || year > AGENDA_LIMITS.maxYear || month < 1 || month > 12 || day < 1) return false;
  // Dernier jour du mois : le jour zéro du mois suivant.
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Contrôle un rendez-vous : un jour réel, un intitulé d'une ligne. */
function checkEvent(fields) {
  if (!isCalendarDay(fields?.date)) return { ok: false, reason: "Cette date n'existe pas dans le calendrier." };
  if (typeof fields?.title !== 'string') return { ok: false, reason: 'Un rendez-vous porte un intitulé.' };
  const title = fields.title.replace(/\s+/g, ' ').trim();
  if (title === '') return { ok: false, reason: 'Un rendez-vous porte un intitulé.' };
  if (title.length > AGENDA_LIMITS.title) return { ok: false, reason: `Un intitulé compte au plus ${AGENDA_LIMITS.title} caractères.` };
  if (CONTROL.test(title)) return { ok: false, reason: 'Cet intitulé contient des caractères de commande.' };
  return { ok: true, value: { date: fields.date, title } };
}

/**
 * @param {object} [options]
 * @param {string|null} [options.file]  fichier de l'agenda ; `null` : rendez-vous gardés en mémoire seulement
 * (les autres options sont celles de records.js)
 */
function createAgendaService({ file = null, appVersion = null, log = () => {}, ...rest } = {}) {
  const store = createRecordStore({ file, appVersion, log, label: 'Agenda', check: checkEvent, maxCount: AGENDA_LIMITS.count, ...rest });

  const shape = (event) => ({ id: event.id, date: event.date, title: event.title, createdAt: event.createdAt });

  return {
    // --- Méthodes publiques (appelables par l'interface) -----------------------

    /** Tous les rendez-vous, par date, puis dans l'ordre où ils ont été inscrits. */
    list() {
      return store
        .all()
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
        .map(shape);
    },

    /** Inscrit un rendez-vous. */
    add(date, title, meta = {}) {
      return shape(store.create({ date, title }, meta));
    },

    /** Change l'intitulé d'un rendez-vous. */
    rename(id, title, meta = {}) {
      const event = store.get(id);
      return shape(store.update(id, { date: event.date, title }, meta));
    },

    /**
     * Supprime un rendez-vous, définitivement : exige une confirmation explicite.
     * @param {{ confirmed?: boolean }} [choices]
     */
    remove(id, choices, meta = {}) {
      store.get(id);
      if (choices?.confirmed !== true) throw new ServiceError('confirmation-required', "La suppression d'un rendez-vous est définitive : elle doit être confirmée.");
      return store.remove(id, meta);
    },

    state: () => ({ ...store.state(), count: store.size, limit: AGENDA_LIMITS.count, maxLength: AGENDA_LIMITS.title }),

    // --- Usage interne (jamais exposé à l'interface) ---------------------------

    flushSync: () => store.flushSync(),
    status: () => store.status(),
    on: (listener) => store.on(listener),
  };
}

module.exports = { createAgendaService, AGENDA_LIMITS, AGENDA_FILE, isCalendarDay };

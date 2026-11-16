'use strict';

/**
 * Evolve — Service des notes.
 *
 * Les notes de l'utilisateur, en texte simple, conservées dans un fichier du
 * dossier de données d'Evolve (notes.json, à côté des réglages) : rien n'est
 * écrit dans les dossiers personnels de l'utilisateur. Voir records.js pour
 * les garanties d'enregistrement.
 */

const { ServiceError } = require('./hub');
const { createRecordStore } = require('./records');

/** Limites d'une note et de leur nombre. */
const NOTE_LIMITS = Object.freeze({ count: 200, text: 20_000, title: 80, excerpt: 140 });

/** Nom du fichier des notes, dans le dossier de données d'Evolve. */
const NOTES_FILE = 'notes.json';

/** Caractères de commande, hormis la tabulation et le saut de ligne. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Contrôle le texte d'une note ; les fins de ligne de Windows deviennent de simples sauts de ligne. */
function checkNote(fields) {
  if (typeof fields?.text !== 'string') return { ok: false, reason: 'Une note est un texte.' };
  const text = fields.text.replace(/\r\n?/g, '\n');
  if (text.length > NOTE_LIMITS.text) return { ok: false, reason: `Une note compte au plus ${NOTE_LIMITS.text} caractères.` };
  if (CONTROL.test(text)) return { ok: false, reason: 'Ce texte contient des caractères de commande.' };
  return { ok: true, value: { text } };
}

/** Titre d'une note : sa première ligne non vide, abrégée. */
function titleOf(text) {
  const line = text.split('\n').map((item) => item.trim()).find((item) => item !== '') ?? '';
  if (line === '') return 'Note sans titre';
  return line.length > NOTE_LIMITS.title ? `${line.slice(0, NOTE_LIMITS.title - 1).trimEnd()}…` : line;
}

/** Aperçu d'une note : la suite de son texte, après le titre, sur une ligne. */
function excerptOf(text) {
  const lines = text.split('\n').map((item) => item.trim()).filter((item) => item !== '');
  const rest = lines.slice(1).join(' ').replace(/\s+/g, ' ');
  return rest.length > NOTE_LIMITS.excerpt ? `${rest.slice(0, NOTE_LIMITS.excerpt - 1).trimEnd()}…` : rest;
}

/**
 * @param {object} [options]
 * @param {string|null} [options.file]  fichier des notes ; `null` : notes gardées en mémoire seulement
 * @param {string|null} [options.appVersion]
 * @param {(message: string) => void} [options.log]
 * (les autres options sont celles de records.js : horloge, minuteries, module de fichiers…)
 */
function createNotesService({ file = null, appVersion = null, log = () => {}, ...rest } = {}) {
  const store = createRecordStore({ file, appVersion, log, label: 'Notes', check: checkNote, maxCount: NOTE_LIMITS.count, ...rest });

  const summary = (note) => ({ id: note.id, title: titleOf(note.text), excerpt: excerptOf(note.text), length: note.text.length, createdAt: note.createdAt, updatedAt: note.updatedAt });

  return {
    // --- Méthodes publiques (appelables par l'interface) -----------------------

    /** Résumé de chaque note, la plus récemment modifiée en premier. */
    list() {
      return store
        .all()
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.createdAt < b.createdAt ? 1 : -1))
        .map(summary);
    },

    /** Une note entière. */
    read(id) {
      const note = store.get(id);
      return { ...summary(note), text: note.text };
    },

    /** Crée une note (vide par défaut) et renvoie son résumé. */
    create(text = '', meta = {}) {
      return summary(store.create({ text }, meta));
    },

    /** Remplace le texte d'une note et renvoie son résumé. */
    update(id, text, meta = {}) {
      return summary(store.update(id, { text }, meta));
    },

    /**
     * Supprime une note, définitivement : exige une confirmation explicite.
     * @param {{ confirmed?: boolean }} [choices]
     */
    remove(id, choices, meta = {}) {
      store.get(id);
      if (choices?.confirmed !== true) throw new ServiceError('confirmation-required', "La suppression d'une note est définitive : elle doit être confirmée.");
      return store.remove(id, meta);
    },

    state: () => ({ ...store.state(), count: store.size, limit: NOTE_LIMITS.count, maxLength: NOTE_LIMITS.text }),

    // --- Usage interne (jamais exposé à l'interface) ---------------------------

    flushSync: () => store.flushSync(),
    status: () => store.status(),
    on: (listener) => store.on(listener),
  };
}

module.exports = { createNotesService, NOTE_LIMITS, NOTES_FILE, titleOf, excerptOf };

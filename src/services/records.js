'use strict';

/**
 * Evolve — Liste de fiches conservée dans un fichier.
 *
 * Sert de base aux services dont le contenu appartient à l'utilisateur : ses
 * notes (notes.js), ses rendez-vous (agenda.js). Chaque fiche a un
 * identifiant, une date de création, une date de modification, et les champs
 * que le service décrit et contrôle.
 *
 *   - Le fichier n'est créé qu'à la première fiche ; chaque changement est
 *     enregistré peu après, en une écriture « tout ou rien » (json-file.js),
 *     puis une dernière fois à la fermeture (`flushSync`).
 *   - Rien n'est jamais perdu en silence. Un fichier illisible n'est pas
 *     écrasé : la session se poursuit en mémoire, et l'utilisateur en est
 *     averti. Un fichier au contenu inutilisable est mis de côté sous un nom
 *     encore libre — une copie précédente n'est jamais remplacée. Une fiche que
 *     cette version ne comprend pas (fichier modifié à la main, ou écrit par
 *     une version plus récente) est conservée telle quelle à chaque
 *     enregistrement, sans être montrée.
 *   - Un fichier d'un format plus récent n'est ni lu ni modifié.
 *
 * Aucune dépendance à Electron ni à l'interface.
 */

const crypto = require('node:crypto');
const nodeFs = require('node:fs');

const { ServiceError } = require('./hub');
const { readJson, writeJsonAtomic, setAsideUnique } = require('./json-file');

/** Délais d'enregistrement, en millisecondes. */
const DEFAULT_DELAYS = Object.freeze({
  /** Attente après le dernier changement (une saisie continue n'écrit pas à chaque lettre). */
  debounce: 400,
  /** Attente maximale depuis le premier changement non enregistré. */
  maxWait: 2000,
});

/** Format du fichier. */
const SCHEMA_VERSION = 1;

/** Identifiant d'une fiche. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isDate = (value) => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));

/**
 * @param {object} options
 * @param {string|null} [options.file]  fichier ; `null` : fiches gardées en mémoire seulement
 * @param {string} options.label        nom du contenu, pour le journal (« Notes »…)
 * @param {(fields: any) => ({ ok: true, value: object } | { ok: false, reason?: string })} options.check
 *        contrôle les champs d'une fiche et en renvoie une copie normalisée
 * @param {number} options.maxCount     nombre maximal de fiches
 * @param {string|null} [options.appVersion]
 * @param {{ debounce: number, maxWait: number }} [options.delays]
 * @param {(message: string) => void} [options.log]
 * @param {object} [options.fs]
 * @param {object} [options.timers]
 * @param {() => number} [options.now]
 * @param {() => string} [options.newId]
 * @param {object} [options.retry]
 */
function createRecordStore({
  file = null,
  label,
  check,
  maxCount,
  appVersion = null,
  delays = DEFAULT_DELAYS,
  log = () => {},
  fs = nodeFs,
  timers = globalThis,
  now = () => Date.now(),
  newId = () => crypto.randomUUID(),
  retry = {},
}) {
  if (typeof check !== 'function' || !Number.isInteger(maxCount) || maxCount < 1 || typeof label !== 'string') throw new TypeError('Liste de fiches mal décrite.');
  const io = { fs, ...retry };

  /** Fiches comprises de cette version, par identifiant. */
  const records = new Map();
  /** Fiches non comprises : conservées telles quelles, jamais montrées. */
  let foreign = [];
  /** Faux si rien ne doit être écrit (mémoire seule, ou fichier existant resté illisible). */
  let writable = Boolean(file);
  /** @type {null|'unreadable'|'unwritable'|'newer'} */
  let problem = null;
  /** Copie mise de côté au chargement, si le contenu du fichier était inutilisable. */
  let recovered = null;
  let lastError = null;
  let savedAt = null;

  let dirty = false;
  let firstDirtyAt = null;
  let timer = null;
  const listeners = new Set();

  const describeError = (error) => (error?.code ? `${error.code} : ${error.message}` : String(error?.message ?? error));

  function emit(event, payload, origin = null) {
    for (const listener of [...listeners]) {
      try {
        listener(event, payload, origin);
      } catch (error) {
        log(`${label} : abonné en erreur (${event}) : ${error?.message ?? error}`);
      }
    }
  }

  /** État public : où va le contenu, et si son enregistrement fonctionne. */
  function state() {
    return { storage: file ? 'file' : 'memory', durable: Boolean(file) && problem === null, problem, recovered: recovered !== null };
  }

  function setProblem(next, error = null) {
    lastError = error ? describeError(error) : next ? lastError : null;
    if (problem === next) return;
    problem = next;
    emit('state', state());
  }

  // --- Lecture ---------------------------------------------------------------

  function load() {
    if (!file) return;
    const result = readJson(file, io);
    if (result.status === 'missing') return;

    if (result.status === 'unreadable') {
      writable = false;
      problem = 'unreadable';
      lastError = describeError(result.error);
      log(`${label} : fichier illisible, rien ne sera enregistré (${lastError}).`);
      return;
    }

    const data = result.status === 'ok' ? result.data : null;
    const usable = isPlainObject(data) && Array.isArray(data.items) && Number.isInteger(data.schema) && data.schema >= 1;
    if (usable && data.schema > SCHEMA_VERSION) {
      // Écrit par une version plus récente : ni lu, ni modifié.
      writable = false;
      problem = 'newer';
      lastError = `format ${data.schema}, inconnu de cette version`;
      log(`${label} : fichier d'un format plus récent, laissé intact (${lastError}).`);
      return;
    }
    if (!usable) {
      const stamp = new Date(now()).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
      const copy = setAsideUnique(file, stamp, io);
      if (copy) {
        recovered = copy;
        log(`${label} : contenu inutilisable, mis de côté (${copy}).`);
      } else {
        writable = false;
        problem = 'unreadable';
        lastError = 'contenu inutilisable, impossible à mettre de côté';
        log(`${label} : contenu inutilisable et impossible à mettre de côté, rien ne sera enregistré.`);
      }
      return;
    }

    for (const item of data.items) {
      const known = isPlainObject(item) && typeof item.id === 'string' && ID.test(item.id) && !records.has(item.id) && isDate(item.createdAt) && isDate(item.updatedAt);
      const checked = known ? check(item) : { ok: false };
      if (!checked.ok || records.size >= maxCount) {
        // Fiche non comprise, ou en surnombre : elle reste dans le fichier, telle quelle.
        foreign.push(item);
        continue;
      }
      records.set(item.id, { id: item.id, createdAt: new Date(item.createdAt).toISOString(), updatedAt: new Date(item.updatedAt).toISOString(), ...checked.value });
    }
    if (foreign.length) log(`${label} : ${foreign.length} fiche(s) non comprise(s), conservée(s) telle(s) quelle(s).`);
  }

  // --- Enregistrement --------------------------------------------------------

  function snapshot() {
    return {
      schema: SCHEMA_VERSION,
      app: appVersion,
      savedAt: new Date(now()).toISOString(),
      items: [...[...records.values()].map((record) => ({ ...record })), ...foreign],
    };
  }

  /**
   * Enregistre immédiatement les changements en attente.
   * @returns {boolean} vrai si tout est enregistré (ou s'il n'y avait rien à faire)
   */
  function flushSync() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    firstDirtyAt = null;
    if (!dirty) return true;
    if (!writable) return false;
    try {
      const content = snapshot();
      writeJsonAtomic(file, content, io);
      dirty = false;
      savedAt = content.savedAt;
      setProblem(null);
      return true;
    } catch (error) {
      // Les fiches restent en mémoire ; l'écriture sera retentée au prochain changement et à la fermeture.
      log(`${label} : enregistrement impossible (${describeError(error)}).`);
      setProblem('unwritable', error);
      return false;
    }
  }

  function schedule() {
    if (!file) return;
    dirty = true;
    if (!writable) return;
    const time = now();
    if (firstDirtyAt === null) firstDirtyAt = time;
    const delay = Math.max(0, Math.min(delays.debounce, firstDirtyAt + delays.maxWait - time));
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(flushSync, delay);
  }

  /** Champs contrôlés, ou refus. */
  function checked(fields) {
    const result = check(fields);
    if (!result.ok) throw new ServiceError('invalid-value', result.reason ?? 'Contenu refusé.');
    return result.value;
  }

  function existing(id) {
    const record = typeof id === 'string' ? records.get(id) : undefined;
    if (!record) throw new ServiceError('not-found', "Cet élément n'existe plus.");
    return record;
  }

  load();

  return {
    /** Toutes les fiches (copies), dans l'ordre de leur création. */
    all() {
      return [...records.values()].map((record) => ({ ...record }));
    },

    /** Une fiche (copie). */
    get(id) {
      return { ...existing(id) };
    },

    get size() {
      return records.size;
    },

    /** Crée une fiche. */
    create(fields, { origin = null } = {}) {
      const value = checked(fields);
      if (records.size >= maxCount) throw new ServiceError('limit', `La limite de ${maxCount} éléments est atteinte.`);
      let id = newId();
      for (let attempt = 0; attempt < 5 && (!ID.test(id) || records.has(id)); attempt += 1) id = crypto.randomUUID();
      const stamp = new Date(now()).toISOString();
      const record = { id, createdAt: stamp, updatedAt: stamp, ...value };
      records.set(id, record);
      schedule();
      emit('changed', { reason: 'created', id }, origin);
      return { ...record };
    },

    /** Remplace les champs d'une fiche. Sans changement, rien n'est enregistré. */
    update(id, fields, { origin = null } = {}) {
      const record = existing(id);
      const value = checked(fields);
      const { id: _id, createdAt, updatedAt: _updatedAt, ...before } = record;
      if (JSON.stringify(before) === JSON.stringify(value)) return { ...record };
      const next = { id: record.id, createdAt, updatedAt: new Date(now()).toISOString(), ...value };
      records.set(record.id, next);
      schedule();
      emit('changed', { reason: 'updated', id: record.id }, origin);
      return { ...next };
    },

    /** Supprime une fiche. */
    remove(id, { origin = null } = {}) {
      const record = existing(id);
      records.delete(record.id);
      schedule();
      emit('changed', { reason: 'removed', id: record.id }, origin);
      return true;
    },

    state,
    flushSync,

    /** État détaillé, pour les comptes rendus et les vérifications automatiques. */
    status() {
      let exists = false;
      try {
        exists = Boolean(file) && fs.existsSync(file);
      } catch {
        exists = false;
      }
      return {
        state: problem ? 'limited' : 'available',
        ...state(),
        file,
        exists,
        count: records.size,
        /** Fiches non comprises de cette version, conservées dans le fichier. */
        kept: foreign.length,
        pending: dirty,
        savedAt,
        lastError,
        recoveredTo: recovered,
      };
    },

    /**
     * Abonne `listener(événement, données, origine)` :
     *   « changed » { reason, id } — une fiche a été créée, modifiée ou supprimée ;
     *   « state »   état public    — l'enregistrement s'est mis à échouer ou refonctionne.
     */
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

module.exports = { createRecordStore, DEFAULT_DELAYS, SCHEMA_VERSION };

'use strict';

/**
 * Evolve — Service des réglages.
 *
 * Conserve les réglages de l'utilisateur dans un fichier JSON lisible
 * (settings.json) et les restitue au lancement suivant.
 *
 *   - Seuls les réglages modifiés par l'utilisateur sont enregistrés : les
 *     autres suivent la valeur par défaut de la version en cours.
 *   - Le dossier et le fichier ne sont créés qu'au premier changement.
 *   - Chaque changement est enregistré peu après (un quart de seconde, une
 *     seconde au plus pendant une série de changements), puis une dernière
 *     fois à la fermeture (`flushSync`).
 *   - Un fichier illisible n'est jamais écrasé ; un fichier au contenu
 *     inutilisable est mis de côté (settings.corrupt.json) et les valeurs par
 *     défaut s'appliquent — s'il ne peut pas être mis de côté, il n'est pas
 *     écrasé non plus ; une valeur invalide reprend sa valeur par défaut.
 *   - Les réglages inconnus de cette version (fichier écrit par une version
 *     plus récente) sont conservés tels quels.
 *
 * Aucune dépendance à Electron ni à l'interface : le fichier, l'horloge et
 * les minuteries sont fournis par l'appelant.
 */

const nodeFs = require('node:fs');
const path = require('node:path');

const { ServiceError } = require('./hub');
const { readJson, writeJsonAtomic, setAside } = require('./json-file');
const { SCHEMA_VERSION, SETTINGS, MIGRATIONS, normalize, defaultsOf } = require('./settings-schema');

/** Délais d'enregistrement, en millisecondes. */
const DEFAULT_DELAYS = Object.freeze({
  /** Attente après le dernier changement (un curseur déplacé n'écrit qu'une fois). */
  debounce: 250,
  /** Attente maximale depuis le premier changement non enregistré. */
  maxWait: 1000,
});

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Nom du fichier où un contenu inutilisable est mis de côté : settings.json → settings.corrupt.json. */
function corruptFileFor(file) {
  const extension = path.extname(file);
  return path.join(path.dirname(file), `${path.basename(file, extension)}.corrupt${extension}`);
}

/**
 * @param {object} [options]
 * @param {string|null} [options.file]   fichier des réglages ; `null` : réglages
 *                                       gardés en mémoire seulement, rien n'est lu ni écrit
 * @param {string|null} [options.appVersion]  version d'Evolve, notée dans le fichier
 * @param {object} [options.definitions]  réglages connus (voir settings-schema.js)
 * @param {number} [options.schemaVersion]
 * @param {Record<number, (values: object) => object>} [options.migrations]
 * @param {{ debounce: number, maxWait: number }} [options.delays]
 * @param {(message: string) => void} [options.log]
 * @param {object} [options.fs]      module de fichiers (remplacé par les tests)
 * @param {object} [options.timers]  `setTimeout` et `clearTimeout`
 * @param {() => number} [options.now]
 * @param {object} [options.retry]   nouveaux essais d'écriture (voir json-file.js)
 */
function createSettingsService({
  file = null,
  appVersion = null,
  definitions = SETTINGS,
  schemaVersion = SCHEMA_VERSION,
  migrations = MIGRATIONS,
  delays = DEFAULT_DELAYS,
  log = () => {},
  fs = nodeFs,
  timers = globalThis,
  now = () => Date.now(),
  retry = {},
} = {}) {
  const io = { fs, ...retry };
  const defaults = defaultsOf(definitions);
  const corruptFile = file ? corruptFileFor(file) : null;

  /** Valeurs choisies par l'utilisateur ; les autres réglages gardent leur valeur par défaut. */
  const stored = new Map();
  /** Réglages inconnus de cette version, conservés tels quels à l'enregistrement. */
  const foreign = new Map();
  /** Format noté dans le fichier : jamais inférieur à celui d'un fichier plus récent. */
  let fileSchema = schemaVersion;
  /** Faux si rien ne doit être écrit (mémoire seule, ou fichier existant resté illisible). */
  let writable = Boolean(file);
  /** @type {null|'unreadable'|'unwritable'} */
  let problem = null;
  /** @type {null|'corrupt'} */
  let recovered = null;
  let lastError = null;
  let savedAt = null;

  let dirty = false;
  let firstDirtyAt = null;
  let timer = null;
  const listeners = new Set();

  const isKnown = (key) => typeof key === 'string' && Object.hasOwn(definitions, key);
  const effective = (key) => (stored.has(key) ? stored.get(key) : defaults[key]);
  const describeError = (error) => (error?.code ? `${error.code} : ${error.message}` : String(error?.message ?? error));

  function requireKnown(key) {
    if (!isKnown(key)) throw new ServiceError('unknown-key', 'Réglage inconnu.');
  }

  function emit(event, payload, origin = null) {
    for (const listener of [...listeners]) {
      try {
        listener(event, payload, origin);
      } catch (error) {
        log(`Réglages : abonné en erreur (${event}) : ${error?.message ?? error}`);
      }
    }
  }

  /** État public : où vont les réglages et si leur enregistrement fonctionne. */
  function state() {
    return { storage: file ? 'file' : 'memory', durable: Boolean(file) && problem === null, problem, recovered };
  }

  function setProblem(next, error = null) {
    lastError = error ? describeError(error) : next ? lastError : null;
    if (problem === next) return;
    problem = next;
    emit('state', state());
  }

  // --- Lecture ---------------------------------------------------------------

  /**
   * Interprète le contenu du fichier. Renvoie les valeurs, converties au
   * format en cours, ou `null` si le contenu est inutilisable.
   */
  function interpret(data) {
    if (!isPlainObject(data) || !isPlainObject(data.values)) return null;
    const schema = data.schema === undefined ? 1 : data.schema;
    if (!Number.isInteger(schema) || schema < 1) return null;
    let values = data.values;
    try {
      for (let version = schema; version < schemaVersion; version += 1) {
        values = migrations[version](values);
        if (!isPlainObject(values)) return null;
      }
    } catch (error) {
      log(`Réglages : conversion du format ${schema} impossible : ${error?.message ?? error}`);
      return null;
    }
    return { schema, values };
  }

  function load() {
    if (!file) return;
    const result = readJson(file, io);
    if (result.status === 'missing') return;

    if (result.status === 'unreadable') {
      // Le fichier existe mais n'a pas pu être lu : il n'est surtout pas
      // écrasé. Les réglages restent en mémoire pour cette session.
      writable = false;
      problem = 'unreadable';
      lastError = describeError(result.error);
      log(`Réglages : fichier illisible, rien ne sera enregistré (${lastError}).`);
      return;
    }

    const content = result.status === 'ok' ? interpret(result.data) : null;
    if (!content) {
      if (setAside(file, corruptFile, io)) {
        recovered = 'corrupt';
        log(`Réglages : contenu inutilisable, valeurs par défaut appliquées (copie : ${corruptFile}).`);
      } else {
        // Impossible de le mettre de côté : il n'est pas écrasé pour autant.
        writable = false;
        problem = 'unreadable';
        lastError = 'contenu inutilisable, impossible à mettre de côté';
        log('Réglages : contenu inutilisable et impossible à mettre de côté, rien ne sera enregistré.');
      }
      return;
    }

    fileSchema = Math.max(schemaVersion, content.schema);
    for (const [key, value] of Object.entries(content.values)) {
      if (!isKnown(key)) {
        foreign.set(key, value);
        continue;
      }
      const checked = normalize(definitions[key], value);
      if (checked.ok) stored.set(key, checked.value);
      else log(`Réglages : valeur invalide ignorée pour « ${key} ».`);
    }
    // Fichier d'un ancien format : il est réenregistré au format en cours.
    if (content.schema < schemaVersion) schedule();
  }

  // --- Enregistrement --------------------------------------------------------

  function snapshot() {
    const entries = [...foreign, ...stored].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      schema: fileSchema,
      app: appVersion,
      savedAt: new Date(now()).toISOString(),
      values: Object.fromEntries(entries),
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
      // Les valeurs restent en mémoire ; l'écriture sera retentée au prochain
      // changement et à la fermeture.
      log(`Réglages : enregistrement impossible (${describeError(error)}).`);
      setProblem('unwritable', error);
      return false;
    }
  }

  /** Programme l'enregistrement des changements en attente. */
  function schedule() {
    if (!file) return; // mémoire seule : rien à enregistrer
    dirty = true;
    if (!writable) return;
    const time = now();
    if (firstDirtyAt === null) firstDirtyAt = time;
    const delay = Math.max(0, Math.min(delays.debounce, firstDirtyAt + delays.maxWait - time));
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(flushSync, delay);
  }

  load();

  return {
    // --- Méthodes publiques (appelables par l'interface) -----------------------

    /** Valeur de tous les réglages connus. */
    getAll() {
      return Object.fromEntries(Object.keys(definitions).map((key) => [key, effective(key)]));
    },

    /** Valeur d'un réglage. */
    get(key) {
      requireKnown(key);
      return effective(key);
    },

    /**
     * Modifie un réglage. Renvoie la valeur retenue (un nombre hors bornes est
     * ramené dans les bornes).
     * @param {string} key
     * @param {any} value
     * @param {{ origin?: string|null }} [meta]  qui demande le changement
     */
    set(key, value, { origin = null } = {}) {
      requireKnown(key);
      const checked = normalize(definitions[key], value);
      if (!checked.ok) throw new ServiceError('invalid-value', `Valeur refusée pour le réglage « ${key} ».`);
      if (stored.has(key) && Object.is(stored.get(key), checked.value)) return checked.value;
      const before = effective(key);
      stored.set(key, checked.value);
      schedule();
      if (!Object.is(before, checked.value)) emit('changed', { key, value: checked.value }, origin);
      return checked.value;
    },

    /**
     * Rend sa valeur par défaut à un réglage, ou à tous si `key` est omis.
     * Renvoie la valeur de tous les réglages après l'opération.
     */
    reset(key = null, { origin = null } = {}) {
      if (key !== null) requireKnown(key);
      const keys = key === null ? [...stored.keys()] : [key];
      let changed = false;
      for (const name of keys) {
        if (!stored.has(name)) continue;
        const before = stored.get(name);
        stored.delete(name);
        changed = true;
        if (!Object.is(before, defaults[name])) emit('changed', { key: name, value: defaults[name] }, origin);
      }
      if (changed) schedule();
      return this.getAll();
    },

    state,

    // --- Usage interne (jamais exposé à l'interface) ---------------------------

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
        schema: fileSchema,
        /** Nombre de réglages modifiés par l'utilisateur. */
        stored: stored.size,
        /** Vrai si des changements attendent d'être enregistrés. */
        pending: dirty,
        savedAt,
        lastError,
      };
    },

    /**
     * Abonne `listener(événement, données, origine)` :
     *   « changed » { key, value } — la valeur d'un réglage a changé ;
     *   « state »   état public    — l'enregistrement s'est mis à échouer ou refonctionne.
     * Renvoie une fonction de désabonnement.
     */
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Annule l'enregistrement programmé, sans rien écrire. */
    dispose() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { createSettingsService, corruptFileFor, DEFAULT_DELAYS };

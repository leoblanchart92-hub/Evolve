'use strict';

/**
 * Evolve — Couche de services.
 *
 * Tout ce qu'Evolve fait en dehors de l'affichage passe par ici. Cette couche
 * est indépendante de l'interface : du Node.js seul, sans Electron, sans page
 * web, sans dépendance externe. L'application de bureau la relie à sa fenêtre
 * (src/main/main.js) ; les tests l'utilisent directement ; un autre hôte —
 * demain un bureau Linux — pourra la reprendre telle quelle.
 *
 * Services disponibles :
 *   settings   réglages de l'utilisateur, conservés d'un lancement à l'autre
 *   files      consultation des dossiers de l'ordinateur, en lecture seule
 *
 * Les opérations sur les fichiers (créer un dossier, renommer, copier,
 * déplacer, envoyer à la Corbeille, ouvrir) ne sont PAS des méthodes d'un
 * service : elles ne peuvent pas être désignées par leur nom à travers le
 * point d'accès. Chacune est une fonction distincte de `fileOperations`, que
 * l'hôte relie à l'interface une à une (voir file-operations.js).
 */

const { createFileOperations } = require('./file-operations');
const { createFilesService } = require('./files');
const { createHub, isPlainData, reply } = require('./hub');
const { createSettingsService } = require('./settings');

/** Limites des arguments d'une opération sur les fichiers : jusqu'à mille chemins. */
const OPERATION_LIMITS = Object.freeze({ depth: 4, nodes: 1100, text: 1_000_000 });

/** Opérations sur les fichiers proposées à l'hôte, dans l'ordre de leur présentation. */
const FILE_OPERATIONS = Object.freeze(['createFolder', 'rename', 'copy', 'move', 'trash', 'open']);

/**
 * @param {object} [options]
 * @param {string|null} [options.settingsFile]  fichier des réglages ; `null` :
 *        réglages en mémoire seulement (rien n'est lu ni écrit)
 * @param {string|null} [options.appVersion]
 * @param {object} [options.files]  emplacements que l'explorateur peut
 *        consulter : `places` (dossiers personnels connus de l'hôte), `drives`
 *        (`'auto'` : lecteurs locaux) et `fs` (voir files.js). Sans cette
 *        option, aucun dossier n'est consultable.
 * @param {object} [options.operations]  ce que l'hôte fournit aux opérations
 *        sur les fichiers : `trash(chemin)` envoie un élément à la Corbeille
 *        (et échoue si c'est impossible), `openPath(chemin)` confie un fichier
 *        à l'application associée, `moveNoReplace(de, vers)` renomme ou
 *        déplace un élément sans jamais rien remplacer — le système refuse
 *        lui-même si le nom d'arrivée est pris. Sans `trash`, rien ne peut
 *        être supprimé ; sans `openPath`, rien ne peut être ouvert ; sans
 *        `moveNoReplace`, rien ne peut être renommé ni déplacé.
 * @param {(message: string) => void} [options.log]
 */
function createServices({ settingsFile = null, appVersion = null, files: fileOptions = {}, operations: operationOptions = {}, log = () => {} } = {}) {
  const hub = createHub({ log });
  const settings = createSettingsService({ file: settingsFile, appVersion, log });
  const files = createFilesService(fileOptions);
  // Mêmes contrôles de chemins, même module de fichiers et mêmes variables que la consultation.
  const operations = createFileOperations({
    guard: files.guard,
    ...(fileOptions.fs ? { fs: fileOptions.fs } : {}),
    ...(fileOptions.env ? { env: fileOptions.env } : {}),
    trash: typeof operationOptions.trash === 'function' ? operationOptions.trash : null,
    openPath: typeof operationOptions.openPath === 'function' ? operationOptions.openPath : null,
    moveNoReplace: typeof operationOptions.moveNoReplace === 'function' ? operationOptions.moveNoReplace : null,
    log,
  });

  /** Opération appelée par l'hôte : arguments bornés, réponse de la forme commune `{ ok, … }`. */
  const operation = (name, args) => {
    if (!isPlainData(args, OPERATION_LIMITS)) {
      return Promise.resolve({ ok: false, code: 'bad-arguments', message: 'Arguments refusés : seules des données simples, de taille raisonnable, sont admises.' });
    }
    return reply(() => operations[name](...args), { log, label: `fileOperations.${name}` });
  };

  const emit = hub.register('settings', {
    methods: {
      getAll: () => settings.getAll(),
      get: (_context, key) => settings.get(key),
      set: ({ origin }, key, value) => settings.set(key, value, { origin }),
      reset: ({ origin }, key = null) => settings.reset(key, { origin }),
      state: () => settings.state(),
    },
    events: ['changed', 'state'],
    status: () => settings.status(),
  });
  settings.on((event, payload, origin) => emit(event, payload, { origin }));

  // Lecture seule : ces deux méthodes sont les seules, et aucune n'écrit.
  hub.register('files', {
    methods: {
      places: () => files.places(),
      list: (_context, folder) => files.list(folder),
    },
    status: () => files.status(),
  });

  return {
    hub,
    settings,
    files,
    /**
     * Opérations sur les fichiers : une fonction par opération, aux arguments
     * fixés. Chacune répond `{ ok: true, value }` ou `{ ok: false, code,
     * message }` et ne lève jamais d'exception.
     */
    fileOperations: Object.freeze({
      createFolder: (parent, name) => operation('createFolder', [parent, name]),
      rename: (target, name) => operation('rename', [target, name]),
      copy: (sources, destination, options) => operation('copy', [sources, destination, options ?? null]),
      move: (sources, destination, options) => operation('move', [sources, destination, options ?? null]),
      trash: (targets, options) => operation('trash', [targets, options ?? null]),
      open: (target, options) => operation('open', [target, options ?? null]),
      /** Demande l'arrêt de l'opération en cours, désignée par son identifiant. */
      cancel: (id) => Promise.resolve({ ok: true, value: typeof id === 'string' ? operations.cancel(id) : false }),
      /** Abonne `listener(progression)` ; renvoie une fonction de désabonnement. */
      onProgress: (listener) => operations.on(listener),
    }),
    /**
     * Enregistre immédiatement tout ce qui attend de l'être. À appeler avant
     * l'arrêt du programme ; ne lève jamais d'exception.
     */
    flushSync() {
      try {
        return settings.flushSync();
      } catch (error) {
        log(`Services : enregistrement final impossible : ${error?.message ?? error}`);
        return false;
      }
    },
    /** Inventaire et état des services — et des opérations sur les fichiers, qui n'en sont pas un. */
    describe: () => ({
      ...hub.describe(),
      'file-operations': { state: 'available', access: 'dedicated-functions', ...operations.status(), methods: [...FILE_OPERATIONS], events: ['progress'] },
    }),
  };
}

module.exports = { createServices, FILE_OPERATIONS };

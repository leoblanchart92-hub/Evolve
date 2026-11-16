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
 *   updates    mises à jour de la version installée : recherche, puis
 *              téléchargement et installation à la demande
 *   notes      notes de l'utilisateur, conservées à côté des réglages
 *   agenda     rendez-vous inscrits dans le calendrier, conservés de même
 *   system     mesures réelles de la machine (processeur, mémoire…), en
 *              lecture seule
 *
 * Les opérations sur les fichiers (créer un dossier, renommer, copier,
 * déplacer, envoyer à la Corbeille, ouvrir) ne sont PAS des méthodes d'un
 * service : elles ne peuvent pas être désignées par leur nom à travers le
 * point d'accès. Chacune est une fonction distincte de `fileOperations`, que
 * l'hôte relie à l'interface une à une (voir file-operations.js).
 */

const { createAgendaService } = require('./agenda');
const { createFileOperations } = require('./file-operations');
const { createFilesService } = require('./files');
const { createHub, isPlainData, reply } = require('./hub');
const { createNotesService } = require('./notes');
const { createSettingsService } = require('./settings');
const { createSystemService } = require('./system');
const { createUpdatesService } = require('./updates');

/** Limites des arguments d'une opération sur les fichiers : jusqu'à mille chemins. */
const OPERATION_LIMITS = Object.freeze({ depth: 4, nodes: 1100, text: 1_000_000 });

/** Opérations sur les fichiers proposées à l'hôte, dans l'ordre de leur présentation. */
const FILE_OPERATIONS = Object.freeze(['createFolder', 'rename', 'copy', 'move', 'trash', 'open']);

/**
 * @param {object} [options]
 * @param {string|null} [options.settingsFile]  fichier des réglages ; `null` :
 *        réglages en mémoire seulement (rien n'est lu ni écrit)
 * @param {string|null} [options.notesFile]   fichier des notes ; `null` : notes en mémoire seulement
 * @param {string|null} [options.agendaFile]  fichier de l'agenda ; `null` : rendez-vous en mémoire seulement
 * @param {string|null} [options.appVersion]
 * @param {object} [options.system]  ce que l'hôte sait de lui-même, pour le
 *        service du système : `dataDir` (dossier des réglages, des notes et
 *        de l'agenda), `versions` (composants de l'hôte) et `processes()`
 *        (ses processus). Les mesures de la machine, elles, sont lues ici.
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
 * @param {object} [options.updates]  mises à jour : `variant` (façon dont
 *        Evolve a été lancé — seule la version installée se met à jour),
 *        `engine` (ce que l'hôte sait faire : lire la description d'une
 *        version, télécharger, lancer l'installateur), `quit()` (fermer
 *        l'application), `updated` (cette session suit une mise à jour) et
 *        `page` (où les versions sont publiées). Sans `engine`, aucune mise à
 *        jour n'est possible.
 * @param {(message: string) => void} [options.log]
 */
function createServices({
  settingsFile = null,
  notesFile = null,
  agendaFile = null,
  appVersion = null,
  files: fileOptions = {},
  operations: operationOptions = {},
  updates: updateOptions = {},
  system: systemOptions = {},
  log = () => {},
} = {}) {
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

  // Mises à jour : rien n'est téléchargé ni installé sans une demande explicite, et jamais pendant une
  // opération sur les fichiers.
  const updates = createUpdatesService({
    variant: updateOptions.variant,
    currentVersion: appVersion,
    engine: updateOptions.engine ?? null,
    automatic: () => settings.get('updates.automatic'),
    busy: () => operations.status().busy === true,
    quit: typeof updateOptions.quit === 'function' ? updateOptions.quit : () => {},
    updated: updateOptions.updated === true,
    page: typeof updateOptions.page === 'string' ? updateOptions.page : null,
    log,
  });
  const announceUpdates = hub.register('updates', {
    methods: {
      state: () => updates.state(),
      check: () => updates.check(),
      download: () => updates.download(),
      cancel: () => updates.cancel(),
      install: (_context, choices) => updates.install(choices),
    },
    events: ['changed'],
    status: () => updates.status(),
  });
  // Chaque changement est annoncé à tous, demandeur compris : une recherche ou un téléchargement dure.
  updates.on((event, payload) => announceUpdates(event, payload));
  // Le réglage « rechercher au lancement » fait partie de l'état annoncé.
  settings.on((event, payload) => {
    if (event === 'changed' && payload?.key === 'updates.automatic') updates.refresh();
  });

  // Notes et agenda : le contenu de l'utilisateur. Chaque changement est annoncé à tous, demandeur compris —
  // toute vue qui les affiche se met à jour de la même façon. Une suppression exige une confirmation.
  const notes = createNotesService({ file: notesFile, appVersion, log });
  const announceNotes = hub.register('notes', {
    methods: {
      list: () => notes.list(),
      read: (_context, id) => notes.read(id),
      create: (_context, text = '') => notes.create(text),
      update: (_context, id, text) => notes.update(id, text),
      remove: (_context, id, choices) => notes.remove(id, choices),
      state: () => notes.state(),
    },
    events: ['changed', 'state'],
    status: () => notes.status(),
  });
  notes.on((event, payload) => announceNotes(event, payload));

  const agenda = createAgendaService({ file: agendaFile, appVersion, log });
  const announceAgenda = hub.register('agenda', {
    methods: {
      list: () => agenda.list(),
      add: (_context, date, title) => agenda.add(date, title),
      rename: (_context, id, title) => agenda.rename(id, title),
      remove: (_context, id, choices) => agenda.remove(id, choices),
      state: () => agenda.state(),
    },
    events: ['changed', 'state'],
    status: () => agenda.status(),
  });
  agenda.on((event, payload) => announceAgenda(event, payload));

  // Système : des mesures réelles, en lecture seule.
  const system = createSystemService({
    appVersion,
    variant: updates.state().variant,
    dataDir: typeof systemOptions.dataDir === 'string' ? systemOptions.dataDir : null,
    versions: systemOptions.versions ?? {},
    processes: typeof systemOptions.processes === 'function' ? systemOptions.processes : null,
  });
  hub.register('system', {
    methods: {
      overview: () => system.overview(),
      sample: () => system.sample(),
    },
    status: () => system.status(),
  });

  return {
    hub,
    settings,
    files,
    updates,
    notes,
    agenda,
    system,
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
      let saved = true;
      // Chacun à son tour : un échec n'empêche pas l'enregistrement des autres.
      for (const [name, store] of [['réglages', settings], ['notes', notes], ['agenda', agenda]]) {
        try {
          if (store.flushSync() !== true) saved = false;
        } catch (error) {
          log(`Services : enregistrement final impossible (${name}) : ${error?.message ?? error}`);
          saved = false;
        }
      }
      return saved;
    },
    /** Inventaire et état des services — et des opérations sur les fichiers, qui n'en sont pas un. */
    describe: () => ({
      ...hub.describe(),
      'file-operations': { state: 'available', access: 'dedicated-functions', ...operations.status(), methods: [...FILE_OPERATIONS], events: ['progress'] },
    }),
  };
}

module.exports = { createServices, FILE_OPERATIONS };

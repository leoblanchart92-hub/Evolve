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
 */

const { createFilesService } = require('./files');
const { createHub } = require('./hub');
const { createSettingsService } = require('./settings');

/**
 * @param {object} [options]
 * @param {string|null} [options.settingsFile]  fichier des réglages ; `null` :
 *        réglages en mémoire seulement (rien n'est lu ni écrit)
 * @param {string|null} [options.appVersion]
 * @param {object} [options.files]  emplacements que l'explorateur peut
 *        consulter : `places` (dossiers personnels connus de l'hôte), `drives`
 *        (`'auto'` : lecteurs locaux) et `fs` (voir files.js). Sans cette
 *        option, aucun dossier n'est consultable.
 * @param {(message: string) => void} [options.log]
 */
function createServices({ settingsFile = null, appVersion = null, files: fileOptions = {}, log = () => {} } = {}) {
  const hub = createHub({ log });
  const settings = createSettingsService({ file: settingsFile, appVersion, log });
  const files = createFilesService(fileOptions);

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
    /** Inventaire et état des services. */
    describe: () => hub.describe(),
  };
}

module.exports = { createServices };

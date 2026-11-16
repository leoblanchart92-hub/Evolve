'use strict';

/**
 * Evolve — Service des mises à jour.
 *
 * Décide, et ne fait rien d'autre : ce service ne connaît ni le réseau, ni le
 * disque, ni Windows. L'hôte lui remet un « moteur » (voir
 * src/main/update-engine.js) qui sait lire la description de la dernière
 * version publiée, télécharger son installateur en le vérifiant, et le lancer.
 *
 *   - Seule la version INSTALLÉE d'Evolve se met à jour. L'exécutable
 *     portable ne se connecte jamais au réseau : le service s'y déclare
 *     indisponible, et aucune recherche n'a lieu.
 *   - Rien n'est téléchargé ni installé sans une demande explicite : la
 *     recherche ne fait que lire une description de quelques lignes ;
 *     `download` puis `install` sont deux demandes distinctes, et la seconde
 *     exige une confirmation.
 *   - Une version n'est proposée que si elle est strictement plus récente que
 *     celle en cours : jamais de retour à une version antérieure.
 *   - L'installateur n'est jamais désigné par la description publiée : son nom
 *     et son adresse se déduisent du numéro de version. La description ne
 *     fournit que ce numéro, une taille et une empreinte, que le moteur
 *     vérifie avant de lancer quoi que ce soit.
 *
 * États : « idle » (rien de su), « checking », « up-to-date », « available »,
 * « downloading », « ready » (téléchargée et vérifiée), « installing ».
 */

const { ServiceError } = require('./hub');

/** Format de la description d'une version (evolve-update.json). */
const MANIFEST_SCHEMA = 1;
/** Nom du fichier de description, joint à chaque version publiée. */
const MANIFEST_FILE = 'evolve-update.json';

/** Numéro de version : trois nombres, sans zéro superflu. */
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
/** Empreinte SHA-512, en hexadécimal. */
const SHA512 = /^[0-9a-f]{128}$/;
/** Taille plausible d'un installateur : de 1 Mo à 1 Go. */
const MIN_SIZE = 1024 * 1024;
const MAX_SIZE = 1024 * 1024 * 1024;

/** Dépôt où Evolve est publié. */
const REPOSITORY = Object.freeze({ owner: 'leoblanchart92-hub', name: 'Evolve' });

/** Façons dont Evolve peut être lancé ; seule la première se met à jour. */
const VARIANTS = Object.freeze(['installed', 'portable', 'unpacked', 'development']);

/** Messages des incidents, par code. */
const MESSAGES = Object.freeze({
  offline: 'Impossible de joindre GitHub, où Evolve est publié. Vérifiez la connexion à Internet, puis réessayez.',
  unreachable: 'GitHub a répondu par une erreur. Réessayez un peu plus tard.',
  'invalid-manifest': "La description de la dernière version est illisible : rien n'a été téléchargé.",
  'unsupported-manifest': "Une version plus récente existe, mais cette version d'Evolve ne sait pas l'installer d'elle-même. Téléchargez le nouvel installateur depuis la page des versions.",
  'download-failed': "Le téléchargement a été interrompu. Rien n'a été installé.",
  checksum: "Le fichier téléchargé ne correspond pas à l'empreinte publiée : il a été supprimé, et rien n'a été installé.",
  disk: "Le fichier n'a pas pu être enregistré dans le dossier temporaire. Vérifiez l'espace libre du disque.",
  'install-failed': "L'installateur n'a pas pu être lancé. Evolve n'a pas été modifié.",
  failed: "La mise à jour a rencontré une erreur. Evolve n'a pas été modifié.",
});

/** Nom de l'installateur d'une version. */
function setupFileName(version) {
  return `Evolve-Setup-${version}.exe`;
}

/**
 * Compare deux numéros de version.
 * @returns {-1|0|1}
 * @throws {TypeError} si l'un des deux n'est pas un numéro de version
 */
function compareVersions(first, second) {
  const parse = (value) => {
    const match = typeof value === 'string' ? value.match(VERSION) : null;
    if (!match) throw new TypeError(`Numéro de version invalide : ${value}`);
    return match.slice(1).map(Number);
  };
  const a = parse(first);
  const b = parse(second);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/**
 * Contrôle la description d'une version publiée.
 * @param {any} data  contenu de evolve-update.json, déjà analysé
 * @returns {{ ok: true, manifest: { version: string, date: string|null, file: string, size: number, sha512: string } }
 *   | { ok: false, code: 'invalid-manifest'|'unsupported-manifest', detail: string }}
 */
function parseManifest(data) {
  const refuse = (detail, code = 'invalid-manifest') => ({ ok: false, code, detail });
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return refuse('la description n’est pas un objet');
  if (!Number.isInteger(data.schema) || data.schema < 1) return refuse('format non indiqué');
  // Un format plus récent : cette version ne sait pas le lire, et ne devine rien.
  if (data.schema > MANIFEST_SCHEMA) return refuse(`format ${data.schema} inconnu de cette version`, 'unsupported-manifest');
  if (typeof data.version !== 'string' || !VERSION.test(data.version)) return refuse('numéro de version invalide');
  const { setup } = data;
  if (typeof setup !== 'object' || setup === null || Array.isArray(setup)) return refuse('installateur non décrit');
  // Le nom de l'installateur n'est pas un choix de la description : il se déduit de la version.
  if (setup.file !== setupFileName(data.version)) return refuse('nom d’installateur inattendu');
  if (!Number.isInteger(setup.size) || setup.size < MIN_SIZE || setup.size > MAX_SIZE) return refuse('taille d’installateur invraisemblable');
  if (typeof setup.sha512 !== 'string' || !SHA512.test(setup.sha512)) return refuse('empreinte invalide');
  const time = typeof data.date === 'string' ? Date.parse(data.date) : Number.NaN;
  return {
    ok: true,
    manifest: { version: data.version, date: Number.isFinite(time) ? new Date(time).toISOString() : null, file: setup.file, size: setup.size, sha512: setup.sha512 },
  };
}

/** Adresse analysée, ou `null` si elle est illisible. */
function parseUrl(address) {
  try {
    return new URL(String(address));
  } catch {
    return null;
  }
}

/** Vrai si l'adresse désigne la machine elle-même, en « http ». */
function isLoopbackHttp(url) {
  return url !== null && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}

/**
 * Adresses de publication : la description de la dernière version, et
 * l'installateur d'une version donnée. `admits(adresse)` dit si une requête
 * peut partir vers une adresse, ou une réponse en venir : seulement en
 * « https » — GitHub redirige un téléchargement vers ses serveurs de fichiers,
 * dont le nom n'est pas fixe ; l'empreinte publiée garantit le fichier.
 * @returns {{ kind: 'github', page: string, manifestUrl: string, setupUrl: (version: string) => string, secure: true, admits: (address: string) => boolean }}
 */
function productionFeed({ owner = REPOSITORY.owner, name = REPOSITORY.name } = {}) {
  const releases = `https://github.com/${owner}/${name}/releases`;
  return Object.freeze({
    kind: 'github',
    page: releases,
    manifestUrl: `${releases}/latest/download/${MANIFEST_FILE}`,
    setupUrl: (version) => `${releases}/download/v${version}/${setupFileName(version)}`,
    secure: true,
    admits: (address) => parseUrl(address)?.protocol === 'https:',
  });
}

/**
 * Adresses d'essai, pour la vérification automatique de la mise à jour : un
 * serveur de la machine elle-même, et rien d'autre. Toute autre adresse est
 * refusée — une option de la ligne de commande ne peut pas faire installer un
 * fichier venu d'ailleurs.
 * @param {string} address  « http://127.0.0.1:PORT » (ou « localhost »), suivi d'un chemin facultatif
 * @returns {object|null} `null` si l'adresse est refusée
 */
function localFeed(address) {
  const url = parseUrl(address);
  if (!isLoopbackHttp(url) || url.username || url.password || url.search || url.hash) return null;
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  return Object.freeze({
    kind: 'local',
    page: base,
    manifestUrl: `${base}/${MANIFEST_FILE}`,
    setupUrl: (version) => `${base}/${setupFileName(version)}`,
    secure: false,
    // La machine elle-même, et rien d'autre : aucune requête ne part vers le réseau.
    admits: (candidate) => isLoopbackHttp(parseUrl(candidate)),
  });
}

/**
 * @param {object} [options]
 * @param {'installed'|'portable'|'unpacked'|'development'} [options.variant]  façon dont Evolve a été lancé
 * @param {string} [options.currentVersion]  version en cours
 * @param {object|null} [options.engine]  moteur fourni par l'hôte :
 *        `readManifest()` → `{ status: 'none' }` (aucune version publiée) ou `{ status: 'ok', data }` ;
 *        `download(manifest, { onProgress, signal })` → `{ file }`, une fois le fichier vérifié ;
 *        `install(file, manifest)` → lance l'installateur ;
 *        chacune rejette avec une erreur dont le `code` figure dans MESSAGES
 * @param {() => boolean} [options.automatic]  réglage « rechercher au lancement »
 * @param {() => boolean} [options.busy]  vrai tant qu'une opération sur les fichiers est en cours
 * @param {() => void} [options.quit]  ferme l'application, une fois l'installateur lancé
 * @param {boolean} [options.updated]  cette session suit immédiatement une mise à jour
 * @param {string|null} [options.page]  page où les versions sont publiées (affichée à l'utilisateur)
 * @param {() => number} [options.now]
 * @param {(message: string) => void} [options.log]
 */
function createUpdatesService({
  variant = 'development',
  currentVersion = null,
  engine = null,
  automatic = () => true,
  busy = () => false,
  quit = () => {},
  updated = false,
  page = null,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const kind = VARIANTS.includes(variant) ? variant : 'development';
  const current = typeof currentVersion === 'string' && VERSION.test(currentVersion) ? currentVersion : null;
  const supported = kind === 'installed' && engine !== null && current !== null;

  /** @type {'idle'|'checking'|'up-to-date'|'available'|'downloading'|'ready'|'installing'} */
  let status = 'idle';
  /** Version proposée : description contrôlée de la dernière version, si elle est plus récente. */
  let offered = null;
  /** Dernière version publiée, d'après la dernière recherche (`null` : aucune, ou rien de su). */
  let latest = null;
  let progress = null;
  let failure = null;
  let checkedAt = null;
  /** Installateur téléchargé et vérifié de la version proposée. */
  let readyFile = null;
  /** Recherche en cours (une seule à la fois). */
  let checking = null;
  /** Téléchargement en cours : de quoi l'interrompre, et sa fin. */
  let transfer = null;

  const listeners = new Set();

  const isAutomatic = () => {
    try {
      return automatic() === true;
    } catch {
      return false;
    }
  };

  /** État public, tel que l'interface le reçoit. */
  function state() {
    return {
      variant: kind,
      supported,
      current,
      status,
      available: offered ? { version: offered.version, size: offered.size, date: offered.date } : null,
      latest,
      progress: progress ? { ...progress } : null,
      error: failure ? { ...failure } : null,
      checkedAt,
      automatic: isAutomatic(),
      updated: updated === true,
      page,
    };
  }

  function emit(origin = null) {
    const snapshot = state();
    for (const listener of [...listeners]) {
      try {
        listener('changed', snapshot, origin);
      } catch (error) {
        log(`Mises à jour : abonné en erreur : ${error?.message ?? error}`);
      }
    }
  }

  const describe = (error) => {
    const code = typeof error?.code === 'string' && Object.hasOwn(MESSAGES, error.code) ? error.code : 'failed';
    return { code, message: MESSAGES[code] };
  };

  function requireSupported() {
    if (supported) return;
    if (kind === 'portable') throw new ServiceError('unsupported', "L'exécutable portable ne se met pas à jour de lui-même : il ne se connecte jamais au réseau.");
    throw new ServiceError('unsupported', "Les mises à jour ne concernent que la version installée d'Evolve.");
  }

  /** Recherche la dernière version publiée. Une seule recherche a lieu à la fois. */
  function check({ origin = null } = {}) {
    requireSupported();
    if (status === 'downloading' || status === 'installing') throw new ServiceError('busy', 'Une mise à jour est en cours.');
    if (checking) return checking;

    const before = status;
    status = 'checking';
    failure = null;
    emit(origin);

    checking = (async () => {
      try {
        const reply = await engine.readManifest();
        checkedAt = new Date(now()).toISOString();
        if (reply?.status === 'none') {
          // Aucune version n'est encore publiée : il n'y a rien de plus récent.
          latest = null;
          offered = null;
          readyFile = null;
          status = 'up-to-date';
          return state();
        }
        const parsed = parseManifest(reply?.data);
        if (!parsed.ok) {
          log(`Mises à jour : description refusée (${parsed.detail}).`);
          throw Object.assign(new Error(parsed.detail), { code: parsed.code });
        }
        const { manifest } = parsed;
        latest = manifest.version;
        if (compareVersions(manifest.version, current) <= 0) {
          offered = null;
          readyFile = null;
          status = 'up-to-date';
          return state();
        }
        // Un installateur déjà téléchargé reste prêt s'il s'agit bien du même fichier.
        const same = offered !== null && offered.version === manifest.version && offered.sha512 === manifest.sha512 && offered.size === manifest.size;
        offered = manifest;
        if (!same) readyFile = null;
        status = readyFile ? 'ready' : 'available';
        return state();
      } catch (error) {
        // La recherche a échoué : ce qui était su avant elle le reste.
        failure = describe(error);
        status = before === 'checking' ? 'idle' : before;
        if (!(error instanceof Error && typeof error.code === 'string')) log(`Mises à jour : recherche impossible : ${error?.stack ?? error}`);
        return state();
      } finally {
        checking = null;
        emit(origin);
      }
    })();
    return checking;
  }

  /**
   * Télécharge l'installateur de la version proposée. Rend la main dès que le
   * téléchargement a commencé : sa progression et sa fin sont annoncées par
   * l'événement « changed ».
   */
  function download({ origin = null } = {}) {
    requireSupported();
    if (status === 'ready' || status === 'downloading') return state();
    if (status !== 'available' || !offered) throw new ServiceError('nothing-to-download', "Aucune mise à jour n'est proposée.");

    const manifest = offered;
    const controller = new AbortController();
    const own = { controller, done: Promise.resolve() };
    let lastShown = 0;
    transfer = own;
    status = 'downloading';
    failure = null;
    progress = { received: 0, total: manifest.size };
    emit(origin);

    const onProgress = (received) => {
      if (transfer !== own || !Number.isFinite(received)) return;
      progress = { received: Math.max(0, Math.min(manifest.size, Math.round(received))), total: manifest.size };
      // Une annonce par centième de la taille, au plus.
      if (progress.received - lastShown < manifest.size / 100 && progress.received < manifest.size) return;
      lastShown = progress.received;
      emit();
    };

    own.done = (async () => {
      try {
        const result = await engine.download(manifest, { onProgress, signal: controller.signal });
        if (controller.signal.aborted) throw Object.assign(new Error('interrompu'), { code: 'cancelled' });
        if (typeof result?.file !== 'string' || result.file === '') throw Object.assign(new Error('aucun fichier'), { code: 'download-failed' });
        readyFile = result.file;
        status = 'ready';
      } catch (error) {
        readyFile = null;
        status = 'available';
        // Interrompu à la demande de l'utilisateur : ce n'est pas un incident.
        if (!controller.signal.aborted) {
          failure = describe(typeof error?.code === 'string' ? error : { code: 'download-failed' });
          log(`Mises à jour : téléchargement impossible : ${error?.message ?? error}`);
        }
      } finally {
        progress = null;
        if (transfer === own) transfer = null;
        emit();
      }
    })();
    return state();
  }

  /** Interrompt le téléchargement en cours. Sans effet s'il n'y en a pas. */
  function cancel() {
    if (!transfer) return state();
    transfer.controller.abort();
    return state();
  }

  /**
   * Lance l'installateur téléchargé, puis ferme Evolve : il se rouvrira dans
   * sa nouvelle version. Exige une confirmation explicite.
   * @param {{ confirmed?: boolean }} [choices]
   */
  async function install(choices, { origin = null } = {}) {
    requireSupported();
    if (status === 'installing') return true;
    if (status !== 'ready' || !readyFile || !offered) throw new ServiceError('nothing-to-install', "Aucune mise à jour n'est prête à être installée.");
    if (choices?.confirmed !== true) throw new ServiceError('confirmation-required', "L'installation d'une mise à jour ferme Evolve : elle doit être confirmée.");
    let occupied = false;
    try {
      occupied = busy() === true;
    } catch {
      occupied = false;
    }
    if (occupied) throw new ServiceError('busy', "Une opération sur des fichiers est en cours : attendez qu'elle se termine avant d'installer la mise à jour.");

    status = 'installing';
    failure = null;
    emit(origin);
    try {
      await engine.install(readyFile, offered);
    } catch (error) {
      status = 'ready';
      failure = describe(typeof error?.code === 'string' && Object.hasOwn(MESSAGES, error.code) ? error : { code: 'install-failed' });
      log(`Mises à jour : installation impossible : ${error?.message ?? error}`);
      emit(origin);
      throw new ServiceError(failure.code, failure.message);
    }
    // L'installateur attend la fermeture d'Evolve pour remplacer ses fichiers.
    try {
      quit();
    } catch (error) {
      log(`Mises à jour : fermeture impossible : ${error?.message ?? error}`);
    }
    return true;
  }

  return {
    // --- Méthodes publiques (appelables par l'interface) ---------------------------

    state,
    check,
    download,
    cancel,
    install,

    // --- Usage interne (jamais exposé à l'interface) -------------------------------

    /**
     * Recherche faite au lancement, si le réglage le demande. Ne lève jamais
     * d'exception : un échec est seulement retenu dans l'état.
     * @returns {Promise<object|null>} l'état après la recherche, ou `null` si elle n'a pas eu lieu
     */
    async checkAtLaunch() {
      if (!supported || !isAutomatic()) return null;
      try {
        return await check({ origin: null });
      } catch {
        return null;
      }
    },

    /** Fin du téléchargement en cours (résolue aussitôt s'il n'y en a pas). */
    settled() {
      return transfer ? transfer.done : Promise.resolve();
    },

    /** Annonce l'état à nouveau (le réglage « rechercher au lancement » a changé). */
    refresh() {
      emit();
    },

    /** État détaillé, pour les comptes rendus et les vérifications automatiques. */
    status() {
      return {
        state: supported ? 'available' : 'unavailable',
        variant: kind,
        supported,
        current,
        status,
        latest,
        available: offered ? offered.version : null,
        ready: readyFile !== null,
        automatic: isAutomatic(),
        checkedAt,
        error: failure ? failure.code : null,
        page,
      };
    },

    /** Abonne `listener('changed', état, origine)` ; renvoie une fonction de désabonnement. */
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Interrompt un téléchargement en cours (arrêt de l'application). */
    dispose() {
      if (transfer) transfer.controller.abort();
    },
  };
}

module.exports = {
  createUpdatesService,
  compareVersions,
  parseManifest,
  productionFeed,
  localFeed,
  setupFileName,
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  MESSAGES,
  REPOSITORY,
  VARIANTS,
};

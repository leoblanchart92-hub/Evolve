'use strict';

/**
 * Evolve — Service « files » : consultation des dossiers de l'ordinateur.
 *
 * LECTURE SEULE. Ce service sait deux choses : dresser la liste des
 * emplacements (dossiers personnels et lecteurs) et lire le contenu d'un
 * dossier (noms, types, tailles, dates). Il ne crée, ne modifie, ne déplace
 * et ne supprime rien, et n'ouvre jamais le contenu d'un fichier : il
 * n'utilise que les quatre fonctions de lecture de `READ_ONLY_CALLS`.
 *
 * Emplacements autorisés : les dossiers personnels indiqués par l'hôte
 * (Bureau, Documents, Téléchargements, Images, Musique, Vidéos) et les
 * lecteurs locaux. Chaque chemin demandé est contrôlé ici, deux fois :
 *   1. sa forme — un chemin complet de cet ordinateur, sans « .. », sans
 *      partage réseau (\\serveur\…), sans espace de noms (\\?\, \\.\), sans
 *      flux secondaire (fichier:flux) ni nom de périphérique (NUL, COM1…) —
 *      et son appartenance à un emplacement autorisé, avant tout accès au
 *      disque ;
 *   2. sa destination réelle — liens symboliques et jonctions résolus par le
 *      système — qui doit elle aussi se trouver dans un emplacement autorisé.
 * Le dossier lu est toujours cette destination réelle. Le contenu d'un
 * dossier est décrit sans jamais suivre les liens qu'il contient.
 *
 * Lecteurs réseau : un lecteur dont la racine mène ailleurs (lettre associée
 * à un partage réseau, lecteur virtuel) n'est pas un emplacement autorisé.
 * Un lecteur qui ne répond pas (serveur injoignable) ne bloque ni
 * l'application ni les autres lectures : voir `scanDrives`.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { promisify } = require('node:util');

const { ServiceError } = require('./hub');

/** Dossiers personnels, dans l'ordre où ils sont présentés. */
const PLACE_IDS = Object.freeze(['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos']);

/** Les seules fonctions du système de fichiers utilisées : toutes de lecture. */
const READ_ONLY_CALLS = Object.freeze(['opendir', 'lstat', 'realpath', 'statfs']);

const DEFAULT_LIMITS = Object.freeze({
  /** Nombre maximal d'éléments décrits pour un dossier. */
  entries: 5000,
  /** Longueur maximale d'un chemin (celle de Windows). */
  pathLength: 32_767,
  /** Attente maximale de la réponse d'un lecteur ou d'un dossier personnel. */
  probeMs: 2000,
  /** Lecteurs interrogés en même temps, réponses tardives comprises. */
  probes: 2,
  /** Éléments d'un dossier décrits en même temps. */
  parallel: 8,
});

/** Lettres de lecteur, disques durs d'abord : A et B (disquettes) peuvent tarder à répondre. */
const DRIVE_LETTERS = Object.freeze([...'CDEFGHIJKLMNOPQRSTUVWXYZAB']);

const CONTROL_CHARACTERS = /[\u0000-\u001f]/;
/** Caractères interdits dans un nom sous Windows ; « : » désignerait un flux secondaire. */
const WINDOWS_FORBIDDEN = /[<>:"|?*]/;
/** Noms que Windows réserve à des périphériques, avec ou sans extension. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[\d\u00b9\u00b2\u00b3]|lpt[\d\u00b9\u00b2\u00b3]|conin\$|conout\$) *(?:\..*)?$/i;
/** « . », « .. » et leurs variantes faites de points et d'espaces. */
const DOTS_ONLY = /^[. ]+$/;

/**
 * Éléments que l'Explorateur de Windows masque. L'attribut « caché » de
 * Windows n'est pas accessible ici : seuls ces noms connus sont signalés
 * (`hidden`), ce qui reste une approximation.
 */
const HIDDEN_ANYWHERE = new Set(['desktop.ini', 'thumbs.db']);
const HIDDEN_PROFILE_FILE = /^ntuser\.(?:dat|ini|pol)/i;
const HIDDEN_AT_DRIVE_ROOT = new Set([
  'system volume information',
  'recovery',
  'config.msi',
  'programdata',
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys',
  'dumpstack.log',
  'dumpstack.log.tmp',
  'bootmgr',
  'bootnxt',
  'bootsect.bak',
]);
/** Jonctions de compatibilité créées par Windows (noms anglais et français). */
const HIDDEN_LINKS = new Set([
  'application data',
  'cookies',
  'local settings',
  'my documents',
  'mes documents',
  'my music',
  'ma musique',
  'my pictures',
  'mes images',
  'my videos',
  'mes vidéos',
  'nethood',
  'voisinage réseau',
  'printhood',
  "voisinage d'impression",
  'recent',
  'sendto',
  'start menu',
  'menu démarrer',
  'templates',
  'modèles',
  'documents and settings',
  'programmes',
  'fichiers communs',
  'all users',
  'default user',
  'history',
  'historique',
  'temporary internet files',
]);
const WINDOWS_USERS_FOLDER = /^[A-Z]:\\Users$/i;
const WINDOWS_PROFILE_FOLDER = /^[A-Z]:\\Users\\[^\\]+$/i;

const TIMED_OUT = Symbol('délai dépassé');

/** Attend `promise` au plus `ms` millisecondes ; au-delà, renvoie `TIMED_OUT`. */
function within(promise, ms) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/** Applique `task` à chaque élément, `parallel` à la fois ; conserve l'ordre. */
async function mapLimited(items, parallel, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, worker));
  return results;
}

/** Les quatre fonctions de lecture, tirées d'un module de type `node:fs`. */
function readOnlyAccess(fsModule) {
  return {
    opendir: promisify(fsModule.opendir),
    lstat: promisify(fsModule.lstat),
    // Résolution par le système lui-même (liens symboliques, jonctions, noms courts).
    realpath: promisify(fsModule.realpath.native),
    statfs: promisify(fsModule.statfs),
  };
}

const refused = (code, message) => new ServiceError(code, message);
const invalidPath = () => refused('invalid-path', 'Chemin refusé : seul un dossier de cet ordinateur, désigné par son chemin complet, peut être consulté.');
const outsideAllowed = () => refused('outside-allowed', "Ce dossier ne fait pas partie des emplacements qu'Evolve est autorisé à consulter.");
const leadsOutside = () => refused('leads-outside', "Cet élément mène en dehors des emplacements qu'Evolve est autorisé à consulter.");
const notADirectory = () => refused('not-a-directory', "Cet élément n'est pas un dossier.");

/** Erreur du système traduite en erreur du service (aucun détail interne n'est transmis). */
function translate(error) {
  if (error instanceof ServiceError) return error;
  switch (error?.code) {
    case 'ENOENT':
      return refused('not-found', 'Ce dossier est introuvable : il a peut-être été déplacé, renommé ou supprimé.');
    case 'ENOTDIR':
      return notADirectory();
    case 'EACCES':
    case 'EPERM':
      return refused('access-denied', "Accès refusé : Windows n'autorise pas votre compte à ouvrir ce dossier.");
    case 'ENAMETOOLONG':
      return invalidPath();
    default:
      return refused('unavailable', 'Cet emplacement est indisponible pour le moment (lecteur non prêt ou erreur de lecture).');
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.platform]  système visé (par défaut : celui en cours)
 * @param {Record<string, string|null> | (() => Record<string, string|null>)} [options.places]
 *        dossiers personnels connus de l'hôte : { desktop, documents, downloads,
 *        pictures, music, videos } — ou une fonction qui les renvoie, appelée à
 *        la première recherche des emplacements
 * @param {'auto'|string[]} [options.drives]  lecteurs autorisés. `'auto'` :
 *        les lecteurs locaux sont recherchés, et un dossier personnel n'est
 *        consulté que s'il se trouve sur l'un d'eux. Une liste les fixe.
 *        Par défaut : aucun lecteur.
 * @param {object} [options.fs]  module de type `node:fs` (Electron :
 *        `original-fs`, qui ne traite pas les archives .asar comme des dossiers)
 * @param {Record<string, string>} [options.env]
 * @param {Partial<typeof DEFAULT_LIMITS>} [options.limits]
 */
function createFilesService({ platform = process.platform, places = {}, drives = [], fs = nodeFs, env = process.env, limits: customLimits = {} } = {}) {
  const isWindows = platform === 'win32';
  const P = isWindows ? nodePath.win32 : nodePath.posix;
  const limits = { ...DEFAULT_LIMITS, ...customLimits };
  const disk = readOnlyAccess(fs);
  const autoDrives = drives === 'auto';
  const systemDrive = isWindows && /^[A-Za-z]:$/.test(env.SystemDrive ?? '') ? env.SystemDrive[0].toUpperCase() : null;

  /** Emplacements autorisés ; `null` tant qu'ils n'ont pas été recherchés. */
  let roots = null;
  /** Dernier état connu, pour les comptes rendus. */
  let known = { places: null, drives: null };
  let refreshing = null;
  /** Dossiers personnels indiqués par l'hôte (demandés une seule fois). */
  let givenPlaces = null;

  /** Lecteurs : dernière réponse de chacun (sa description, ou `null` s'il est absent). */
  const driveStates = new Map();
  /** Lecteurs interrogés dont la réponse n'est pas encore arrivée. */
  const probes = new Map();
  /** Lecteurs qui n'ont pas répondu à temps : interrogés à part, sans attendre. */
  const slowDrives = new Set();
  let slowTurn = 0;
  /** Lectures en cours : dossiers personnels et contenus de dossiers, par chemin. */
  const pendingPlaces = new Map();
  const pendingLists = new Map();

  /**
   * Contrôle la forme d'un chemin et le renvoie normalisé. Aucun accès au disque.
   * @returns {string}
   */
  function checkPath(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > limits.pathLength || CONTROL_CHARACTERS.test(value)) {
      throw invalidPath();
    }
    if (!isWindows) {
      if (!value.startsWith('/')) throw invalidPath();
      const parts = value.split('/').filter(Boolean);
      if (parts.some((part) => DOTS_ONLY.test(part))) throw invalidPath();
      return `/${parts.join('/')}`;
    }
    // Une lettre de lecteur suivie d'un séparateur : ni chemin relatif, ni
    // partage réseau (\\serveur\…), ni espace de noms (\\?\, \\.\).
    if (!/^[A-Za-z]:[\\/]/.test(value)) throw invalidPath();
    const parts = value.slice(3).split(/[\\/]/).filter(Boolean);
    for (const part of parts) {
      if (DOTS_ONLY.test(part) || WINDOWS_FORBIDDEN.test(part) || WINDOWS_DEVICE.test(part)) throw invalidPath();
    }
    return `${value[0].toUpperCase()}:\\${parts.join('\\')}`;
  }

  /** Vrai si `candidate` est `rootPath` ou se trouve à l'intérieur. */
  function isInside(rootPath, candidate) {
    const relative = P.relative(rootPath, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${P.sep}`) && !P.isAbsolute(relative));
  }

  /** Emplacement autorisé le plus précis qui contient `candidate`. */
  function rootOf(candidate, list) {
    let best = null;
    for (const root of list) {
      if (isInside(root.path, candidate) && (!best || root.path.length > best.path.length)) best = root;
    }
    return best;
  }

  const comparable = (location) => (isWindows ? location.toLowerCase() : location);
  const sameLocation = (a, b) => comparable(a) === comparable(b);

  // --- Lecteurs ---------------------------------------------------------------

  /** Racines à interroger : « C:\ »… ou « / ». */
  function driveCandidates() {
    if (autoDrives) return isWindows ? DRIVE_LETTERS.map((letter) => `${letter}:\\`) : ['/'];
    const candidates = [];
    for (const given of Array.isArray(drives) ? drives : []) {
      try {
        const root = checkPath(given);
        // Un lecteur est la racine d'un volume : « C:\ » ou « / ».
        if (P.parse(root).root === root && !candidates.includes(root)) candidates.push(root);
      } catch {
        /* lecteur mal désigné : ignoré */
      }
    }
    return candidates;
  }

  /** Lecteur : `null` s'il est absent, non prêt, ou s'il mène ailleurs (lecteur réseau, lecteur virtuel). */
  async function describeDrive(root) {
    const real = await disk.realpath(root);
    if (!sameLocation(real, root)) return null;
    let totalBytes = null;
    let freeBytes = null;
    try {
      const volume = await disk.statfs(root);
      const total = Number(volume.bsize) * Number(volume.blocks);
      const free = Number(volume.bsize) * Number(volume.bavail);
      if (Number.isFinite(total) && Number.isFinite(free) && total > 0 && free >= 0 && free <= total) {
        totalBytes = total;
        freeBytes = free;
      }
    } catch {
      /* capacité inconnue : le lecteur reste affiché */
    }
    const letter = isWindows ? root[0] : null;
    return { id: isWindows ? `${letter}:` : root, letter, path: root, system: letter !== null && letter === systemDrive, totalBytes, freeBytes };
  }

  /** Interroge un lecteur ; sa réponse, même tardive, est retenue dans `driveStates`. */
  function probe(root) {
    const pending = describeDrive(root)
      .catch(() => null)
      .then((drive) => {
        probes.delete(root);
        driveStates.set(root, drive);
        return drive;
      });
    probes.set(root, pending);
    return pending;
  }

  /**
   * Recherche les lecteurs.
   *
   * Interroger un lecteur injoignable (lettre associée à un serveur absent)
   * peut durer une minute, pendant laquelle une des quelques tâches de lecture
   * du système reste occupée. Pour ne jamais les occuper toutes :
   *   - au plus `limits.probes` lecteurs sont interrogés à la fois, en comptant
   *     ceux dont la réponse se fait encore attendre ;
   *   - une réponse est attendue `limits.probeMs` au plus ; passé ce délai, le
   *     lecteur garde son dernier état connu et est noté « lent » ;
   *   - les lecteurs lents sont ensuite interrogés à part, un seul à la fois et
   *     sans attendre : ils ne retardent plus la recherche des autres.
   */
  async function scanDrives() {
    const candidates = driveCandidates();
    const queue = candidates.filter((root) => !slowDrives.has(root));
    const worker = async () => {
      while (queue.length) {
        const root = queue.shift();
        if (probes.has(root)) continue; // réponse précédente toujours attendue
        if ((await within(probe(root), limits.probeMs)) === TIMED_OUT) {
          // Cette interrogation occupe sa place jusqu'à la réponse du système.
          slowDrives.add(root);
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(0, limits.probes - probes.size) }, worker));

    const slow = candidates.filter((root) => slowDrives.has(root));
    if (slow.length && probes.size === 0) {
      const root = slow[slowTurn % slow.length];
      slowTurn += 1;
      within(probe(root), limits.probeMs).then((answer) => {
        if (answer !== TIMED_OUT) slowDrives.delete(root); // il répond de nouveau à temps
      });
    }

    return candidates
      .map((root) => driveStates.get(root))
      .filter(Boolean)
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  // --- Dossiers personnels ------------------------------------------------------

  /** Chemin réel d'un dossier personnel, ou `null` s'il n'existe pas. */
  function locatePlace(candidate) {
    let pending = pendingPlaces.get(candidate);
    if (!pending) {
      pending = (async () => {
        const real = checkPath(await disk.realpath(candidate));
        return (await disk.lstat(real)).isDirectory() ? real : null;
      })()
        .catch(() => null)
        .finally(() => pendingPlaces.delete(candidate));
      pendingPlaces.set(candidate, pending);
    }
    return pending;
  }

  /** Dossier personnel : chemin réel, ou `null` s'il est absent ou hors des lecteurs de cet ordinateur. */
  async function resolvePlace(id, driveList) {
    const given = givenPlaces?.[id];
    if (typeof given !== 'string' || given === '') return { id, path: null };
    let candidate;
    try {
      candidate = checkPath(given);
    } catch {
      return { id, path: null }; // dossier placé sur un partage réseau, par exemple
    }
    const onLocalDrive = (location) => driveList.some((drive) => sameLocation(drive.path, P.parse(location).root));
    // Recherche automatique des lecteurs : seul un lecteur local reconnu est consulté.
    if (autoDrives && !onLocalDrive(candidate)) return { id, path: null };
    const real = await within(locatePlace(candidate), limits.probeMs);
    if (real === TIMED_OUT || real === null) return { id, path: null };
    return { id, path: autoDrives && !onLocalDrive(real) ? null : real };
  }

  /** Recherche les emplacements autorisés (dossiers personnels et lecteurs). */
  function refresh() {
    refreshing ??= (async () => {
      if (givenPlaces === null) {
        try {
          givenPlaces = (typeof places === 'function' ? places() : places) ?? {};
        } catch {
          givenPlaces = {};
        }
      }
      const driveList = await scanDrives();
      const placeList = await Promise.all(PLACE_IDS.map((id) => resolvePlace(id, driveList)));
      roots = [
        ...placeList.filter((place) => place.path).map((place) => ({ id: place.id, kind: 'place', path: place.path })),
        ...driveList.map((drive) => ({ id: drive.id, kind: 'drive', path: drive.path })),
      ];
      known = { places: placeList.filter((place) => place.path).length, drives: driveList.length };
      return {
        places: placeList.map((place) => ({ id: place.id, path: place.path, available: place.path !== null })),
        drives: driveList.map((drive) => ({ ...drive })),
      };
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function allowedRoots() {
    if (!roots) await refresh();
    return roots;
  }

  // --- Contenu d'un dossier -------------------------------------------------------

  /** Vrai pour un élément que l'Explorateur de Windows masque (noms connus seulement). */
  function isHidden(name, { link, atDriveRoot, folder }) {
    if (!isWindows) return name.startsWith('.');
    const lower = name.toLowerCase();
    if (HIDDEN_ANYWHERE.has(lower) || HIDDEN_PROFILE_FILE.test(lower)) return true;
    if (atDriveRoot && (lower.startsWith('$') || HIDDEN_AT_DRIVE_ROOT.has(lower))) return true;
    if (lower === 'appdata' && WINDOWS_PROFILE_FOLDER.test(folder)) return true;
    if (lower === 'default' && WINDOWS_USERS_FOLDER.test(folder)) return true;
    return link && HIDDEN_LINKS.has(lower);
  }

  async function listFolder(requested) {
    const allowed = await allowedRoots();
    // Hors des emplacements autorisés : refus sans toucher au disque.
    if (!rootOf(requested, allowed)) throw outsideAllowed();

    // Destination réelle : un lien ne doit mener nulle part ailleurs.
    let folder;
    try {
      folder = await disk.realpath(requested);
    } catch (error) {
      throw translate(error);
    }
    try {
      folder = checkPath(folder);
    } catch {
      throw leadsOutside(); // partage réseau, par exemple
    }
    const root = rootOf(folder, allowed);
    if (!root) throw leadsOutside();

    const found = [];
    let truncated = false;
    try {
      if (!(await disk.lstat(folder)).isDirectory()) throw notADirectory();
      // La lecture s'arrête à la limite : un dossier immense n'est jamais chargé en entier.
      const directory = await disk.opendir(folder, { bufferSize: 128 });
      for await (const item of directory) {
        if (found.length >= limits.entries) {
          truncated = true;
          break;
        }
        found.push(item);
      }
    } catch (error) {
      throw translate(error);
    }

    const atDriveRoot = root.kind === 'drive' && sameLocation(folder, root.path);
    const placeAt = new Map(allowed.filter((item) => item.kind === 'place').map((item) => [comparable(item.path), item.id]));

    const entries = await mapLimited(found, limits.parallel, async (item) => {
      const itemPath = P.join(folder, item.name);
      let kind = item.isDirectory() ? 'folder' : item.isFile() ? 'file' : item.isSymbolicLink() ? 'link' : 'other';
      let size = null;
      let modified = null;
      try {
        // Sans suivre les liens : la cible d'un lien n'est jamais consultée ici.
        const info = await disk.lstat(itemPath);
        kind = info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'folder' : info.isFile() ? 'file' : 'other';
        if (kind === 'file' && Number.isFinite(info.size)) size = info.size;
        if (Number.isFinite(info.mtimeMs)) modified = Math.round(info.mtimeMs);
      } catch {
        /* élément verrouillé ou protégé : affiché sans taille ni date */
      }
      const entry = { name: item.name, path: itemPath, kind, size, modified, hidden: isHidden(item.name, { link: kind === 'link', atDriveRoot, folder }) };
      const place = kind === 'folder' ? placeAt.get(comparable(itemPath)) : undefined;
      if (place) entry.place = place;
      return entry;
    });

    // Fil d'Ariane : de l'emplacement autorisé jusqu'au dossier.
    const trail = [];
    let step = root.path;
    for (const name of P.relative(root.path, folder).split(P.sep).filter(Boolean)) {
      step = P.join(step, name);
      trail.push({ name, path: step });
    }

    return { path: folder, root: { id: root.id, kind: root.kind, path: root.path }, trail, entries, truncated, limit: limits.entries };
  }

  /**
   * Contenu d'un dossier.
   * @param {string} input  chemin complet du dossier
   */
  async function list(input) {
    const requested = checkPath(input);
    // Une même demande répétée pendant sa lecture (dossier lent) n'est lue qu'une fois.
    const key = comparable(requested);
    let pending = pendingLists.get(key);
    if (!pending) {
      pending = listFolder(requested).finally(() => pendingLists.delete(key));
      pendingLists.set(key, pending);
    }
    return pending;
  }

  return {
    /** Dossiers personnels et lecteurs disponibles (recherchés à chaque appel). */
    places: () => refresh(),
    list,
    /** État du service, pour les comptes rendus. */
    status: () => ({ access: 'read-only', places: known.places, drives: known.drives }),
  };
}

module.exports = { createFilesService, PLACE_IDS, READ_ONLY_CALLS, DEFAULT_LIMITS };

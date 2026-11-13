'use strict';

/**
 * Evolve — Opérations sur les fichiers : créer un dossier, renommer, copier,
 * déplacer, envoyer à la Corbeille, ouvrir avec l'application associée.
 *
 * Ce module est le seul d'Evolve à modifier les fichiers de l'utilisateur.
 * Ce qu'il garantit, quelle que soit la demande reçue :
 *
 *   - RIEN N'EST SUPPRIMÉ DÉFINITIVEMENT. Aucune fonction de suppression du
 *     système de fichiers n'est employée (`WRITE_CALLS` : créer un dossier,
 *     copier un fichier — rien d'autre). Supprimer, c'est envoyer à la
 *     Corbeille, par la fonction que l'hôte fournit (`trash`) ; si elle
 *     échoue, l'élément reste à sa place et l'échec est signalé ;
 *   - RIEN N'EST REMPLACÉ, et c'est le système lui-même qui le garantit, non
 *     une vérification faite avant d'agir : entre une vérification et
 *     l'action, un autre programme pourrait créer un élément du même nom.
 *     Chaque écriture est donc une opération que le système refuse d'un seul
 *     geste si le nom d'arrivée est pris :
 *       · un dossier est créé sans option « récursive » (`mkdir`) ;
 *       · un fichier est copié en mode exclusif (`COPYFILE_EXCL`) ;
 *       · un élément est renommé ou déplacé par la fonction `moveNoReplace`
 *         de l'hôte, qui demande au système de ne déplacer que si le nom est
 *         libre (sous Windows : MoveFileExW sans l'option de remplacement,
 *         voir src/main/atomic-move.js). La fonction `rename` de Node, qui
 *         remplace le fichier en place, n'est jamais employée ; sans
 *         `moveNoReplace`, renommer et déplacer sont refusés.
 *     En cas de nom déjà pris, l'appelant choisit : conserver les deux
 *     (« nom - Copie ») ou ignorer l'élément. « Remplacer » n'existe pas ;
 *   - CHAQUE CHEMIN EST CONTRÔLÉ avant tout accès, par les contrôles du
 *     service de consultation (`guard`, voir files.js) : forme du chemin (ni
 *     relatif, ni « .. », ni réseau, ni espace de noms), emplacement autorisé,
 *     destination réelle des liens et des jonctions. Un élément est toujours
 *     désigné par son emplacement réel sur le disque ;
 *   - LES EMPLACEMENTS DE BASE SONT INTOUCHABLES : un lecteur, un dossier
 *     personnel (Bureau, Documents…), un dossier qui en contient un, et tout
 *     ce qui se trouve dans un dossier du système (Windows, Programmes,
 *     données des applications) ne peuvent être ni renommés, ni déplacés, ni
 *     envoyés à la Corbeille ; rien n'y est créé ni collé ;
 *   - LES LIENS NE SONT PAS MODIFIÉS : un lien symbolique ou une jonction
 *     n'est ni renommé, ni copié, ni déplacé, ni supprimé ; dans un dossier
 *     copié, les liens sont laissés de côté et comptés ;
 *   - un dossier n'est jamais copié ni déplacé dans lui-même ;
 *   - un dossier est copié sous un nom provisoire (« nom (copie en cours) »)
 *     et ne reçoit son nom qu'une fois complet : un dossier qui porte le nom
 *     demandé est un dossier entièrement copié. Interrompue, la copie garde
 *     un nom qui le dit (« nom (copie incomplète) ») ;
 *   - un fichier n'est jamais lu ni exécuté ici : « ouvrir » le confie à
 *     Windows (`openPath`). Seuls les types de fichiers dont l'ouverture se
 *     borne à afficher un contenu (`OPENS_AS_CONTENT` : textes, documents,
 *     images, sons, vidéos, archives) lui sont confiés directement ; tout
 *     autre fichier — programme, script, raccourci, ou type inconnu d'Evolve —
 *     ne l'est qu'après une confirmation explicite ;
 *   - déplacer, envoyer à la Corbeille et exécuter exigent que l'appelant
 *     déclare la confirmation de l'utilisateur (`confirmed: true`).
 */

const nodeFs = require('node:fs');
const { promisify } = require('node:util');

const { ServiceError } = require('./hub');
const { HIDDEN_AT_DRIVE_ROOT } = require('./files');

/**
 * Les seules fonctions du module de fichiers qui modifient le disque. Aucune ne
 * supprime, et le système refuse chacune si le nom d'arrivée existe déjà.
 * S'y ajoute le déplacement sans remplacement que l'hôte fournit (`moveNoReplace`).
 */
const WRITE_CALLS = Object.freeze(['mkdir', 'copyFile']);
/** Fonctions de lecture employées pour contrôler chaque opération. */
const READ_CALLS = Object.freeze(['lstat', 'opendir', 'realpath']);

const DEFAULT_LIMITS = Object.freeze({
  /** Éléments désignés par une même demande. */
  items: 1000,
  /** Niveaux de sous-dossiers d'un dossier copié. */
  depth: 128,
  /** Éléments comptés avant une copie, pour annoncer la progression ; au-delà, le total reste inconnu. */
  count: 100_000,
  /** Intervalle minimal entre deux annonces de progression. */
  progressMs: 120,
  /** Essais pour trouver un nom libre (« nom - Copie (2) »…). */
  names: 500,
  /** Nouveaux essais du renommage d'un dossier qui vient d'être copié, si Windows le refuse passagèrement. */
  retries: 5,
  /** Attente avant le premier nouvel essai ; elle double à chaque essai (1,9 s au plus en tout). */
  retryMs: 60,
});

/** Longueur maximale d'un nom d'élément sous Windows. */
const NAME_LENGTH = 255;

/** Identifiant d'opération fourni par l'appelant (annulation, progression). */
const OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Choix possibles quand un nom est déjà pris à destination. « Remplacer » n'en fait pas partie. */
const COLLISION_POLICIES = Object.freeze(['ask', 'keep-both', 'skip']);

/**
 * Refus que Windows oppose passagèrement au renommage d'un dossier : un autre
 * programme (antivirus, indexation) examine encore un fichier qui vient d'y
 * être écrit.
 */
const TRANSIENT_REFUSALS = new Set(['EBUSY', 'EPERM', 'EACCES']);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * À la racine d'un lecteur : dossiers et fichiers du système, par leur nom
 * (ceux que la consultation signale déjà comme masqués, et les dossiers de
 * Windows et des programmes). S'y ajoutent les noms commençant par « $ ».
 */
const SYSTEM_AT_DRIVE_ROOT = new Set([...HIDDEN_AT_DRIVE_ROOT, 'windows', 'program files', 'program files (x86)', 'documents and settings', 'msocache']);

/**
 * Types de fichiers ouverts sans confirmation : ceux dont l'ouverture se borne
 * à afficher ou à faire entendre un contenu. La règle est sûre par défaut :
 * tout fichier d'un autre type — programme, script, raccourci, ou type que
 * cette liste ne connaît pas — n'est confié à Windows qu'après une
 * confirmation explicite. Aucun type de `RUNS_CODE` ne doit figurer ici.
 */
const OPENS_AS_CONTENT = new Set([
  // Textes et données
  'txt', 'log', 'md', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'css', 'srt', 'vtt',
  // Documents
  'pdf', 'rtf', 'doc', 'docx', 'dot', 'dotx', 'odt', 'xls', 'xlsx', 'xlt', 'xltx', 'ods', 'ppt', 'pptx', 'pps', 'ppsx', 'pot', 'potx', 'odp', 'epub', 'xps', 'oxps',
  // Pages web : affichées par le navigateur, dans son bac à sable
  'html', 'htm', 'svg',
  // Images
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'gif', 'bmp', 'dib', 'tif', 'tiff', 'webp', 'ico', 'heic', 'heif', 'avif', 'psd', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng',
  // Sons
  'mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'wma', 'mid', 'midi', 'aif', 'aiff',
  // Vidéos
  'mp4', 'm4v', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'mpg', 'mpeg', '3gp', 'flv', 'ogv', 'mts', 'm2ts',
  // Archives
  'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz',
  // Polices, messages, agendas, contacts
  'ttf', 'otf', 'ttc', 'eml', 'ics', 'vcf',
]);

/**
 * Types de fichiers que Windows exécute quand on les ouvre : programmes,
 * installeurs, scripts, raccourcis, fichiers de configuration du système.
 * La confirmation demandée avant de les ouvrir le dit en toutes lettres ;
 * cette liste ne sert qu'à choisir ce message (voir `OPENS_AS_CONTENT`).
 */
const RUNS_CODE = new Set([
  // Programmes et installeurs
  'exe', 'com', 'scr', 'pif', 'cpl', 'msc', 'msi', 'msp', 'mst', 'msix', 'msixbundle', 'appx', 'appxbundle', 'appinstaller', 'application', 'appref-ms', 'gadget', 'jar', 'xbap',
  // Scripts
  'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'ps1xml', 'psc1', 'vbs', 'vbe', 'vb', 'js', 'jse', 'ws', 'wsf', 'wsc', 'wsh', 'hta', 'sct', 'py', 'pyw', 'pyc', 'pyz', 'rb', 'pl', 'sh',
  // Raccourcis et fichiers qui lancent autre chose
  'lnk', 'url', 'website', 'scf', 'shb', 'shs', 'library-ms', 'search-ms', 'searchconnector-ms', 'settingcontent-ms', 'diagcab', 'diagpkg',
  // Registre, configuration du système, aide exécutable, macros
  'reg', 'inf', 'ins', 'isp', 'chm', 'hlp', 'cer', 'crt', 'der', 'msh', 'msh1', 'msh2', 'mshxml', 'ade', 'adp', 'mde', 'accde', 'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'ppsm', 'sldm',
  // Images de disque : Windows les monte comme un lecteur
  'iso', 'img', 'vhd', 'vhdx',
]);

/** Interruption demandée par l'utilisateur. */
class Cancelled extends Error {
  constructor() {
    super('Opération annulée.');
    this.name = 'Cancelled';
  }
}

const refused = (code, message) => new ServiceError(code, message);
const badArguments = () => refused('bad-arguments', 'Demande refusée : arguments inattendus.');
const collision = () => refused('collision', 'Un élément porte déjà ce nom à cet endroit. Rien n’a été remplacé.');
const protectedRoot = () =>
  refused('protected', 'Cet emplacement est un lecteur ou un dossier personnel (Bureau, Documents…) : Evolve ne le renomme pas, ne le déplace pas et ne le supprime pas.');
const protectedContainer = () =>
  refused('protected', 'Ce dossier contient un dossier personnel ou un dossier du système : Evolve ne le renomme pas, ne le déplace pas et ne le supprime pas.');
const systemZone = () =>
  refused('protected', 'Cet emplacement appartient au système (Windows, programmes installés, données des applications) : Evolve n’y modifie rien.');
const linkNotSupported = () =>
  refused('link-not-supported', 'Cet élément est un lien (lien symbolique ou jonction) : Evolve ne modifie pas les liens et ne les ouvre pas comme des fichiers.');
const needsConfirmation = (message) => refused('needs-confirmation', message);
/** Sans la fonction de déplacement sans remplacement de l'hôte : aucune autre façon de faire n'est tentée. */
const NO_REPLACE_MISSING = "la fonction du système qui garantit qu'aucun élément n'est remplacé n'a pas pu être chargée. Rien n'a été modifié.";
const moveUnavailable = (what = 'Renommer et déplacer ne sont pas disponibles') => refused('move-unavailable', `${what} : ${NO_REPLACE_MISSING}`);
const notADirectory = () => refused('not-a-directory', "Cet élément n'est pas un dossier.");

/** Erreur du système traduite en erreur du service (aucun détail interne n'est transmis). */
function translate(error) {
  if (error instanceof ServiceError || error instanceof Cancelled) return error;
  switch (error?.code) {
    case 'ENOENT':
      return refused('not-found', 'Cet élément est introuvable : il a peut-être été déplacé, renommé ou supprimé entre-temps.');
    case 'EEXIST':
    case 'ENOTEMPTY':
      return collision();
    case 'EACCES':
    case 'EPERM':
      return refused('access-denied', "Accès refusé : Windows n'autorise pas cette opération (élément protégé, en lecture seule, ou ouvert dans un autre programme).");
    case 'EBUSY':
      return refused('in-use', 'Cet élément est utilisé par un autre programme : fermez-le, puis réessayez.');
    case 'ENOSPC':
    case 'EDQUOT':
      return refused('no-space', 'Espace insuffisant sur le lecteur de destination.');
    case 'EROFS':
      return refused('access-denied', 'Ce lecteur est protégé en écriture.');
    case 'ENAMETOOLONG':
      return refused('invalid-name', 'Le chemin obtenu serait trop long pour Windows.');
    case 'ENOTDIR':
      return notADirectory();
    case 'EXDEV':
      return refused('failed', "Cet élément ne peut pas être déplacé vers un autre lecteur de cette façon.");
    default:
      return refused('failed', "L'opération a échoué : le système a signalé une erreur.");
  }
}

/** Fonctions du système de fichiers employées, tirées d'un module de type `node:fs`. */
function diskAccess(fs) {
  return {
    lstat: promisify(fs.lstat),
    opendir: promisify(fs.opendir),
    // Résolution par le système lui-même (liens, jonctions, noms courts, casse réelle).
    realpath: promisify(fs.realpath.native),
    mkdir: promisify(fs.mkdir),
    copyFile: promisify(fs.copyFile),
    /** Copie refusée par le système si la destination existe : jamais de remplacement. */
    exclusive: fs.constants.COPYFILE_EXCL,
  };
}

/**
 * @param {object} options
 * @param {object} options.guard  contrôles de chemins du service de consultation (`createFilesService().guard`)
 * @param {object} [options.fs]   module de type `node:fs`
 * @param {Record<string, string>} [options.env]  variables d'environnement (dossiers du système)
 * @param {((location: string) => Promise<void>) | null} [options.trash]
 *        envoie un élément à la Corbeille ; doit échouer (rejet) si c'est impossible.
 *        Sans cette fonction, rien ne peut être supprimé.
 * @param {((location: string) => Promise<string>) | null} [options.openPath]
 *        confie un fichier à l'application que le système lui associe ; renvoie
 *        un texte vide, ou la description de l'échec
 * @param {((from: string, to: string) => Promise<void>) | null} [options.moveNoReplace]
 *        donne à l'élément `from` le nom `to` SANS JAMAIS RIEN REMPLACER : la
 *        vérification et le déplacement doivent être une seule opération du
 *        système. Si quoi que ce soit porte déjà le nom `to`, la promesse est
 *        rejetée avec le code « EEXIST » et rien n'est modifié ; d'un lecteur à
 *        un autre, avec le code « EXDEV ». Sans cette fonction, renommer et
 *        déplacer sont refusés : aucune autre façon de faire n'est tentée.
 * @param {Partial<typeof DEFAULT_LIMITS>} [options.limits]
 * @param {(message: string) => void} [options.log]
 */
function createFileOperations({ guard, fs = nodeFs, env = process.env, trash = null, openPath = null, moveNoReplace = null, limits: customLimits = {}, log = () => {} } = {}) {
  if (!guard || typeof guard.resolve !== 'function') throw new TypeError('Opérations sur les fichiers : contrôles de chemins manquants.');
  const P = guard.path;
  const isWindows = guard.platform === 'win32';
  const limits = { ...DEFAULT_LIMITS, ...customLimits };
  const disk = diskAccess(fs);
  const listeners = new Set();

  /** Opération en cours — une seule à la fois : { id, kind, cancelled, announced }. */
  let active = null;
  let counter = 0;
  let zoneList = null;

  // --- Déplacement sans remplacement ---------------------------------------------

  /**
   * Donne à l'élément `from` le nom `to`. C'est le système qui refuse si ce
   * nom est pris (« EEXIST ») : aucun élément n'est jamais remplacé, même créé
   * par un autre programme à l'instant du déplacement. Seule façon dont ce
   * module renomme ou déplace.
   */
  async function moveWithoutReplacing(from, to) {
    if (typeof moveNoReplace !== 'function') throw moveUnavailable();
    await moveNoReplace(from, to);
  }

  // --- Emplacements préservés ----------------------------------------------------

  /** Dossiers du système désignés par Windows : rien n'y est modifié. */
  function zones() {
    if (zoneList) return zoneList;
    const found = [];
    const add = (value) => {
      if (typeof value !== 'string' || value === '') return;
      try {
        const zone = guard.checkPath(value);
        // Jamais un lecteur entier : une variable mal renseignée ne doit pas tout interdire.
        if (P.parse(zone).root !== zone && !found.some((known) => guard.sameLocation(known, zone))) found.push(zone);
      } catch {
        /* variable inutilisable (chemin réseau, par exemple) : ignorée */
      }
    };
    if (isWindows) {
      for (const name of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'ALLUSERSPROFILE']) add(env[name]);
      for (const name of ['APPDATA', 'LOCALAPPDATA']) {
        const value = env[name];
        if (typeof value !== 'string' || value === '') continue;
        // …\AppData\Roaming, …\AppData\Local : c'est tout le dossier AppData qui est préservé.
        const parent = P.dirname(value);
        add(P.basename(parent).toLowerCase() === 'appdata' ? parent : value);
      }
    }
    zoneList = found;
    return found;
  }

  /** Vrai si `location` appartient au système : dossier désigné par Windows, ou élément du système à la racine d'un lecteur. */
  function inSystemZone(location) {
    if (zones().some((zone) => guard.isInside(zone, location))) return true;
    if (!isWindows) return false;
    const { root } = P.parse(location);
    const first = location.slice(root.length).split(P.sep)[0].toLowerCase();
    return first !== '' && (first.startsWith('$') || SYSTEM_AT_DRIVE_ROOT.has(first));
  }

  /** Vrai si `location` est, ou contient, un emplacement autorisé de base ou un dossier du système. */
  function holdsProtected(location, roots) {
    return roots.some((root) => guard.isInside(location, root.path)) || zones().some((zone) => guard.isInside(location, zone));
  }

  // --- Contrôle des demandes -------------------------------------------------------

  function readList(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > limits.items || !value.every((item) => typeof item === 'string')) throw badArguments();
    return value;
  }

  function readOptions(value, allowed) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw badArguments();
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw badArguments();
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw badArguments();
    if (value.operation !== undefined && !(typeof value.operation === 'string' && OPERATION_ID.test(value.operation))) throw badArguments();
    if (value.confirmed !== undefined && typeof value.confirmed !== 'boolean') throw badArguments();
    if (value.onCollision !== undefined && !COLLISION_POLICIES.includes(value.onCollision)) throw badArguments();
    return value;
  }

  /** Vrai si quelque chose porte ce nom (fichier, dossier ou lien, même rompu). */
  async function exists(location) {
    try {
      await disk.lstat(location);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw translate(error);
    }
  }

  /** Vrai si les deux chemins désignent le même élément du disque (« photo » et « Photo » sur un disque insensible à la casse). */
  async function sameItem(first, second) {
    try {
      const [a, b] = await Promise.all([disk.lstat(first, { bigint: true }), disk.lstat(second, { bigint: true })]);
      return Boolean(a.ino) && a.ino === b.ino && a.dev === b.dev;
    } catch {
      return false;
    }
  }

  /**
   * Élément existant sur lequel porte une opération, désigné par son
   * emplacement réel : le dossier qui le contient est résolu (liens,
   * jonctions) et contrôlé, puis l'élément lui-même — sans jamais suivre un
   * lien placé en dernier — est ramené à son nom réel sur le disque (nom
   * court « DOCUME~1 », casse, point final ignoré par Windows).
   */
  async function locateItem(input) {
    const requested = guard.checkPath(input);
    if (P.parse(requested).root === requested) throw protectedRoot();
    // Un emplacement autorisé de base (lecteur, dossier personnel) n'est jamais l'objet d'une opération.
    if ((await guard.roots()).some((root) => guard.sameLocation(root.path, requested))) throw protectedRoot();
    const parent = await guard.resolve(P.dirname(requested));
    let location = P.join(parent.path, P.basename(requested));
    let info;
    try {
      info = await disk.lstat(location);
      if (!info.isSymbolicLink()) {
        const real = guard.checkPath(await disk.realpath(location));
        // L'élément réel se trouve bien dans le dossier contrôlé.
        if (!guard.sameLocation(P.dirname(real), parent.path)) throw refused('leads-outside', "Cet élément mène en dehors des emplacements qu'Evolve est autorisé à consulter.");
        location = real;
      }
    } catch (error) {
      throw translate(error);
    }
    return { path: location, parent: parent.path, name: P.basename(location), info, roots: parent.roots };
  }

  /**
   * Refuse un élément qu'Evolve ne modifie pas.
   * @param {boolean} [options.read]  l'élément est seulement lu (copie) : il peut se trouver dans un dossier du système
   */
  function assertOperable(item, { read = false } = {}) {
    if (item.roots.some((root) => guard.sameLocation(root.path, item.path))) throw protectedRoot();
    if (item.info.isSymbolicLink()) throw linkNotSupported();
    if (holdsProtected(item.path, item.roots)) throw protectedContainer();
    if (!read && inSystemZone(item.path)) throw systemZone();
  }

  /** Dossier existant qui recevra un élément (création, collage), désigné par son emplacement réel. */
  async function locateFolder(input) {
    const folder = await guard.resolve(guard.checkPath(input));
    let info;
    try {
      info = await disk.lstat(folder.path);
    } catch (error) {
      throw translate(error);
    }
    if (!info.isDirectory()) throw notADirectory();
    if (inSystemZone(folder.path)) throw systemZone();
    return folder;
  }

  // --- Noms ---------------------------------------------------------------------------

  /** Nom libre pour une copie conservée à côté de l'original : « nom - Copie.ext », « nom - Copie (2).ext »… */
  async function copyName(folder, name, directory, taken) {
    const extension = directory ? '' : P.extname(name);
    const base = extension ? name.slice(0, -extension.length) : name;
    for (let index = 1; index <= limits.names; index += 1) {
      const suffix = index === 1 ? ' - Copie' : ` - Copie (${index})`;
      const candidate = `${base.slice(0, Math.max(1, NAME_LENGTH - suffix.length - extension.length))}${suffix}${extension}`;
      if (taken.has(guard.comparable(candidate))) continue;
      if (!(await exists(P.join(folder, candidate)))) return candidate;
    }
    throw collision();
  }

  /** Nom libre portant une mention : « nom (copie en cours) », « nom (copie incomplète 2) »… */
  async function markedName(folder, name, mark) {
    for (let index = 1; index <= limits.names; index += 1) {
      const suffix = index === 1 ? ` (${mark})` : ` (${mark} ${index})`;
      const candidate = `${name.slice(0, Math.max(1, NAME_LENGTH - suffix.length))}${suffix}`;
      if (!(await exists(P.join(folder, candidate)))) return candidate;
    }
    throw collision();
  }

  // --- Progression ---------------------------------------------------------------------

  function emit(payload) {
    for (const listener of [...listeners]) {
      try {
        listener(payload);
      } catch (error) {
        log(`Opérations sur les fichiers : abonné en erreur (${error?.message ?? error})`);
      }
    }
  }

  /** Suivi d'une opération : étapes accomplies, annulation, éléments laissés de côté. */
  function tracker(job, total) {
    return {
      done: 0,
      total,
      /** Liens et éléments spéciaux rencontrés dans les dossiers copiés : laissés de côté. */
      links: 0,
      others: 0,
      checkpoint() {
        if (job.cancelled) throw new Cancelled();
      },
      step(current) {
        this.done += 1;
        const now = Date.now();
        if (now - job.announced < limits.progressMs) return;
        job.announced = now;
        emit({ operation: job.id, kind: job.kind, state: 'running', done: this.done, total: this.total, current });
      },
    };
  }

  /** Une seule opération à la fois : aucune ne peut en croiser une autre. */
  async function exclusive(kind, requestedId, task) {
    if (active) throw refused('busy', "Une autre opération sur les fichiers est en cours : attendez qu'elle se termine.");
    counter += 1;
    const job = { id: requestedId ?? `operation-${counter}`, kind, cancelled: false, announced: 0 };
    active = job;
    try {
      return await task(job);
    } finally {
      active = null;
      emit({ operation: job.id, kind, state: 'finished' });
    }
  }

  /**
   * Nombre d'éléments d'une arborescence (dossier compris), liens exclus. Le
   * décompte s'arrête au-delà de la limite, ou dès que l'opération est annulée
   * (`budget.stopped`).
   *
   * Comme la copie, il demande à `lstat` ce qu'est chaque élément : le type
   * annoncé par la lecture d'un dossier ne suffit pas. Sous Windows, selon la
   * version de Node, une jonction y passe pour un dossier ordinaire — s'y
   * fier ferait suivre le lien — ou un fichier d'un service de synchronisation
   * pour un lien.
   */
  async function countTree(location, directory, budget) {
    budget.count += 1;
    if (!directory || budget.count > limits.count || budget.stopped()) return;
    try {
      for await (const entry of await disk.opendir(location, { bufferSize: 64 })) {
        if (budget.count > limits.count || budget.stopped()) return;
        const child = P.join(location, entry.name);
        const info = await disk.lstat(child);
        if (info.isSymbolicLink()) continue;
        await countTree(child, info.isDirectory(), budget);
      }
    } catch {
      /* dossier ou élément illisible : la copie s'arrêtera sur lui, et le signalera */
    }
  }

  // --- Copie -----------------------------------------------------------------------------

  /** Copie le contenu de `source` dans le dossier `target`, qui vient d'être créé. Les liens ne sont ni suivis ni copiés. */
  async function copyChildren(source, target, context, depth, origin) {
    if (depth > limits.depth) throw refused('too-deep', 'Ce dossier compte trop de niveaux de sous-dossiers pour être copié.');
    const within = (location) => P.relative(origin, location);
    let directory;
    try {
      directory = await disk.opendir(source, { bufferSize: 64 });
    } catch (error) {
      throw Object.assign(translate(error), { at: within(source) });
    }
    for await (const entry of directory) {
      context.checkpoint();
      const from = P.join(source, entry.name);
      const to = P.join(target, entry.name);
      try {
        const info = await disk.lstat(from);
        if (info.isSymbolicLink()) {
          context.links += 1;
        } else if (info.isDirectory()) {
          await disk.mkdir(to);
          context.step(entry.name);
          await copyChildren(from, to, context, depth + 1, origin);
        } else if (info.isFile()) {
          await disk.copyFile(from, to, disk.exclusive);
          context.step(entry.name);
        } else {
          context.others += 1;
        }
      } catch (error) {
        const failure = translate(error);
        if (failure.at === undefined) failure.at = within(from);
        throw failure;
      }
    }
  }

  /**
   * Donne son nom à un dossier qu'Evolve vient de créer et de remplir (copie
   * achevée, ou interrompue). Windows refuse de renommer un dossier tant qu'un
   * autre programme tient ouvert l'un des fichiers qu'il contient — ce que
   * fait un antivirus avec des fichiers tout juste écrits : la demande est
   * alors renouvelée pendant quelques instants. À chaque essai, c'est le
   * système qui refuse si le nom d'arrivée est pris : rien n'est jamais remplacé.
   */
  async function renameCopied(pending, target) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await moveWithoutReplacing(pending, target);
        return;
      } catch (error) {
        if (!TRANSIENT_REFUSALS.has(error?.code) || attempt >= limits.retries) throw error;
      }
      await pause(limits.retryMs * 2 ** attempt);
      // Nom pris pendant l'attente : inutile d'insister, le système refuserait encore.
      if (await exists(target)) throw collision();
    }
  }

  /** Dossier dont la copie s'est interrompue : il reçoit un nom qui le dit. Renvoie le nom sous lequel il reste. */
  async function setAside(pending, folder, name) {
    try {
      const marked = await markedName(folder, name, 'copie incomplète');
      await renameCopied(pending, P.join(folder, marked));
      return marked;
    } catch {
      return P.basename(pending);
    }
  }

  /**
   * Copie un élément dans `folder` sous le nom `name`, libre au moment du contrôle.
   * @returns {Promise<string>} chemin de la copie
   */
  async function copyItem(item, folder, name, context) {
    const target = P.join(folder, name);
    if (!item.info.isDirectory()) {
      if (!item.info.isFile()) throw refused('unsupported', "Cet élément n'est ni un fichier ni un dossier : il ne peut pas être copié.");
      context.checkpoint();
      try {
        // Refusée par le système si le nom existe : aucun fichier n'est jamais remplacé.
        await disk.copyFile(item.path, target, disk.exclusive);
      } catch (error) {
        throw translate(error);
      }
      context.step(name);
      return target;
    }

    // Dossier : copié sous un nom provisoire, pour qu'une copie interrompue
    // (erreur, annulation, arrêt de l'ordinateur) ne passe jamais pour achevée.
    // Il ne recevra son nom que par un déplacement sans remplacement : sans cette
    // fonction, rien n'est commencé.
    if (typeof moveNoReplace !== 'function') throw moveUnavailable("Ce dossier n'a pas été copié");
    context.checkpoint();
    const pending = P.join(folder, await markedName(folder, name, 'copie en cours'));
    try {
      await disk.mkdir(pending);
    } catch (error) {
      throw translate(error);
    }
    context.step(name);
    try {
      await copyChildren(item.path, pending, context, 1, item.path);
    } catch (error) {
      const failure = translate(error);
      failure.partial = await setAside(pending, folder, name);
      throw failure;
    }
    // Copie achevée : le dossier prend son nom définitif — ou, si ce nom a été pris entre-temps, un nom libre.
    // Si ce nom est pris à l'instant même du renommage, le système refuse : la copie, entière, garde
    // son nom provisoire et rien n'est remplacé.
    try {
      const final = (await exists(target)) ? P.join(folder, await copyName(folder, name, true, new Set())) : target;
      await renameCopied(pending, final);
      return final;
    } catch (error) {
      const failure = translate(error);
      failure.partial = P.basename(pending);
      failure.complete = true;
      throw failure;
    }
  }

  // --- Corbeille ------------------------------------------------------------------------

  /** Envoie un élément à la Corbeille. Aucune autre forme de suppression n'existe : en cas d'échec, l'élément reste à sa place. */
  async function sendToTrash(location) {
    if (typeof trash !== 'function') throw refused('trash-unavailable', "La Corbeille n'est pas disponible : rien n'a été supprimé.");
    try {
      await trash(location);
    } catch (error) {
      log(`Corbeille : envoi impossible (${error?.message ?? error})`);
      throw refused('trash-failed', "Windows n'a pas pu envoyer cet élément à la Corbeille : il n'a pas été supprimé et reste à sa place.");
    }
    // Contrôle : l'élément a bien quitté son emplacement.
    if (await exists(location)) throw refused('trash-failed', "Cet élément est toujours à sa place : Windows ne l'a pas envoyé à la Corbeille.");
  }

  // --- Déplacement ----------------------------------------------------------------------

  /**
   * Déplace un élément dans `folder` sous le nom `name`.
   * @returns {Promise<{ path: string, original?: 'trashed' | 'kept' }>}
   */
  async function moveItem(item, folder, name, context) {
    const target = P.join(folder, name);
    context.checkpoint();
    // Constat préalable : rien ne porte ce nom à destination. Il évite une demande inutile, mais ne
    // garantit rien — un élément peut apparaître l'instant d'après : c'est le système, en déplaçant,
    // qui refuse alors lui-même (« EEXIST ») sans rien remplacer.
    if (await exists(target)) throw collision();
    try {
      await moveWithoutReplacing(item.path, target);
      context.step(name);
      return { path: target };
    } catch (error) {
      if (error?.code !== 'EXDEV') throw translate(error);
    }
    // Autre lecteur : l'élément est copié, puis l'original est envoyé à la
    // Corbeille — jamais supprimé. Si la Corbeille le refuse, il reste en place.
    const copied = await copyItem(item, folder, name, context);
    try {
      await sendToTrash(item.path);
      return { path: copied, original: 'trashed' };
    } catch {
      return { path: copied, original: 'kept' };
    }
  }

  // --- Opérations ------------------------------------------------------------------------

  async function createFolder(parentInput, nameInput) {
    if (typeof parentInput !== 'string') throw badArguments();
    const name = guard.checkName(nameInput);
    return exclusive('create-folder', undefined, async () => {
      const folder = await locateFolder(parentInput);
      const target = P.join(folder.path, name);
      try {
        // Création simple : refusée par le système si le nom existe.
        await disk.mkdir(target);
      } catch (error) {
        throw translate(error);
      }
      return { path: target, name };
    });
  }

  async function rename(targetInput, nameInput) {
    if (typeof targetInput !== 'string') throw badArguments();
    const name = guard.checkName(nameInput);
    return exclusive('rename', undefined, async () => {
      const item = await locateItem(targetInput);
      assertOperable(item);
      if (item.name === name) return { path: item.path, name, unchanged: true };
      const target = P.join(item.parent, name);
      if (await exists(target)) {
        // Seul nom « déjà pris » admis : celui de l'élément lui-même, dont on change la casse.
        const caseOnly = item.name.toLowerCase() === name.toLowerCase() && (await sameItem(item.path, target));
        if (!caseOnly) throw collision();
      }
      // Ce constat ne garantit rien pour l'instant qui suit : en renommant, le système refuse
      // lui-même (« EEXIST ») si un élément porte ce nom, sans rien remplacer.
      try {
        await moveWithoutReplacing(item.path, target);
      } catch (error) {
        throw translate(error);
      }
      return { path: target, name };
    });
  }

  /** Copie (`kind` : « copy ») ou déplacement (« move ») de plusieurs éléments vers un dossier. */
  async function transfer(kind, sourcesInput, destinationInput, optionsInput) {
    const sources = readList(sourcesInput);
    if (typeof destinationInput !== 'string') throw badArguments();
    const options = readOptions(optionsInput, ['onCollision', 'confirmed', 'operation']);
    const policy = options.onCollision ?? 'ask';
    // La forme de chaque chemin est contrôlée avant tout accès au disque.
    for (const input of [destinationInput, ...sources]) guard.checkPath(input);
    if (kind === 'move' && options.confirmed !== true) throw needsConfirmation("Le déplacement n'a pas été confirmé.");
    if (kind === 'move' && typeof moveNoReplace !== 'function') throw moveUnavailable();

    return exclusive(kind, options.operation, async (job) => {
      // 1. Tout est contrôlé avant que rien ne soit modifié.
      const folder = await locateFolder(destinationInput);
      const items = [];
      for (const input of sources) {
        const item = await locateItem(input);
        assertOperable(item, { read: kind === 'copy' });
        if (items.some((known) => guard.sameLocation(known.path, item.path))) continue; // désigné deux fois
        if (item.info.isDirectory() && guard.isInside(item.path, folder.path)) {
          throw refused('into-itself', kind === 'move' ? 'Un dossier ne peut pas être déplacé dans lui-même, ni dans l’un de ses sous-dossiers.' : 'Un dossier ne peut pas être copié dans lui-même, ni dans l’un de ses sous-dossiers.');
        }
        items.push(item);
      }
      for (const item of items) {
        if (items.some((other) => other !== item && guard.isInside(other.path, item.path))) {
          throw refused('invalid-selection', 'Cette sélection contient à la fois un dossier et un élément qu’il contient.');
        }
      }

      // 2. Nom de chaque élément à destination ; les noms déjà pris sont relevés.
      const taken = new Set();
      const plan = [];
      const collisions = [];
      for (const item of items) {
        const sameFolder = guard.sameLocation(item.parent, folder.path);
        if (kind === 'move' && sameFolder) {
          plan.push({ item, skip: 'same-location' });
          continue;
        }
        const occupied = taken.has(guard.comparable(item.name)) || (await exists(P.join(folder.path, item.name)));
        if (!occupied) {
          taken.add(guard.comparable(item.name));
          plan.push({ item, name: item.name });
        } else if ((kind === 'copy' && sameFolder) || policy === 'keep-both') {
          // Copie dans le dossier d'origine : une duplication, sous un nouveau nom.
          const name = await copyName(folder.path, item.name, item.info.isDirectory(), taken);
          taken.add(guard.comparable(name));
          plan.push({ item, name });
        } else if (policy === 'skip') {
          plan.push({ item, skip: 'collision' });
        } else {
          collisions.push({ source: item.path, name: item.name });
        }
      }
      // L'appelant doit choisir : rien n'a été modifié.
      if (collisions.length) return { status: 'collisions', operation: kind, destination: folder.path, collisions, count: items.length };

      // 3. Progression : nombre d'éléments à copier, s'il peut être compté.
      const work = plan.filter((step) => !step.skip);
      const crossesVolume = (item) => !guard.sameLocation(P.parse(item.path).root, P.parse(folder.path).root);
      let total = work.length;
      if (kind === 'copy' || work.some((step) => crossesVolume(step.item))) {
        // Annulée pendant le décompte, l'opération n'attend pas qu'il se termine.
        const budget = { count: 0, stopped: () => job.cancelled };
        for (const { item } of work) await countTree(item.path, item.info.isDirectory(), budget);
        total = budget.count > limits.count || job.cancelled ? null : budget.count;
      }
      const context = tracker(job, total);

      // 4. Exécution, élément par élément.
      const report = { status: 'done', operation: kind, destination: folder.path, done: [], skipped: [], failed: [], cancelled: false, links: 0, others: 0 };
      for (const step of plan) {
        const { item } = step;
        const entry = { source: item.path, name: item.name };
        if (step.skip) {
          report.skipped.push({ ...entry, reason: step.skip });
          continue;
        }
        if (job.cancelled) {
          report.cancelled = true;
          report.skipped.push({ ...entry, reason: 'cancelled' });
          continue;
        }
        try {
          if (kind === 'copy') {
            const target = await copyItem(item, folder.path, step.name, context);
            report.done.push({ ...entry, path: target, name: P.basename(target) });
          } else {
            const moved = await moveItem(item, folder.path, step.name, context);
            if (moved.original === 'kept') {
              report.failed.push({
                ...entry,
                code: 'original-kept',
                message: "L'élément a été copié à destination, mais l'original n'a pas pu être envoyé à la Corbeille : il est resté à sa place.",
                path: moved.path,
              });
            } else {
              report.done.push({ ...entry, path: moved.path, name: P.basename(moved.path), ...(moved.original ? { original: moved.original } : {}) });
            }
          }
        } catch (error) {
          const failure = translate(error);
          const partial = failure.partial ? { partial: failure.partial, ...(failure.complete ? { complete: true } : {}) } : {};
          if (failure instanceof Cancelled) {
            report.cancelled = true;
            report.skipped.push({ ...entry, reason: 'cancelled', ...partial });
            continue;
          }
          if (failure.code === 'failed') log(`Opération « ${kind} » en échec : ${error?.code ?? ''} ${error?.message ?? error}`);
          report.failed.push({ ...entry, code: failure.code, message: failure.message, ...(failure.at ? { at: failure.at } : {}), ...partial });
        }
      }
      report.links = context.links;
      report.others = context.others;
      return report;
    });
  }

  async function sendAllToTrash(targetsInput, optionsInput) {
    const targets = readList(targetsInput);
    const options = readOptions(optionsInput, ['confirmed', 'operation']);
    // La forme de chaque chemin est contrôlée avant tout accès au disque.
    for (const input of targets) guard.checkPath(input);
    if (options.confirmed !== true) throw needsConfirmation("L'envoi à la Corbeille n'a pas été confirmé.");
    if (typeof trash !== 'function') throw refused('trash-unavailable', "La Corbeille n'est pas disponible : rien n'a été supprimé.");

    return exclusive('trash', options.operation, async (job) => {
      // Tout est contrôlé avant que rien ne soit envoyé.
      const items = [];
      for (const input of targets) {
        const item = await locateItem(input);
        assertOperable(item);
        if (!items.some((known) => guard.sameLocation(known.path, item.path))) items.push(item);
      }
      for (const item of items) {
        if (items.some((other) => other !== item && guard.isInside(other.path, item.path))) {
          throw refused('invalid-selection', 'Cette sélection contient à la fois un dossier et un élément qu’il contient.');
        }
      }
      const context = tracker(job, items.length);
      const report = { status: 'done', operation: 'trash', done: [], skipped: [], failed: [], cancelled: false };
      for (const item of items) {
        const entry = { source: item.path, name: item.name };
        if (job.cancelled) {
          report.cancelled = true;
          report.skipped.push({ ...entry, reason: 'cancelled' });
          continue;
        }
        try {
          await sendToTrash(item.path);
          report.done.push(entry);
        } catch (error) {
          const failure = translate(error);
          report.failed.push({ ...entry, code: failure.code, message: failure.message });
        }
        context.step(item.name);
      }
      return report;
    });
  }

  /**
   * Extension d'un fichier, telle que Windows la lit pour choisir l'application :
   * ce qui suit le dernier point du nom — même placé en tête. Un fichier nommé
   * « .bat » est un script pour Windows, alors que `path.extname` ne lui
   * reconnaît aucune extension.
   */
  function extensionOf(location) {
    const name = P.basename(location);
    const dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  }

  async function openFile(targetInput, optionsInput) {
    if (typeof targetInput !== 'string') throw badArguments();
    const options = readOptions(optionsInput, ['confirmed']);
    const item = await locateItem(targetInput);
    if (item.info.isSymbolicLink()) throw linkNotSupported();
    if (item.info.isDirectory()) throw refused('not-a-file', "Un dossier s'ouvre dans l'explorateur d'Evolve, pas dans une autre application.");
    if (!item.info.isFile()) throw refused('not-a-file', "Cet élément n'est pas un fichier : il ne peut pas être ouvert.");
    const extension = extensionOf(item.path);
    // Sûr par défaut : sans confirmation, seuls les types connus pour n'être qu'un contenu sont ouverts.
    if (options.confirmed !== true && !OPENS_AS_CONTENT.has(extension)) {
      throw needsConfirmation(
        RUNS_CODE.has(extension)
          ? 'Ce fichier est un programme, un script ou un raccourci : l’ouvrir exécute du code sur cet ordinateur, avec vos droits.'
          : "Evolve ne connaît pas ce type de fichier : selon l'application que Windows lui associe, l'ouvrir peut exécuter du code sur cet ordinateur, avec vos droits.",
      );
    }
    if (typeof openPath !== 'function') throw refused('open-unavailable', "L'ouverture des fichiers n'est pas disponible.");
    let problem;
    try {
      problem = await openPath(item.path);
    } catch (error) {
      problem = String(error?.message ?? error);
    }
    if (problem) {
      log(`Ouverture impossible : ${problem}`);
      throw refused('open-failed', "Windows n'a pas pu ouvrir ce fichier : aucune application ne lui est peut-être associée.");
    }
    return { opened: true, path: item.path, name: item.name };
  }

  return {
    /** Crée un dossier nommé `name` dans le dossier `parent`. */
    createFolder,
    /** Donne le nom `name` à l'élément `target`, sans le changer de dossier. */
    rename,
    /** Copie des éléments dans le dossier `destination`. Options : `onCollision`, `operation`. */
    copy: (sources, destination, options) => transfer('copy', sources, destination, options),
    /** Déplace des éléments dans le dossier `destination`. Options : `confirmed` (obligatoire), `onCollision`, `operation`. */
    move: (sources, destination, options) => transfer('move', sources, destination, options),
    /** Envoie des éléments à la Corbeille. Options : `confirmed` (obligatoire), `operation`. */
    trash: sendAllToTrash,
    /** Ouvre un fichier avec l'application que Windows lui associe. Option : `confirmed` (obligatoire, sauf pour les types de `OPENS_AS_CONTENT`). */
    open: openFile,
    /** Demande l'arrêt de l'opération en cours ; elle s'interrompt après l'élément qu'elle traite. */
    cancel(operation) {
      if (!active || (operation !== undefined && operation !== null && operation !== active.id)) return false;
      active.cancelled = true;
      return true;
    },
    /** Abonne `listener({ operation, kind, state, done, total, current })` à la progression ; renvoie une fonction de désabonnement. */
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** État, pour les comptes rendus. */
    status: () => ({
      busy: Boolean(active),
      trash: typeof trash === 'function',
      open: typeof openPath === 'function',
      /** Vrai si l'hôte fournit le déplacement sans remplacement : sans lui, renommer et déplacer sont refusés. */
      noReplaceMove: typeof moveNoReplace === 'function',
      deletion: 'recycle-bin-only',
      replace: 'never',
    }),
  };
}

module.exports = { createFileOperations, WRITE_CALLS, READ_CALLS, DEFAULT_LIMITS, COLLISION_POLICIES, RUNS_CODE, OPENS_AS_CONTENT, SYSTEM_AT_DRIVE_ROOT };

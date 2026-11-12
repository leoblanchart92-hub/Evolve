'use strict';

/**
 * Faux système de fichiers, en mémoire, pour les tests du service « files »
 * et des opérations sur les fichiers.
 *
 * Il imite la partie de `node:fs` que ces services utilisent — opendir, lstat,
 * realpath.native, statfs, et, pour les opérations, mkdir, rename, copyFile —
 * avec des chemins Windows (lettres de lecteur, noms insensibles à la casse,
 * lecteurs réseau) ou POSIX. Il permet ce qu'un vrai disque ne permet pas
 * dans un test : un lecteur qui ne répond jamais, une erreur précise sur un
 * élément donné, un dossier de Windows protégé… et il note chaque appel reçu,
 * pour vérifier ce que le service a lu, et ce qu'il a modifié.
 *
 * Comme le vrai système, `rename` et `copyFile` (sans COPYFILE_EXCL)
 * REMPLACENT un fichier existant : un service qui écraserait un fichier par
 * mégarde le ferait aussi ici, et le test le verrait.
 *
 *   const disk = createFakeFs({
 *     platform: 'win32',
 *     drives: {
 *       'C:\\': { totalBytes: 512e9, freeBytes: 128e9, tree: {
 *         Users: { Léo: { Documents: { 'Notes.txt': file(7) } } },
 *         'System Volume Information': dir({}, { deny: 'EPERM' }),
 *         'Documents and Settings': link('C:\\Users'),
 *       } },
 *       'Z:\\': { target: '\\\\nas\\partage\\' },   // lecteur réseau
 *     },
 *   });
 */

const nodePath = require('node:path');

const KIND = Symbol('nature');
const DEFAULT_TIME = Date.UTC(2026, 0, 15, 9, 30);

/** Fichier de `size` octets, modifié à `modified` (date ou millisecondes). */
const file = (size = 0, modified = DEFAULT_TIME) => ({ [KIND]: 'file', size, mtimeMs: Number(modified) });

/**
 * Dossier. Un simple objet suffit ; `dir` sert à préciser une date ou un
 * refus : `deny` est le code d'erreur renvoyé à l'ouverture du dossier.
 */
const dir = (children = {}, { modified = DEFAULT_TIME, deny = null } = {}) => ({ [KIND]: 'dir', children, mtimeMs: Number(modified), deny });

/** Lien symbolique ou jonction vers `target` (chemin complet). */
const link = (target, modified = DEFAULT_TIME) => ({ [KIND]: 'link', target, mtimeMs: Number(modified) });

/** Élément qui n'est ni un fichier, ni un dossier, ni un lien (périphérique, canal…). */
const other = () => ({ [KIND]: 'other', mtimeMs: DEFAULT_TIME });

const kindOf = (node) => node[KIND] ?? 'dir';
const childrenOf = (node) => (node[KIND] === 'dir' ? node.children : node);

function failure(code, syscall, target) {
  return Object.assign(new Error(`${code}: erreur simulée, ${syscall} '${target}'`), { code, syscall, path: target });
}

/**
 * @param {object} options
 * @param {'win32'|'posix'|string} [options.platform]
 * @param {Record<string, { tree?: object, totalBytes?: number, freeBytes?: number, target?: string, statfs?: string }>} options.drives
 *        lecteurs, par racine (« C:\\ », « / »). `target` : la racine mène ailleurs
 *        (lecteur réseau ou virtuel). `statfs` : code d'erreur de la lecture de la capacité.
 * @param {Record<string, Record<string, string>>} [options.errors]  erreurs imposées :
 *        { lstat: { 'C:\\pagefile.sys': 'EBUSY' }, realpath: {…}, opendir: {…} }
 * @param {string[]} [options.hang]  chemins pour lesquels `realpath` ne répond pas (voir `release`)
 * @param {'as-folders'|'as-links'} [options.listedLinks]  type annoncé par la lecture d'un dossier
 *        (`opendir`) pour un lien qui mène à un dossier. Sous Windows, il dépend de la version de
 *        Node : jusqu'à libuv 1.49.0, une jonction ou un lien vers un dossier y passe pour un dossier
 *        ordinaire ; depuis, pour un lien. Par défaut, le faux disque Windows imite le premier cas,
 *        le plus trompeur : seul `lstat` dit de façon sûre ce qu'est un élément.
 */
function createFakeFs({ platform = 'win32', drives = {}, errors = {}, hang = [], listedLinks = platform === 'win32' ? 'as-folders' : 'as-links' } = {}) {
  const isWindows = platform === 'win32';
  const P = isWindows ? nodePath.win32 : nodePath.posix;
  const fold = (text) => (isWindows ? text.toLowerCase() : text);

  /** Appels reçus : [fonction, chemin] — et la destination pour rename et copyFile. */
  const calls = [];
  /** Fichiers remplacés par un renommage ou une copie : doit rester vide. */
  const overwritten = [];
  /** Corbeille simulée (voir `recycle`). */
  const bin = [];
  /** Demandes laissées sans réponse : chemin → fonctions de rappel en attente. */
  const waiting = new Map();
  const hanging = new Set(hang.map(fold));
  const state = { openHandles: 0, opened: 0, yielded: 0 };

  const imposed = (name, target) => {
    const table = errors[name] ?? {};
    const key = Object.keys(table).find((candidate) => fold(candidate) === fold(target));
    return key ? table[key] : null;
  };

  const driveAt = (root) => {
    const key = Object.keys(drives).find((candidate) => fold(candidate) === fold(root));
    return key ? { root: key, ...drives[key] } : null;
  };

  /**
   * Parcourt `target`. Renvoie l'élément et son chemin réel (liens résolus,
   * noms tels qu'ils sont écrits sur le disque).
   * @param {boolean} follow  suivre aussi le dernier élément s'il est un lien
   */
  function resolve(target, follow, syscall, depth = 0) {
    if (depth > 40) throw failure('ELOOP', syscall, target);
    const { root } = P.parse(target);
    const drive = driveAt(root);
    if (!drive) throw failure('ENOENT', syscall, target);
    const parts = target.slice(root.length).split(isWindows ? /[\\/]/ : '/').filter(Boolean);
    let node = drive.tree ?? {};
    // Lecteur réseau ou virtuel : le chemin réel de son contenu est ailleurs.
    let real = drive.target ?? drive.root;
    for (let index = 0; index < parts.length; index += 1) {
      if (kindOf(node) !== 'dir') throw failure('ENOTDIR', syscall, target);
      const children = childrenOf(node);
      const name = Object.keys(children).find((candidate) => fold(candidate) === fold(parts[index]));
      if (name === undefined) throw failure('ENOENT', syscall, target);
      node = children[name];
      real = P.join(real, name);
      const last = index === parts.length - 1;
      if (kindOf(node) === 'link' && (follow || !last)) {
        const rest = parts.slice(index + 1);
        return resolve(P.join(node.target, ...rest), follow, syscall, depth + 1);
      }
    }
    return { node, real };
  }

  /** Vrai si le lien mène à un fichier ; une jonction, même rompue, est un dossier pour Windows. */
  function leadsToFile(node) {
    try {
      return kindOf(resolve(node.target, true, 'opendir').node) === 'file';
    } catch {
      return false;
    }
  }

  /** Répond à l'appel après un tour de boucle, comme le ferait le système. */
  const answer = (callback, task) => {
    setImmediate(() => {
      let value;
      try {
        value = task();
      } catch (error) {
        callback(error);
        return;
      }
      callback(null, value);
    });
  };

  /** Identité de chaque élément (numéro de fichier), comme sur un vrai disque. */
  const identities = new WeakMap();
  let lastIdentity = 100;
  const identityOf = (node) => {
    if (!identities.has(node)) identities.set(node, (lastIdentity += 1));
    return identities.get(node);
  };

  const statsOf = (node, { bigint = false } = {}) => {
    const kind = kindOf(node);
    const ino = identityOf(node);
    return {
      isDirectory: () => kind === 'dir',
      isFile: () => kind === 'file',
      isSymbolicLink: () => kind === 'link',
      size: kind === 'file' ? node.size : 0,
      mtimeMs: node.mtimeMs ?? DEFAULT_TIME,
      ino: bigint ? BigInt(ino) : ino,
      dev: bigint ? 1n : 1,
    };
  };

  /** Dossier parent d'un chemin à créer : il doit exister et être un dossier. Renvoie ses enfants et le nom demandé. */
  function slot(target, syscall) {
    const parentPath = P.dirname(target);
    const { node, real } = resolve(parentPath, true, syscall);
    if (kindOf(node) !== 'dir') throw failure('ENOTDIR', syscall, target);
    if (node[KIND] === 'dir' && node.deny) throw failure(node.deny, syscall, target);
    const children = childrenOf(node);
    const wanted = P.basename(target);
    const existing = Object.keys(children).find((candidate) => fold(candidate) === fold(wanted));
    return { children, wanted, existing, real: P.join(real, existing ?? wanted), parent: node };
  }

  /** Vrai si `inner` est `outer` ou l'un de ses descendants. */
  function contains(outer, inner) {
    if (outer === inner) return true;
    if (kindOf(outer) !== 'dir') return false;
    return Object.values(childrenOf(outer)).some((child) => contains(child, inner));
  }

  function realpathNative(target, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    calls.push(['realpath', target]);
    const task = () => {
      const code = imposed('realpath', target);
      if (code) throw failure(code, 'realpath', target);
      return resolve(target, true, 'realpath').real;
    };
    if (hanging.has(fold(target))) {
      // Aucune réponse tant que `release` n'est pas appelée (serveur injoignable).
      const queue = waiting.get(fold(target)) ?? [];
      queue.push(() => answer(done, task));
      waiting.set(fold(target), queue);
      return;
    }
    answer(done, task);
  }

  const fake = {
    realpath: Object.assign(
      () => {
        throw new Error('realpath (sans .native) ne doit pas être utilisée');
      },
      { native: realpathNative },
    ),

    lstat(target, options, callback) {
      const done = typeof options === 'function' ? options : callback;
      calls.push(['lstat', target]);
      answer(done, () => {
        const code = imposed('lstat', target);
        if (code) throw failure(code, 'lstat', target);
        return statsOf(resolve(target, false, 'lstat').node, typeof options === 'object' && options ? options : {});
      });
    },

    // --- Fonctions qui modifient le disque (opérations sur les fichiers) ---------

    constants: { COPYFILE_EXCL: 1 },

    mkdir(target, options, callback) {
      const done = typeof options === 'function' ? options : callback;
      calls.push(['mkdir', target]);
      answer(done, () => {
        const code = imposed('mkdir', target);
        if (code) throw failure(code, 'mkdir', target);
        if (typeof options === 'object' && options?.recursive) throw new Error('mkdir récursif : ne doit pas être utilisé');
        const place = slot(target, 'mkdir');
        if (place.existing !== undefined) throw failure('EEXIST', 'mkdir', target);
        place.children[place.wanted] = dir({}, { modified: Date.now() });
      });
    },

    rename(from, to, callback) {
      calls.push(['rename', from, to]);
      answer(callback, () => {
        const code = imposed('rename', from) ?? imposed('rename', to);
        if (code) throw failure(code, 'rename', from);
        const source = slot(from, 'rename');
        if (source.existing === undefined) throw failure('ENOENT', 'rename', from);
        const node = source.children[source.existing];
        const destination = slot(to, 'rename');
        // D'un lecteur à l'autre : le système refuse (EXDEV), comme pour un vrai disque.
        if (fold(P.parse(source.real).root) !== fold(P.parse(destination.real).root)) throw failure('EXDEV', 'rename', from);
        if (kindOf(node) === 'dir' && contains(node, destination.parent)) throw failure('EINVAL', 'rename', from);
        if (destination.existing !== undefined) {
          const occupant = destination.children[destination.existing];
          if (occupant !== node) {
            // Comme le vrai système : un fichier remplace un fichier ; un dossier existant résiste.
            if (kindOf(occupant) === 'dir' || kindOf(node) === 'dir') throw failure('EPERM', 'rename', to);
            overwritten.push(destination.real);
          }
          delete destination.children[destination.existing];
        }
        delete source.children[source.existing];
        destination.children[destination.wanted] = node;
      });
    },

    copyFile(from, to, mode, callback) {
      const done = typeof mode === 'function' ? mode : callback;
      const flags = typeof mode === 'number' ? mode : 0;
      calls.push(['copyFile', from, to, flags]);
      answer(done, () => {
        const code = imposed('copyFile', from) ?? imposed('copyFile', to);
        if (code) throw failure(code, 'copyFile', from);
        const { node } = resolve(from, true, 'copyFile');
        if (kindOf(node) !== 'file') throw failure(kindOf(node) === 'dir' ? 'EISDIR' : 'EINVAL', 'copyFile', from);
        const destination = slot(to, 'copyFile');
        if (destination.existing !== undefined) {
          if (flags & 1) throw failure('EEXIST', 'copyFile', to);
          if (kindOf(destination.children[destination.existing]) === 'dir') throw failure('EISDIR', 'copyFile', to);
          overwritten.push(destination.real);
          delete destination.children[destination.existing];
        }
        destination.children[destination.wanted] = file(node.size, node.mtimeMs);
      });
    },

    statfs(target, options, callback) {
      const done = typeof options === 'function' ? options : callback;
      calls.push(['statfs', target]);
      answer(done, () => {
        const drive = driveAt(P.parse(target).root);
        if (!drive) throw failure('ENOENT', 'statfs', target);
        if (drive.statfs) throw failure(drive.statfs, 'statfs', target);
        const bsize = 4096;
        return { bsize, blocks: Math.floor((drive.totalBytes ?? 0) / bsize), bfree: Math.floor((drive.freeBytes ?? 0) / bsize), bavail: Math.floor((drive.freeBytes ?? 0) / bsize) };
      });
    },

    opendir(target, options, callback) {
      const done = typeof options === 'function' ? options : callback;
      calls.push(['opendir', target]);
      answer(done, () => {
        const code = imposed('opendir', target);
        if (code) throw failure(code, 'opendir', target);
        const { node } = resolve(target, true, 'opendir');
        if (kindOf(node) !== 'dir') throw failure('ENOTDIR', 'opendir', target);
        if (node[KIND] === 'dir' && node.deny) throw failure(node.deny, 'opendir', target);
        const entries = Object.entries(childrenOf(node));
        state.openHandles += 1;
        state.opened += 1;
        let closed = false;
        const close = () => {
          if (!closed) {
            closed = true;
            state.openHandles -= 1;
          }
        };
        return {
          close: async () => close(),
          async *[Symbol.asyncIterator]() {
            try {
              for (const [name, child] of entries) {
                state.yielded += 1;
                if (listedLinks === 'as-folders' && kindOf(child) === 'link' && !leadsToFile(child)) {
                  // Jonction ou lien vers un dossier : annoncé comme un dossier ordinaire.
                  yield { name, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
                  continue;
                }
                const stats = statsOf(child);
                yield { name, isDirectory: stats.isDirectory, isFile: stats.isFile, isSymbolicLink: stats.isSymbolicLink };
              }
            } finally {
              close(); // fin de la lecture, ou abandon en cours de route
            }
          },
        };
      });
    },
  };

  /** Fonctions du faux module que le service a touchées (même sans les appeler). */
  const touched = new Set();
  const module = new Proxy(fake, {
    get(target, property) {
      if (typeof property === 'string') touched.add(property);
      return target[property];
    },
  });

  return {
    /** Module à remettre au service (option `fs`). */
    fs: module,
    calls,
    touched,
    state,
    /** Chemins reçus par une fonction donnée. */
    pathsOf: (name) => calls.filter(([called]) => called === name).map(([, target]) => target),
    /** Nombre de demandes `realpath` restées sans réponse. */
    pending: () => [...waiting.values()].reduce((sum, queue) => sum + queue.length, 0),
    /** Fait répondre le système aux demandes en attente pour `target` ; le chemin répond ensuite sans délai. */
    release(target) {
      hanging.delete(fold(target));
      const queue = waiting.get(fold(target)) ?? [];
      waiting.delete(fold(target));
      for (const reply of queue) reply();
    },
    /** Rend un chemin muet (le serveur ne répond plus). */
    silence(target) {
      hanging.add(fold(target));
    },
    /** Modifie l'arborescence en cours de test : `mutate((drives) => { … })`. */
    mutate(change) {
      change(drives);
    },
    /** Fichiers remplacés par une opération (chemins réels) : aucun service ne doit en produire. */
    overwritten,
    /** Corbeille simulée : éléments retirés par `recycle`, avec leur chemin d'origine. */
    bin,
    /**
     * Simulation de la Corbeille, à remettre au service comme fonction `trash`.
     * L'élément quitte son dossier et rejoint `bin` — rien n'est détruit. Elle
     * ne fait pas partie du faux module de fichiers : le service ne peut
     * l'atteindre que si le test la lui confie.
     */
    recycle: async (target) => {
      calls.push(['recycle', target]);
      const place = slot(target, 'recycle');
      if (place.existing === undefined) throw failure('ENOENT', 'recycle', target);
      bin.push({ path: place.real, node: place.children[place.existing] });
      delete place.children[place.existing];
    },
    /** Appels qui modifient le disque : [fonction, chemin, destination]. */
    writes: () => calls.filter(([name]) => name === 'mkdir' || name === 'rename' || name === 'copyFile'),
    /** Contenu complet d'un lecteur (ou de tous) : une ligne par élément, pour comparer avant et après. */
    snapshot(root = null) {
      const lines = [];
      const walk = (node, location) => {
        for (const [name, child] of Object.entries(childrenOf(node)).sort(([a], [b]) => (a < b ? -1 : 1))) {
          const full = P.join(location, name);
          const kind = kindOf(child);
          lines.push(kind === 'file' ? `${full} [${child.size}]` : kind === 'link' ? `${full} -> ${child.target}` : kind === 'dir' ? `${full}${P.sep}` : `${full} (autre)`);
          if (kind === 'dir') walk(child, full);
        }
      };
      for (const [driveRoot, drive] of Object.entries(drives)) {
        if (root === null || fold(root) === fold(driveRoot)) walk(drive.tree ?? {}, driveRoot);
      }
      return lines;
    },
  };
}

module.exports = { createFakeFs, file, dir, link, other };

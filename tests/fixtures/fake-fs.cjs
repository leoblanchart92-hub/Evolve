'use strict';

/**
 * Faux système de fichiers, en mémoire, pour les tests du service « files ».
 *
 * Il imite la partie de `node:fs` que le service utilise — opendir, lstat,
 * realpath.native, statfs — avec des chemins Windows (lettres de lecteur,
 * noms insensibles à la casse, lecteurs réseau) ou POSIX. Il permet ce
 * qu'un vrai disque ne permet pas dans un test : un lecteur qui ne répond
 * jamais, une erreur précise sur un élément donné, un dossier de Windows
 * protégé… et il note chaque appel reçu, pour vérifier que le service ne
 * fait que lire.
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
 */
function createFakeFs({ platform = 'win32', drives = {}, errors = {}, hang = [] } = {}) {
  const isWindows = platform === 'win32';
  const P = isWindows ? nodePath.win32 : nodePath.posix;
  const fold = (text) => (isWindows ? text.toLowerCase() : text);

  /** Appels reçus : [fonction, chemin]. */
  const calls = [];
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

  const statsOf = (node) => {
    const kind = kindOf(node);
    return {
      isDirectory: () => kind === 'dir',
      isFile: () => kind === 'file',
      isSymbolicLink: () => kind === 'link',
      size: kind === 'file' ? node.size : 0,
      mtimeMs: node.mtimeMs ?? DEFAULT_TIME,
    };
  };

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
        return statsOf(resolve(target, false, 'lstat').node);
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
  };
}

module.exports = { createFakeFs, file, dir, link, other };

'use strict';

/**
 * Evolve — Déplacement sans remplacement.
 *
 * Renommer ou déplacer un élément en garantissant qu'aucun autre n'est
 * remplacé — même si un autre programme crée, au même instant, un élément du
 * nom d'arrivée. Node.js n'offre pas cette opération : `fs.rename` remplace
 * le fichier qui porte déjà ce nom, et vérifier d'abord que le nom est libre
 * laisse un instant pendant lequel un autre programme peut le prendre.
 *
 * L'opération est donc demandée directement au système, par un petit module
 * natif (native/evolve_fs.c). Sous Windows, c'est MoveFileExW sans l'option
 * de remplacement : la vérification « ce nom est libre » et le déplacement
 * ne font qu'une seule opération du système de fichiers, que rien ne peut
 * séparer.
 *
 * Ce fichier charge ce module et lui donne la forme attendue par les
 * opérations sur les fichiers (src/services/file-operations.js) : une
 * fonction `move(from, to)` qui échoue avec le code « EEXIST », sans rien
 * modifier, si quoi que ce soit porte déjà le nom `to`.
 *
 * Si le module est introuvable ou inutilisable, il n'existe AUCUN repli vers
 * `fs.rename` : l'application refuse alors de renommer et de déplacer.
 */

const nodePath = require('node:path');
const { getSystemErrorName } = require('node:util');

/** Module natif compilé par « npm run build:native » (voir native/binding.gyp). */
const ADDON_FILE = nodePath.join(__dirname, '..', '..', 'native', 'build', 'Release', 'evolve_fs.node');

/**
 * Codes d'erreur de Windows (GetLastError) et code équivalent de Node.js —
 * les mêmes correspondances que celles de Node pour ses propres fonctions.
 * Un code absent de cette liste est signalé comme « UNKNOWN ».
 */
const WINDOWS_ERRORS = Object.freeze({
  2: 'ENOENT', // ERROR_FILE_NOT_FOUND
  3: 'ENOENT', // ERROR_PATH_NOT_FOUND
  5: 'EPERM', // ERROR_ACCESS_DENIED
  15: 'ENOENT', // ERROR_INVALID_DRIVE
  17: 'EXDEV', // ERROR_NOT_SAME_DEVICE : d'un lecteur à un autre
  19: 'EROFS', // ERROR_WRITE_PROTECT
  32: 'EBUSY', // ERROR_SHARING_VIOLATION : élément ouvert dans un autre programme
  33: 'EBUSY', // ERROR_LOCK_VIOLATION
  39: 'ENOSPC', // ERROR_HANDLE_DISK_FULL
  50: 'ENOTSUP', // ERROR_NOT_SUPPORTED
  80: 'EEXIST', // ERROR_FILE_EXISTS
  87: 'EINVAL', // ERROR_INVALID_PARAMETER
  112: 'ENOSPC', // ERROR_DISK_FULL
  123: 'ENOENT', // ERROR_INVALID_NAME
  145: 'ENOTEMPTY', // ERROR_DIR_NOT_EMPTY
  161: 'ENOENT', // ERROR_BAD_PATHNAME
  183: 'EEXIST', // ERROR_ALREADY_EXISTS : le nom d'arrivée est déjà pris
  206: 'ENAMETOOLONG', // ERROR_FILENAME_EXCED_RANGE
  267: 'ENOENT', // ERROR_DIRECTORY
  1314: 'EPERM', // ERROR_PRIVILEGE_NOT_HELD
  1921: 'ELOOP', // ERROR_CANT_RESOLVE_FILENAME
});

/** Chemin complet désignant un lecteur par sa lettre : « C:\… ». */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\\/;

/** Code de Node.js correspondant à un code d'erreur du système. */
function errorName(number, platform) {
  if (platform === 'win32') return WINDOWS_ERRORS[number] ?? 'UNKNOWN';
  try {
    const name = getSystemErrorName(-number);
    return /^E[A-Z0-9]+$/.test(name) ? name : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

/** Erreur de la même forme que celles du module de fichiers de Node. */
function failure(code, number, from, to) {
  const error = new Error(`${code}: déplacement sans remplacement impossible, '${from}' -> '${to}'`);
  return Object.assign(error, { code, errno: number, syscall: 'rename', path: from, dest: to });
}

/**
 * Donne au module natif la forme attendue par les opérations sur les fichiers.
 *
 * @param {{ moveNoReplace(from: string, to: string): Promise<number> }} binding  module natif
 * @param {object} [options]
 * @param {string} [options.platform]  système sur lequel l'application s'exécute
 * @returns {(from: string, to: string) => Promise<void>} déplace l'élément `from` sous le nom `to`.
 *          La promesse est rejetée, sans que rien ait été modifié, si le système refuse — avec le
 *          code « EEXIST » si quoi que ce soit porte déjà le nom `to`.
 */
function createAtomicMove(binding, { platform = process.platform } = {}) {
  if (typeof binding?.moveNoReplace !== 'function') {
    throw new TypeError('Déplacement sans remplacement : module natif inutilisable (fonction « moveNoReplace » absente).');
  }
  const isWindows = platform === 'win32';
  const P = isWindows ? nodePath.win32 : nodePath.posix;
  const complete = (location) => (isWindows ? WINDOWS_DRIVE_PATH.test(location) : P.isAbsolute(location));
  // Sous Windows, la forme « \\?\C:\… », celle que Node emploie lui-même : chemins longs admis, aucun nom réinterprété.
  const native = (location) => (isWindows ? P.toNamespacedPath(location) : location);

  return async function moveNoReplace(from, to) {
    // Seuls des chemins complets sont admis : rien ne dépend du dossier courant du programme.
    for (const location of [from, to]) {
      if (typeof location !== 'string' || location.includes('\0') || !complete(location)) throw failure('EINVAL', 0, String(from), String(to));
    }
    const number = await binding.moveNoReplace(native(from), native(to));
    if (number === 0) return;
    throw failure(typeof number === 'number' ? errorName(number, platform) : 'UNKNOWN', number, from, to);
  };
}

/**
 * Charge le module natif.
 *
 * @param {object} [options]
 * @param {string} [options.file]      fichier du module natif
 * @param {string} [options.platform]  système sur lequel l'application s'exécute
 * @param {(file: string) => object} [options.load]  chargement du fichier (par défaut, celui de Node)
 * @returns {(from: string, to: string) => Promise<void>} voir `createAtomicMove`
 * @throws {Error} si le module est introuvable ou inutilisable : il n'existe aucune autre façon de déplacer
 */
function loadAtomicMove({ file = ADDON_FILE, platform = process.platform, load = require } = {}) {
  let binding;
  try {
    binding = load(file);
  } catch (error) {
    throw new Error(`Déplacement sans remplacement : module natif introuvable ou inutilisable (${file}) — ${error?.message ?? error}`);
  }
  return createAtomicMove(binding, { platform });
}

module.exports = { loadAtomicMove, createAtomicMove, ADDON_FILE, WINDOWS_ERRORS };

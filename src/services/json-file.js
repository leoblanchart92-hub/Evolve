'use strict';

/**
 * Evolve — Lecture et écriture sûres d'un fichier JSON.
 *
 * Écriture « tout ou rien » : le contenu est écrit dans un fichier provisoire,
 * confié au disque, puis mis à la place du fichier définitif en une seule
 * opération. Une coupure de courant ou un arrêt brutal laisse donc soit
 * l'ancien fichier, soit le nouveau, toujours complet — jamais un fichier
 * tronqué.
 *
 * Tout est synchrone, à dessein : les fichiers concernés font quelques
 * centaines d'octets et deux écritures ne peuvent ainsi jamais se chevaucher,
 * même au moment de la fermeture de l'application.
 */

const nodeFs = require('node:fs');
const path = require('node:path');

/**
 * Erreurs souvent passagères sous Windows : le fichier est retenu un instant
 * par un antivirus ou par l'indexation. L'opération est alors retentée.
 */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Pauses entre deux essais, en millisecondes (un tiers de seconde au total). */
const RETRY_DELAYS = Object.freeze([10, 25, 50, 100, 150]);

/** Le disque ne sait pas confirmer l'écriture (certains lecteurs réseau) : sans gravité. */
const SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS']);

/**
 * Le fichier n'existe pas : lui-même (ENOENT), ou son dossier, dont un fichier
 * occupe la place (ENOTDIR sous Linux et macOS, ENOENT sous Windows).
 */
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

/** Pause synchrone de `ms` millisecondes. */
function pause(ms) {
  const until = Date.now() + ms;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* attente passive indisponible dans ce contexte : attente active ci-dessous */
  }
  while (Date.now() < until);
}

/** Exécute `operation`, en la retentant après une erreur passagère. */
function retrying(operation, { delays = RETRY_DELAYS, sleep = pause } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!TRANSIENT.has(error?.code) || attempt >= delays.length) throw error;
      sleep(delays[attempt]);
    }
  }
}

/**
 * Lit un fichier JSON sans jamais lever d'exception.
 * @returns {{ status: 'ok', data: any } | { status: 'missing' }
 *   | { status: 'corrupt', error: Error } | { status: 'unreadable', error: Error }}
 *   « corrupt » : le fichier a été lu mais son contenu n'est pas du JSON ;
 *   « unreadable » : le fichier existe mais n'a pas pu être lu.
 */
function readJson(file, { fs = nodeFs, delays, sleep } = {}) {
  let text;
  try {
    text = retrying(() => fs.readFileSync(file, 'utf8'), { delays, sleep });
  } catch (error) {
    return ABSENT.has(error?.code) ? { status: 'missing' } : { status: 'unreadable', error };
  }
  try {
    // Certains éditeurs de texte ajoutent une marque invisible en tête de fichier.
    return { status: 'ok', data: JSON.parse(text.replace(/^\uFEFF/, '')) };
  } catch (error) {
    return { status: 'corrupt', error };
  }
}

/**
 * Écrit `data` dans `file` en une opération « tout ou rien ». Le dossier est
 * créé au besoin. Lève une exception si l'écriture est impossible : le fichier
 * précédent est alors intact.
 */
function writeJsonAtomic(file, data, { fs = nodeFs, delays, sleep } = {}) {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const dir = path.dirname(file);
  const draft = `${file}.tmp`;
  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(draft, 'w');
    fs.writeFileSync(fd, text, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch (error) {
      if (!SYNC_UNSUPPORTED.has(error?.code)) throw error;
    }
    fs.closeSync(fd);
    fd = null;
    retrying(() => fs.renameSync(draft, file), { delays, sleep });
  } catch (error) {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
      /* déjà fermé */
    }
    try {
      fs.rmSync(draft, { force: true });
    } catch {
      /* le fichier provisoire sera remplacé à la prochaine écriture */
    }
    throw error;
  }
  // Linux : le changement de nom lui-même est confié au disque. Sans objet
  // sous Windows, où un dossier ne s'ouvre pas ainsi.
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    /* facultatif */
  }
}

/**
 * Met un fichier de côté sous un autre nom (remplace une copie précédente).
 * @returns {boolean} vrai si le fichier a été déplacé
 */
function setAside(file, target, { fs = nodeFs, delays, sleep } = {}) {
  try {
    retrying(() => fs.renameSync(file, target), { delays, sleep });
    return true;
  } catch {
    return false;
  }
}

module.exports = { readJson, writeJsonAtomic, setAside, RETRY_DELAYS };

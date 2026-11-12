'use strict';

/**
 * Evolve — Emplacement des dossiers personnels de l'utilisateur (Bureau,
 * Documents, Téléchargements, Images, Musique, Vidéos), obtenu sans jamais
 * rien créer sur le disque.
 *
 * Ces emplacements sont demandés au moteur (Electron), qui interroge le
 * système : un dossier déplacé — vers OneDrive, par exemple — est ainsi trouvé
 * là où il se trouve réellement. Cette demande ne doit avoir aucun effet :
 * Evolve ne crée rien de lui-même, un dossier absent doit rester absent.
 *
 * Or le moteur traite « Documents » à part (Chromium, chrome_paths.cc) : une
 * fois le chemin obtenu, il crée le dossier s'il n'existe pas. Tout dépend
 * donc de la façon dont il obtient ce chemin :
 *
 *   - sous Windows, il le demande au système (SHGetFolderPath, sans option de
 *     création), qui vérifie lui-même que le dossier existe. S'il est absent,
 *     Windows répond par une erreur : le moteur n'obtient aucun chemin, ne
 *     crée rien, et la demande échoue — le dossier est signalé introuvable ;
 *   - sur les autres systèmes, le chemin est fourni sans vérification : le
 *     moteur créerait le dossier absent. La question ne lui est donc jamais
 *     posée ; Evolve désigne lui-même le dossier « Documents » du compte.
 *
 * Les cinq autres dossiers sont seulement lus par le moteur, jamais créés.
 *
 * Le moteur retient les emplacements qu'il a obtenus, pas ses échecs : un
 * dossier resté introuvable peut donc lui être redemandé plus tard (il est
 * retrouvé s'il est revenu), et un emplacement déjà obtenu n'a pas à l'être.
 *
 * Sources : Chromium 156 (moteur d'Electron 45), chrome/common/chrome_paths.cc
 * (« create_dir » pour DIR_USER_DOCUMENTS), chrome_paths_win.cc
 * (GetUserDirectory) et base/path_service.cc (mémoire des emplacements).
 *
 * Preuves : tests/personal-folders.test.mjs (les deux comportements du
 * moteur) et, à chaque compilation, scripts/check-documents.mjs — un vrai
 * Windows dont le dossier Documents a été retiré, puis ouvert dans Evolve.
 */

const path = require('node:path');

/** Dossiers personnels présentés par l'explorateur, dans l'ordre du service de fichiers. */
const PERSONAL_FOLDERS = Object.freeze(['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos']);

/**
 * Dossiers que le moteur crée lorsqu'ils sont absents, avec le nom qu'ils
 * portent par défaut dans le dossier du compte.
 */
const CREATED_WHEN_MISSING = Object.freeze({ documents: 'Documents' });

/**
 * Vrai si l'emplacement du dossier `id` peut être demandé au moteur sans
 * aucun risque de création (voir l'en-tête).
 */
function engineOnlyReads(id, platform) {
  return platform === 'win32' || !Object.hasOwn(CREATED_WHEN_MISSING, id);
}

/**
 * @param {object} options
 * @param {(name: string) => string} options.getPath  demande d'un emplacement au moteur
 *        (Electron : `app.getPath`) ; lève une exception si le système ne le connaît pas
 * @param {string} [options.platform]  système sur lequel l'application s'exécute
 * @param {Record<string, string|null>} [options.known]  emplacements déjà obtenus : le moteur
 *        n'est interrogé que sur les autres (un dossier resté introuvable peut être revenu)
 * @returns {Record<string, string|null>} chemin de chaque dossier personnel ; `null` s'il est introuvable
 */
function personalFolders({ getPath, platform = process.platform, known = null }) {
  const ask = (name) => {
    try {
      const value = getPath(name);
      return typeof value === 'string' && value !== '' ? value : null;
    } catch {
      return null; // dossier absent ou inconnu du système : signalé comme introuvable, sans rien créer
    }
  };

  const folders = {};
  for (const id of PERSONAL_FOLDERS) {
    const already = known?.[id];
    if (typeof already === 'string' && already !== '') {
      folders[id] = already;
    } else if (engineOnlyReads(id, platform)) {
      folders[id] = ask(id);
    } else {
      // Le moteur créerait ce dossier : son emplacement habituel est désigné sans lui.
      const home = ask('home');
      folders[id] = home && path.isAbsolute(home) ? path.join(home, CREATED_WHEN_MISSING[id]) : null;
    }
  }
  return folders;
}

module.exports = { personalFolders, engineOnlyReads, PERSONAL_FOLDERS, CREATED_WHEN_MISSING };

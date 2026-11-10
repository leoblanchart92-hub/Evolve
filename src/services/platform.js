'use strict';

/**
 * Evolve — Emplacements propres à chaque système.
 *
 * Seul endroit de la couche de services qui connaît les conventions de
 * Windows, de Linux et de macOS. Les services reçoivent des chemins déjà
 * résolus : ils fonctionnent à l'identique sur chaque système.
 *
 *   Windows : %APPDATA%\Evolve                    (profil itinérant de l'utilisateur)
 *   Linux   : $XDG_CONFIG_HOME/evolve, à défaut ~/.config/evolve
 *   macOS   : ~/Library/Application Support/Evolve
 */

const os = require('node:os');
const path = require('node:path');

/** Nom du fichier des réglages, à l'intérieur du dossier des réglages. */
const SETTINGS_FILE = 'settings.json';

/** Module de chemins du système visé (et non de celui qui exécute le code). */
function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Dossier où le système range la configuration des applications de
 * l'utilisateur, déduit des variables d'environnement.
 */
function userConfigRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const paths = pathFor(platform);
  if (platform === 'win32') {
    return env.APPDATA && paths.isAbsolute(env.APPDATA) ? env.APPDATA : paths.join(home, 'AppData', 'Roaming');
  }
  if (platform === 'darwin') return paths.join(home, 'Library', 'Application Support');
  // Norme XDG : une valeur relative est invalide et doit être ignorée.
  return env.XDG_CONFIG_HOME && paths.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : paths.join(home, '.config');
}

/**
 * Dossier des réglages d'Evolve.
 * @param {object} [options]
 * @param {string} [options.platform]  système visé (par défaut : celui en cours)
 * @param {string} [options.appData]   dossier de configuration déjà connu de
 *                                     l'hôte (Electron : `app.getPath('appData')`)
 * @param {object} [options.env]       variables d'environnement
 * @param {string} [options.home]      dossier personnel de l'utilisateur
 */
function settingsDir({ platform = process.platform, appData, env, home } = {}) {
  const paths = pathFor(platform);
  const root = typeof appData === 'string' && appData ? appData : userConfigRoot({ platform, env, home });
  // Linux : les dossiers de configuration sont en minuscules, par convention.
  return paths.join(root, platform === 'win32' || platform === 'darwin' ? 'Evolve' : 'evolve');
}

/** Fichier des réglages d'Evolve à l'intérieur de `dir`. */
function settingsFile(dir, { platform = process.platform } = {}) {
  return pathFor(platform).join(dir, SETTINGS_FILE);
}

module.exports = { SETTINGS_FILE, settingsDir, settingsFile, userConfigRoot };

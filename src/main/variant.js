'use strict';

/**
 * Evolve — Façon dont l'application a été lancée.
 *
 *   « installed »    installée par Evolve-Setup : l'installateur pose le
 *                    désinstallateur à côté du programme ;
 *   « portable »     exécutable portable, qui se décompresse dans le dossier
 *                    temporaire à chaque lancement ;
 *   « unpacked »     programme empaqueté lancé depuis un dossier quelconque
 *                    (vérifications de la compilation automatique) ;
 *   « development »  lancée depuis les sources (« npm start »).
 *
 * Seule la version installée se met à jour (voir services/updates.js) :
 * l'exécutable portable ne se connecte jamais au réseau.
 *
 * Module pur (aucune dépendance à Electron) : testé directement avec Node.
 */

const nodeFs = require('node:fs');
const path = require('node:path');

/** Nom du désinstallateur posé par l'installateur dans le dossier du programme. */
const UNINSTALLER = 'Uninstall Evolve.exe';

/**
 * @param {object} options
 * @param {boolean} options.packaged   l'application est empaquetée (Electron : `app.isPackaged`)
 * @param {object} [options.env]       variables d'environnement
 * @param {string} [options.execPath]  chemin du programme en cours
 * @param {object} [options.fs]        module de fichiers (remplacé par les tests)
 * @returns {'installed'|'portable'|'unpacked'|'development'}
 */
function detectVariant({ packaged, env = process.env, execPath = process.execPath, fs = nodeFs } = {}) {
  if (packaged !== true) return 'development';
  // Variable posée par le lanceur de l'exécutable portable.
  if (typeof env?.PORTABLE_EXECUTABLE_FILE === 'string' && env.PORTABLE_EXECUTABLE_FILE !== '') return 'portable';
  try {
    return fs.existsSync(path.join(path.dirname(String(execPath)), UNINSTALLER)) ? 'installed' : 'unpacked';
  } catch {
    return 'unpacked';
  }
}

module.exports = { detectVariant, UNINSTALLER };

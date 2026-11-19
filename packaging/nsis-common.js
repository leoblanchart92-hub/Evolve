'use strict';

/**
 * Evolve — Réglages communs des installateurs Windows (NSIS).
 *
 * Deux installateurs sont fabriqués à partir de cette base :
 *   - l'un pour l'utilisateur courant, sans droits d'administrateur
 *     (packaging/nsis-user.builder.js) ;
 *   - l'autre pour tous les utilisateurs, dans « Program Files », pour lequel
 *     Windows demande une confirmation (packaging/nsis-machine.builder.js).
 *
 * Ils sont utilisés avec « electron-builder --config » ; la configuration de
 * référence reste celle de package.json (champ « build »), reprise ici.
 */

const { build } = require('../package.json');

/** Identifiant stable de l'installation (évite les entrées en double). */
const GUID = 'io.github.leoblanchart92hub.evolve';

/**
 * @param {object} options
 * @param {boolean} options.perMachine        installation pour tous les utilisateurs
 * @param {string} options.artifactName       nom du fichier produit
 * @returns {object} configuration electron-builder
 */
function nsisConfig({ perMachine, artifactName }) {
  const config = {
    ...build,
    win: {
      ...build.win,
      target: [{ target: 'nsis', arch: ['x64'] }],
      // L'application elle-même ne demande jamais l'élévation : seul
      // l'installateur pour tous les utilisateurs l'obtient via NSIS
      // (perMachine). Laisser l'app en asInvoker évite une demande à chaque lancement.
      requestedExecutionLevel: 'asInvoker',
    },
    nsis: {
      /** Nom du fichier produit. */
      artifactName,
      /** Assistant classique : dossier d'installation et raccourcis visibles. */
      oneClick: false,
      perMachine,
      /** « Program Files » n'est accessible qu'avec les droits d'administrateur. */
      allowElevation: perMachine,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'Evolve',
      runAfterFinish: true,
      /** Les réglages de l'utilisateur survivent à une désinstallation. */
      deleteAppDataOnUninstall: false,
      uninstallDisplayName: 'Evolve ${version}',
      guid: GUID,
      /** Assistant en français, comme le reste de l'interface. */
      installerLanguages: ['fr_FR'],
      language: '1036',
      displayLanguageSelector: false,
    },
    publish: null,
  };
  // Une installation Windows n'a rien à voir du lanceur portable.
  delete config.portable;
  return config;
}

module.exports = { nsisConfig, GUID };

'use strict';

/**
 * Evolve — Installateur pour l'utilisateur courant (sans droits d'administrateur).
 *
 * Installe Evolve dans le dossier personnel de l'utilisateur
 * (%LOCALAPPDATA%\Programs\Evolve), avec un raccourci dans le menu Démarrer et
 * sur le bureau, et un désinstallateur. Windows ne demande aucun mot de passe.
 */

const { nsisConfig } = require('./nsis-common');

module.exports = nsisConfig({
  perMachine: false,
  artifactName: 'Evolve-${version}-setup.exe',
});

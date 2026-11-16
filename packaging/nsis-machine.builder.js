'use strict';

/**
 * Evolve — Installateur pour tous les utilisateurs (droits d'administrateur).
 *
 * Installe Evolve dans « Program Files », pour tous les comptes de la machine.
 * Windows affiche sa demande de confirmation habituelle : c'est le seul
 * exécutable du projet qui la déclenche, et il est publié à part.
 */

const { nsisConfig } = require('./nsis-common');

module.exports = nsisConfig({
  perMachine: true,
  artifactName: 'Evolve-${version}-setup-tous-utilisateurs.exe',
});

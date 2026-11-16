'use strict';

/**
 * Evolve — Service « système » : ce que l'application sait d'elle-même.
 *
 * Lecture seule : ce service ne modifie rien, n'écrit rien et ne lit aucun
 * fichier. L'hôte (l'application de bureau) lui fournit les informations au
 * moment où elles sont demandées ; hors de cet hôte — dans les tests, ou pour
 * un autre bureau demain — il s'annonce simplement indisponible.
 *
 *   system.info()        version, type d'installation, dossiers utilisés
 *   system.open(cible)   ouvre un de ces dossiers dans l'explorateur du système
 */

const { ServiceError } = require('./hub');

/** Cibles ouvrables : un dossier désigné par `info().paths`. */
const TARGETS = Object.freeze(['settings', 'data', 'install']);

/**
 * @param {object} [options]
 * @param {(() => object)|object|null} [options.info]  informations sur
 *        l'exécution en cours, ou une fonction qui les produit à la demande
 * @param {((target: string, folder: string) => Promise<string|null>)|null} [options.open]
 *        ouvre un dossier ; renvoie un message d'erreur éventuel
 * @param {(message: string) => void} [options.log]
 */
function createSystemService({ info = null, open = null, log = () => {} } = {}) {
  /** Informations courantes (une fonction est appelée à chaque demande). */
  function current() {
    const value = typeof info === 'function' ? info() : info;
    if (!value || typeof value !== 'object') {
      throw new ServiceError('unavailable', "Les informations sur l'application ne sont pas disponibles.");
    }
    return value;
  }

  return {
    /** Version, type d'installation et dossiers utilisés. */
    info() {
      return current();
    },

    /**
     * Ouvre un dossier d'Evolve dans l'explorateur de fichiers du système :
     * 'settings' (réglages), 'data' (données de travail), 'install' (application).
     */
    async open(target) {
      if (!TARGETS.includes(target)) throw new ServiceError('unknown-target', 'Dossier inconnu.');
      const folder = current().paths?.[target];
      if (typeof folder !== 'string' || !folder) {
        throw new ServiceError('unknown-target', "Ce dossier n'est pas utilisé dans cette exécution.");
      }
      if (typeof open !== 'function') throw new ServiceError('unavailable', "L'ouverture d'un dossier n'est pas disponible.");
      const error = await open(target, folder);
      if (error) throw new ServiceError('failed', error);
      return { opened: folder };
    },

    /** État du service, pour les comptes rendus. */
    status() {
      return { state: info ? 'available' : 'unavailable', access: 'read-only', targets: [...TARGETS] };
    },

    /** Abonne `listener(event, payload, origin)` aux événements du service. */
    on(listener) {
      void listener;
      void log;
      return () => {};
    },
  };
}

module.exports = { createSystemService, SYSTEM_TARGETS: TARGETS };

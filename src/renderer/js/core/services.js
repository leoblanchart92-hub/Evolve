/**
 * Evolve — Accès aux services depuis l'interface.
 *
 * Les services (réglages…) vivent en dehors de l'interface, dans
 * l'application de bureau (src/services/). L'interface les appelle par leur
 * nom et ne sait rien de la façon dont ils sont réalisés.
 *
 * Dans un simple navigateur (aperçu de développement), aucun service
 * n'existe : chaque appel échoue avec le code « unavailable ».
 */

import { hostServices } from './platform.js';

/** Erreur renvoyée par un service ; `code` l'identifie de façon stable. */
export class ServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}

/**
 * Accès aux services à travers la passerelle `host` de l'application de
 * bureau (`null` dans un navigateur).
 */
export function createServiceClient(host) {
  return {
    /** Faux dans un navigateur : aucun service n'est joignable. */
    available: Boolean(host),

    /**
     * Appelle une méthode d'un service et renvoie son résultat.
     * Rejette avec une `ServiceError` si le service refuse ou échoue.
     */
    async call(service, method, ...args) {
      if (!host) throw new ServiceError('unavailable', "Service indisponible hors de l'application de bureau.");
      const reply = await host.call(service, method, ...args);
      if (reply?.ok === true) return reply.value;
      throw new ServiceError(reply?.code ?? 'failed', reply?.message ?? 'Réponse inattendue du service.');
    },

    /** Abonne `listener(données)` à un événement d'un service ; renvoie une fonction de désabonnement. */
    on(service, event, listener) {
      return host ? host.on(service, event, listener) : () => {};
    },
  };
}

export const services = createServiceClient(hostServices);

/**
 * Evolve — Opérations sur les fichiers, depuis l'interface.
 *
 * Créer un dossier, renommer, copier, déplacer, envoyer à la Corbeille et
 * ouvrir un fichier : l'interface demande, l'application de bureau contrôle
 * et agit (src/services/file-operations.js). L'interface ne touche jamais au
 * disque : elle n'a que ces sept demandes, et aucune ne supprime
 * définitivement ni ne remplace un élément.
 *
 * Dans un simple navigateur (aperçu de développement), aucune opération
 * n'existe : chaque demande échoue avec le code « unavailable ».
 */

import { hostFiles } from './platform.js';
import { ServiceError } from './services.js';

/**
 * Accès aux opérations à travers la passerelle `host` de l'application de
 * bureau (`null` dans un navigateur).
 */
export function createFileOperationsClient(host) {
  /** Résultat d'une demande, ou `ServiceError` si elle est refusée ou échoue. */
  const ask = async (send) => {
    if (!host) throw new ServiceError('unavailable', "Les opérations sur les fichiers nécessitent l'application Windows.");
    const reply = await send();
    if (reply?.ok === true) return reply.value;
    throw new ServiceError(reply?.code ?? 'failed', reply?.message ?? "Réponse inattendue de l'application.");
  };

  return {
    /** Faux dans un navigateur : aucune opération n'est possible. */
    available: Boolean(host),

    /** Crée le dossier `name` dans le dossier `parent`. */
    createFolder: (parent, name) => ask(() => host.createFolder(parent, name)),

    /** Donne le nom `name` à l'élément `target`. */
    rename: (target, name) => ask(() => host.rename(target, name)),

    /**
     * Copie `sources` dans le dossier `destination`.
     * `choices` : `{ operation, onCollision: 'ask' | 'keep-both' | 'skip' }`.
     */
    copy: (sources, destination, choices) => ask(() => host.copy(sources, destination, choices)),

    /** Déplace `sources` dans le dossier `destination` ; `choices.confirmed` doit être vrai. */
    move: (sources, destination, choices) => ask(() => host.move(sources, destination, choices)),

    /** Envoie `targets` à la Corbeille de Windows ; `choices.confirmed` doit être vrai. */
    trash: (targets, choices) => ask(() => host.trash(targets, choices)),

    /** Ouvre le fichier `target` avec l'application que Windows lui associe. */
    open: (target, choices) => ask(() => host.open(target, choices)),

    /** Demande l'arrêt de l'opération `operation` ; sans effet si elle est terminée. */
    cancel: (operation) => (host ? host.cancel(operation).then((reply) => reply?.ok === true && reply.value === true, () => false) : Promise.resolve(false)),

    /** Abonne `listener(progression)` à l'avancement des opérations ; renvoie une fonction de désabonnement. */
    onProgress: (listener) => (host ? host.onProgress(listener) : () => {}),
  };
}

export const fileOperations = createFileOperationsClient(hostFiles);

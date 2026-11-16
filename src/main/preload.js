'use strict';

/**
 * Evolve — Script de préchargement.
 *
 * Seule passerelle entre l'interface (page web isolée, sans accès à Node.js)
 * et l'application de bureau. Elle n'expose que quelques actions précises :
 * quitter, gérer le plein écran, appeler les services d'Evolve par leur nom
 * (réglages, consultation des dossiers — voir src/services/) et demander une
 * opération sur les fichiers.
 *
 * Les opérations sur les fichiers ne passent pas par les services : chacune
 * est une fonction distincte, reliée à un canal qui lui est propre et dont le
 * nom est écrit ici en toutes lettres. La page ne choisit jamais un canal, et
 * n'a aucun accès direct au système de fichiers, au registre ou aux
 * paramètres de Windows : chaque demande est contrôlée par l'application de
 * bureau, qui seule agit.
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Attend la réponse d'une demande. La promesse renvoie toujours
 * `{ ok: true, value }` ou `{ ok: false, code, message }` : elle ne rejette
 * jamais, même si la demande ne peut pas être transmise.
 * @param {() => Promise<object>} send
 */
async function answer(send) {
  try {
    return await send();
  } catch {
    return { ok: false, code: 'failed', message: "La demande n'a pas pu être transmise." };
  }
}

/**
 * Abonnés à l'avancement des opérations sur les fichiers. Chaque fenêtre de
 * l'explorateur s'abonne en s'ouvrant et se désabonne en se fermant : un seul
 * écouteur est posé sur le canal, quel que soit leur nombre, et leur répète
 * chaque annonce.
 */
const progressSubscribers = new Set();
ipcRenderer.on('evolve:files-progress', (_event, progress) => {
  for (const subscriber of [...progressSubscribers]) {
    // Un abonné désabonné pendant cette annonce (fenêtre fermée) n'est plus appelé.
    if (!progressSubscribers.has(subscriber)) continue;
    try {
      subscriber.callback(progress);
    } catch (error) {
      // Un abonné en panne ne prive pas les autres de l'annonce ; la panne reste visible.
      console.error("Evolve : un abonné à l'avancement des opérations a échoué.", error);
    }
  }
});

contextBridge.exposeInMainWorld('evolve', {
  isDesktopApp: true,

  /** Ferme l'application. */
  quit: () => ipcRenderer.send('evolve:quit'),

  /** Bascule entre plein écran et mode fenêtré. */
  toggleFullscreen: () => ipcRenderer.invoke('evolve:toggle-fullscreen'),

  /** Indique si l'application est en plein écran. */
  isFullscreen: () => ipcRenderer.invoke('evolve:is-fullscreen'),

  /**
   * Abonne `callback(estEnPleinÉcran)` aux changements de mode d'affichage.
   * @returns {() => void} fonction de désabonnement
   */
  onFullscreenChange: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(Boolean(value));
    ipcRenderer.on('evolve:fullscreen-changed', listener);
    return () => ipcRenderer.removeListener('evolve:fullscreen-changed', listener);
  },

  /** Services d'Evolve (réglages, consultation des dossiers…), indépendants de l'interface. */
  services: {
    /**
     * Appelle une méthode d'un service. La promesse renvoie toujours
     * `{ ok: true, value }` ou `{ ok: false, code, message }` : elle ne
     * rejette jamais, même si la demande ne peut pas être transmise.
     */
    call: (service, method, ...args) => answer(() => ipcRenderer.invoke('evolve:service-call', String(service), String(method), args)),

    /**
     * Abonne `callback(données)` à un événement d'un service.
     * @returns {() => void} fonction de désabonnement
     */
    on: (service, event, callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, message) => {
        if (message && message.service === service && message.event === event) callback(message.payload);
      };
      ipcRenderer.on('evolve:service-event', listener);
      return () => ipcRenderer.removeListener('evolve:service-event', listener);
    },
  },

  /**
   * Opérations sur les fichiers de l'utilisateur. Sept demandes, et aucune
   * autre : il n'existe ni suppression définitive, ni remplacement, ni
   * lecture, ni écriture du contenu d'un fichier. Chaque promesse renvoie
   * `{ ok: true, value }` ou `{ ok: false, code, message }`.
   */
  files: {
    /** Crée le dossier `name` dans le dossier `parent`. */
    createFolder: (parent, name) => answer(() => ipcRenderer.invoke('evolve:files-create-folder', parent, name)),

    /** Donne le nom `name` à l'élément `target`. */
    rename: (target, name) => answer(() => ipcRenderer.invoke('evolve:files-rename', target, name)),

    /** Copie les éléments `sources` dans le dossier `destination`. */
    copy: (sources, destination, choices) => answer(() => ipcRenderer.invoke('evolve:files-copy', sources, destination, choices ?? null)),

    /** Déplace les éléments `sources` dans le dossier `destination` (confirmation exigée). */
    move: (sources, destination, choices) => answer(() => ipcRenderer.invoke('evolve:files-move', sources, destination, choices ?? null)),

    /** Envoie les éléments `targets` à la Corbeille de Windows (confirmation exigée). */
    trash: (targets, choices) => answer(() => ipcRenderer.invoke('evolve:files-trash', targets, choices ?? null)),

    /** Ouvre le fichier `target` avec l'application que Windows lui associe. */
    open: (target, choices) => answer(() => ipcRenderer.invoke('evolve:files-open', target, choices ?? null)),

    /** Demande l'arrêt de l'opération en cours, désignée par son identifiant. */
    cancel: (operation) => answer(() => ipcRenderer.invoke('evolve:files-cancel', operation)),

    /**
     * Abonne `callback(progression)` à l'avancement des opérations longues.
     * @returns {() => void} fonction de désabonnement
     */
    onProgress: (callback) => {
      if (typeof callback !== 'function') return () => {};
      // Un abonnement par appel, même pour une fonction déjà abonnée.
      const subscriber = { callback };
      progressSubscribers.add(subscriber);
      return () => {
        progressSubscribers.delete(subscriber);
      };
    },
  },
});

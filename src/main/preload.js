'use strict';

/**
 * Evolve — Script de préchargement.
 *
 * Seule passerelle entre l'interface (page web isolée, sans accès à Node.js)
 * et l'application de bureau. Elle n'expose que quelques actions précises :
 * quitter, gérer le plein écran et appeler les services d'Evolve par leur nom
 * (voir src/services/). La page n'a aucun accès direct au système de
 * fichiers, au registre ou aux paramètres de Windows : chaque demande est
 * contrôlée par le service qui la reçoit.
 */

const { contextBridge, ipcRenderer } = require('electron');

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
    call: async (service, method, ...args) => {
      try {
        return await ipcRenderer.invoke('evolve:service-call', String(service), String(method), args);
      } catch {
        return { ok: false, code: 'failed', message: "La demande n'a pas pu être transmise." };
      }
    },

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
});

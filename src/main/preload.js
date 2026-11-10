'use strict';

/**
 * Evolve — Script de préchargement.
 *
 * Seule passerelle entre l'interface (page web isolée, sans accès à Node.js)
 * et l'application de bureau. Elle n'expose que quelques actions précises :
 * quitter et gérer le plein écran. Aucun accès au système de fichiers, au
 * registre ou aux paramètres de Windows.
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
});

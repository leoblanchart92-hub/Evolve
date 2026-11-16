/**
 * Evolve — Barre des tâches : ce qu'elle montre des fenêtres ouvertes.
 *
 * Module sans affichage (testé directement avec Node). À partir des fenêtres
 * ouvertes, il établit la liste des boutons d'application — les applications
 * épinglées d'abord, puis les autres applications ouvertes — et décide de ce
 * que fait un clic sur chacun, comme dans Windows :
 *   - aucune fenêtre : l'application est lancée ;
 *   - une fenêtre : elle est activée, ou réduite si elle était déjà active ;
 *   - plusieurs fenêtres : leur liste est proposée.
 */

/**
 * @typedef {{ id: string, appId: string, title: string, minimized: boolean }} WindowInfo
 * @typedef {{ appId: string, pinned: boolean, running: boolean, active: boolean, windows: (WindowInfo & { active: boolean })[] }} TaskbarButton
 */

/**
 * Boutons d'application de la barre des tâches.
 * @param {object} state
 * @param {string[]} state.pinned  applications épinglées, dans l'ordre
 * @param {WindowInfo[]} state.windows  fenêtres ouvertes, dans l'ordre d'ouverture
 * @param {string|null} state.activeId  fenêtre active
 * @returns {TaskbarButton[]}
 */
export function taskbarButtons({ pinned = [], windows = [], activeId = null }) {
  const order = [...new Set(pinned)];
  for (const win of windows) if (!order.includes(win.appId)) order.push(win.appId);
  return order.map((appId) => {
    const own = windows.filter((win) => win.appId === appId).map((win) => ({ ...win, active: win.id === activeId && !win.minimized }));
    return { appId, pinned: pinned.includes(appId), running: own.length > 0, active: own.some((win) => win.active), windows: own };
  });
}

/**
 * Ce que fait un clic sur le bouton d'une application.
 * @param {TaskbarButton} button
 * @param {{ newWindow?: boolean }} [options]  clic avec Maj, ou du bouton du milieu : une nouvelle fenêtre est demandée
 * @returns {{ type: 'launch' } | { type: 'new-window' } | { type: 'minimize', id: string } | { type: 'activate', id: string } | { type: 'pick' }}
 */
export function clickAction(button, { newWindow = false } = {}) {
  const { windows } = button;
  if (windows.length === 0) return { type: 'launch' };
  if (newWindow) return { type: 'new-window' };
  if (windows.length > 1) return { type: 'pick' };
  const [only] = windows;
  return only.active ? { type: 'minimize', id: only.id } : { type: 'activate', id: only.id };
}

/**
 * Texte de l'infobulle d'un bouton : le nom de l'application, le titre de sa
 * fenêtre, ou le nombre de ses fenêtres.
 * @param {TaskbarButton} button
 * @param {string} appName
 */
export function buttonTip(button, appName) {
  const { windows } = button;
  if (windows.length === 0) return appName;
  if (windows.length === 1) return windows[0].title || appName;
  return `${appName} — ${windows.length} fenêtres`;
}

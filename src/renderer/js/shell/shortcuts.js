/**
 * Evolve — Raccourcis clavier du bureau et des fenêtres.
 *
 * Evolve est une application ordinaire de Windows : la touche Windows,
 * Alt + Tab ou Ctrl + Échap restent ceux de Windows, qui les traite avant
 * toute application. Le bureau d'Evolve a donc ses propres raccourcis, choisis
 * parmi ceux que Windows laisse aux applications :
 *
 *   - les conventions des applications à plusieurs fenêtres — Ctrl + Tab pour
 *     passer d'une fenêtre à l'autre, Ctrl + W pour fermer, Ctrl + N pour
 *     une nouvelle fenêtre, F6 pour passer d'une zone de l'écran à l'autre ;
 *   - Alt + Maj à la place de la touche Windows : Alt + Maj + flèches pour
 *     agrandir, restaurer ou ancrer la fenêtre, Alt + Maj + D pour le bureau,
 *     Alt + Maj + E pour l'explorateur ;
 *   - Ctrl + Espace pour le menu Démarrer.
 *
 * Module sans affichage (testé directement avec Node) : il reconnaît une
 * commande dans un événement clavier, et rien d'autre. Le bureau (shell.js)
 * décide ensuite de ce que la commande fait.
 */

/**
 * Commandes, dans l'ordre de leur présentation : identifiant, intitulé, et
 * raccourci tel qu'il s'écrit pour l'utilisateur.
 */
export const COMMANDS = Object.freeze([
  { id: 'switch-next', label: 'Passer à la fenêtre suivante', keys: 'Ctrl+Tab' },
  { id: 'switch-previous', label: 'Passer à la fenêtre précédente', keys: 'Ctrl+Maj+Tab' },
  { id: 'close-window', label: 'Fermer la fenêtre active', keys: 'Ctrl+W' },
  { id: 'new-window', label: 'Ouvrir une nouvelle fenêtre', keys: 'Ctrl+N' },
  { id: 'start-menu', label: 'Ouvrir ou fermer le menu Démarrer', keys: 'Ctrl+Espace' },
  { id: 'show-desktop', label: 'Afficher le bureau, puis rétablir les fenêtres', keys: 'Alt+Maj+D' },
  { id: 'open-explorer', label: "Ouvrir une fenêtre de l'explorateur de fichiers", keys: 'Alt+Maj+E' },
  { id: 'window-maximize', label: 'Agrandir la fenêtre active', keys: 'Alt+Maj+Haut' },
  { id: 'window-restore', label: 'Restaurer la fenêtre active, puis la réduire', keys: 'Alt+Maj+Bas' },
  { id: 'window-snap-left', label: "Ancrer la fenêtre active sur la moitié gauche de l'écran", keys: 'Alt+Maj+Gauche' },
  { id: 'window-snap-right', label: "Ancrer la fenêtre active sur la moitié droite de l'écran", keys: 'Alt+Maj+Droite' },
  { id: 'next-region', label: "Passer à la zone suivante de l'écran : fenêtre, barre des tâches, bureau", keys: 'F6' },
  { id: 'previous-region', label: "Passer à la zone précédente de l'écran", keys: 'Maj+F6' },
]);

const BY_ID = new Map(COMMANDS.map((command) => [command.id, command]));

/** Raccourci d'une commande, tel qu'il s'écrit pour l'utilisateur (« Ctrl+Tab »), ou une chaîne vide. */
export const shortcutLabel = (id) => BY_ID.get(id)?.keys ?? '';

/** Commandes qui se répètent tant que les touches restent enfoncées. */
const REPEATABLE = new Set(['switch-next', 'switch-previous']);

const ARROWS = Object.freeze({
  ArrowUp: 'window-maximize',
  ArrowDown: 'window-restore',
  ArrowLeft: 'window-snap-left',
  ArrowRight: 'window-snap-right',
});

/**
 * Commande que désigne un événement clavier (« keydown »), ou `null`.
 *
 * Les modificateurs doivent correspondre exactement : Ctrl + Alt + Tab ou
 * Ctrl + Maj + W ne désignent rien. AltGr — qui vaut Ctrl + Alt et sert à
 * saisir des caractères — ne déclenche jamais rien, pas plus qu'une touche
 * pressée pendant la composition d'un caractère. Une touche maintenue ne
 * répète que la bascule entre fenêtres : Ctrl + W gardé enfoncé ne ferme
 * qu'une fenêtre.
 *
 * @param {{ key?: string, code?: string, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, metaKey?: boolean,
 *           repeat?: boolean, isComposing?: boolean, getModifierState?: (name: string) => boolean }} event
 * @returns {string|null} identifiant de la commande (voir COMMANDS)
 */
export function commandFor(event) {
  if (!event || typeof event.key !== 'string') return null;
  if (event.isComposing || event.metaKey) return null;
  if (typeof event.getModifierState === 'function' && event.getModifierState('AltGraph')) return null;

  const ctrl = Boolean(event.ctrlKey);
  const alt = Boolean(event.altKey);
  const shift = Boolean(event.shiftKey);
  const { key } = event;
  const letter = key.length === 1 ? key.toLowerCase() : '';
  let command = null;

  if (ctrl && !alt) {
    if (key === 'Tab' || key === 'F6') command = shift ? 'switch-previous' : 'switch-next';
    else if (!shift && (letter === 'w' || key === 'F4')) command = 'close-window';
    else if (!shift && letter === 'n') command = 'new-window';
    else if (!shift && (key === ' ' || event.code === 'Space')) command = 'start-menu';
  } else if (alt && shift && !ctrl) {
    if (Object.hasOwn(ARROWS, key)) command = ARROWS[key];
    else if (letter === 'd') command = 'show-desktop';
    else if (letter === 'e') command = 'open-explorer';
  } else if (!ctrl && !alt && key === 'F6') {
    command = shift ? 'previous-region' : 'next-region';
  }

  if (command && event.repeat && !REPEATABLE.has(command)) return null;
  return command;
}

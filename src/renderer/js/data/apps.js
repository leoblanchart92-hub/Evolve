/**
 * Evolve — Registre des applications affichées dans l'interface.
 *
 * `kind` indique le contenu de la fenêtre :
 *   - 'explorer'    : explorateur de fichiers (interface complète) ;
 *   - 'placeholder' : fenêtre d'attente — l'application elle-même sera
 *                     développée dans une prochaine étape.
 *
 * `glyph` est un pictogramme (voir core/icons.js) et `colors` le dégradé de la
 * tuile d'icône.
 */

export const APPS = Object.freeze([
  {
    id: 'explorer',
    name: 'Explorateur de fichiers',
    shortName: 'Explorateur',
    kind: 'explorer',
    glyph: 'folder',
    colors: ['#d3b0ff', '#7c3aed'],
    keywords: ['fichiers', 'dossiers', 'documents', 'disque'],
    size: { w: 62, h: 40, minW: 30, minH: 20 },
  },
  {
    id: 'browser',
    name: 'Navigateur',
    kind: 'placeholder',
    glyph: 'compass',
    colors: ['#8fd8ff', '#6557f5'],
    keywords: ['web', 'internet', 'site'],
  },
  {
    id: 'store',
    name: 'Boutique',
    kind: 'placeholder',
    glyph: 'storefront',
    colors: ['#ff9be0', '#a548f2'],
    keywords: ['applications', 'télécharger', 'store'],
  },
  {
    id: 'terminal',
    name: 'Terminal',
    kind: 'placeholder',
    glyph: 'terminal-window',
    colors: ['#6a52b8', '#1b0c3d'],
    keywords: ['console', 'commande', 'invite'],
  },
  {
    id: 'settings',
    name: 'Paramètres',
    kind: 'placeholder',
    glyph: 'gear-six',
    colors: ['#b4b4dc', '#51409c'],
    keywords: ['réglages', 'configuration', 'options', 'personnalisation'],
  },
  {
    id: 'mail',
    name: 'Courrier',
    kind: 'placeholder',
    glyph: 'envelope-simple',
    colors: ['#8cc0ff', '#7447f5'],
    keywords: ['e-mail', 'messagerie', 'mail'],
  },
  {
    id: 'calendar',
    name: 'Calendrier',
    kind: 'placeholder',
    glyph: 'calendar-dots',
    colors: ['#ff9bb4', '#bd2bd6'],
    keywords: ['agenda', 'rendez-vous', 'date'],
  },
  {
    id: 'photos',
    name: 'Photos',
    kind: 'placeholder',
    glyph: 'image',
    colors: ['#ffbe7a', '#ee4f9c'],
    keywords: ['images', 'galerie'],
  },
  {
    id: 'music',
    name: 'Musique',
    kind: 'placeholder',
    glyph: 'music-notes',
    colors: ['#ff86cf', '#8a52f5'],
    keywords: ['audio', 'lecteur', 'chansons'],
  },
  {
    id: 'videos',
    name: 'Vidéos',
    kind: 'placeholder',
    glyph: 'film-slate',
    colors: ['#9d98ff', '#3d2bd0'],
    keywords: ['films', 'lecteur'],
  },
  {
    id: 'notes',
    name: 'Notes',
    kind: 'placeholder',
    glyph: 'note-pencil',
    colors: ['#ffdc7c', '#ff8a45'],
    keywords: ['bloc-notes', 'texte', 'écrire'],
  },
  {
    id: 'calculator',
    name: 'Calculatrice',
    kind: 'placeholder',
    glyph: 'calculator',
    colors: ['#9aa6e0', '#4d3fae'],
    keywords: ['calcul', 'maths'],
  },
  {
    id: 'weather',
    name: 'Météo',
    kind: 'placeholder',
    glyph: 'cloud-sun',
    colors: ['#7ce6ff', '#4b78fb'],
    keywords: ['prévisions', 'temps'],
  },
  {
    id: 'clock',
    name: 'Horloge',
    kind: 'placeholder',
    glyph: 'clock',
    colors: ['#cfaaff', '#5346e6'],
    keywords: ['alarme', 'minuteur', 'heure'],
  },
  {
    id: 'camera',
    name: 'Caméra',
    kind: 'placeholder',
    glyph: 'camera',
    colors: ['#bdb8de', '#5c39ba'],
    keywords: ['photo', 'webcam'],
  },
  {
    id: 'maps',
    name: 'Cartes',
    kind: 'placeholder',
    glyph: 'map-trifold',
    colors: ['#7df2c6', '#3b7ff5'],
    keywords: ['plan', 'itinéraire', 'navigation'],
  },
  {
    id: 'games',
    name: 'Jeux',
    kind: 'placeholder',
    glyph: 'game-controller',
    colors: ['#ff86a4', '#8a3ffc'],
    keywords: ['jouer', 'gaming'],
  },
  {
    id: 'monitor',
    name: 'Moniteur système',
    shortName: 'Moniteur',
    kind: 'placeholder',
    glyph: 'pulse',
    colors: ['#eaa8ff', '#7a38ea'],
    keywords: ['performances', 'processeur', 'mémoire', 'cpu', 'ram', 'gpu'],
  },
]);

/** Applications épinglées dans la barre des tâches (dans l'ordre). */
export const TASKBAR_PINNED = Object.freeze(['explorer', 'browser', 'store', 'terminal', 'settings']);

/** Applications de la grille « Épinglées » du menu Démarrer (dans l'ordre). */
export const START_PINNED = Object.freeze(APPS.map((app) => app.id));

/**
 * Icônes du bureau. `open` désigne l'application à ouvrir et, pour
 * l'explorateur, l'emplacement à afficher (voir data/demo-files.js).
 */
export const DESKTOP_ICONS = Object.freeze([
  { id: 'this-pc', name: 'Ce PC', glyph: 'desktop', colors: ['#a6b8ff', '#5a3fe0'], open: { app: 'explorer', location: 'pc' } },
  { id: 'documents', name: 'Documents', glyph: 'folder', colors: ['#d3b0ff', '#7c3aed'], open: { app: 'explorer', location: 'pc/Documents' } },
  { id: 'trash', name: 'Corbeille', glyph: 'trash', colors: ['#b9b3d6', '#4a3a8c'], open: { app: 'explorer', location: 'trash' } },
  { id: 'browser', name: 'Navigateur', glyph: 'compass', colors: ['#8fd8ff', '#6557f5'], open: { app: 'browser' } },
  { id: 'settings', name: 'Paramètres', glyph: 'gear-six', colors: ['#b4b4dc', '#51409c'], open: { app: 'settings' } },
]);

const BY_ID = new Map(APPS.map((app) => [app.id, app]));

/** Renvoie la définition d'une application (ou `undefined`). */
export const getApp = (id) => BY_ID.get(id);

/** Nom court d'une application (barre des tâches, grille du menu Démarrer). */
export const appLabel = (app) => app.shortName ?? app.name;

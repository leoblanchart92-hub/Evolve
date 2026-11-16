/**
 * Evolve — Registre des applications de l'environnement.
 *
 * Une application est DISPONIBLE si elle a un `kind` : c'est le nom de son
 * interface (voir apps/index.js). Elle seule peut être lancée, épinglée dans
 * la barre des tâches ou désignée par une icône du bureau. Les autres sont
 * simplement annoncées : le menu Démarrer les présente comme « bientôt
 * disponibles », estompées, et n'ouvre rien à leur place — aucune fenêtre
 * factice ne simule une application qui n'existe pas.
 *
 *   kind         'explorer' : explorateur de fichiers ;
 *   multiWindow  l'application peut avoir plusieurs fenêtres à la fois ;
 *   glyph        pictogramme (voir core/icons.js) ;
 *   colors       dégradé de la tuile d'icône ;
 *   size         taille de sa fenêtre, en rem.
 */

export const APPS = Object.freeze([
  {
    id: 'explorer',
    name: 'Explorateur de fichiers',
    shortName: 'Explorateur',
    kind: 'explorer',
    multiWindow: true,
    glyph: 'folder',
    colors: ['#d3b0ff', '#7c3aed'],
    keywords: ['fichiers', 'dossiers', 'documents', 'disque'],
    size: { w: 62, h: 40, minW: 30, minH: 20 },
  },
  {
    id: 'browser',
    name: 'Navigateur',
    glyph: 'compass',
    colors: ['#8fd8ff', '#6557f5'],
    keywords: ['web', 'internet', 'site'],
  },
  {
    id: 'store',
    name: 'Boutique',
    glyph: 'storefront',
    colors: ['#ff9be0', '#a548f2'],
    keywords: ['applications', 'télécharger', 'store'],
  },
  {
    id: 'terminal',
    name: 'Terminal',
    glyph: 'terminal-window',
    colors: ['#6a52b8', '#1b0c3d'],
    keywords: ['console', 'commande', 'invite'],
  },
  {
    id: 'settings',
    name: 'Paramètres',
    glyph: 'gear-six',
    colors: ['#b4b4dc', '#51409c'],
    keywords: ['réglages', 'configuration', 'options', 'personnalisation'],
  },
  {
    id: 'mail',
    name: 'Courrier',
    glyph: 'envelope-simple',
    colors: ['#8cc0ff', '#7447f5'],
    keywords: ['e-mail', 'messagerie', 'mail'],
  },
  {
    id: 'calendar',
    name: 'Calendrier',
    glyph: 'calendar-dots',
    colors: ['#ff9bb4', '#bd2bd6'],
    keywords: ['agenda', 'rendez-vous', 'date'],
  },
  {
    id: 'photos',
    name: 'Photos',
    glyph: 'image',
    colors: ['#ffbe7a', '#ee4f9c'],
    keywords: ['images', 'galerie'],
  },
  {
    id: 'music',
    name: 'Musique',
    glyph: 'music-notes',
    colors: ['#ff86cf', '#8a52f5'],
    keywords: ['audio', 'lecteur', 'chansons'],
  },
  {
    id: 'videos',
    name: 'Vidéos',
    glyph: 'film-slate',
    colors: ['#9d98ff', '#3d2bd0'],
    keywords: ['films', 'lecteur'],
  },
  {
    id: 'notes',
    name: 'Notes',
    glyph: 'note-pencil',
    colors: ['#ffdc7c', '#ff8a45'],
    keywords: ['bloc-notes', 'texte', 'écrire'],
  },
  {
    id: 'calculator',
    name: 'Calculatrice',
    glyph: 'calculator',
    colors: ['#9aa6e0', '#4d3fae'],
    keywords: ['calcul', 'maths'],
  },
  {
    id: 'weather',
    name: 'Météo',
    glyph: 'cloud-sun',
    colors: ['#7ce6ff', '#4b78fb'],
    keywords: ['prévisions', 'temps'],
  },
  {
    id: 'clock',
    name: 'Horloge',
    glyph: 'clock',
    colors: ['#cfaaff', '#5346e6'],
    keywords: ['alarme', 'minuteur', 'heure'],
  },
  {
    id: 'camera',
    name: 'Caméra',
    glyph: 'camera',
    colors: ['#bdb8de', '#5c39ba'],
    keywords: ['photo', 'webcam'],
  },
  {
    id: 'maps',
    name: 'Cartes',
    glyph: 'map-trifold',
    colors: ['#7df2c6', '#3b7ff5'],
    keywords: ['plan', 'itinéraire', 'navigation'],
  },
  {
    id: 'games',
    name: 'Jeux',
    glyph: 'game-controller',
    colors: ['#ff86a4', '#8a3ffc'],
    keywords: ['jouer', 'gaming'],
  },
  {
    id: 'monitor',
    name: 'Moniteur système',
    shortName: 'Moniteur',
    glyph: 'pulse',
    colors: ['#eaa8ff', '#7a38ea'],
    keywords: ['performances', 'processeur', 'mémoire', 'cpu', 'ram', 'gpu'],
  },
]);

const BY_ID = new Map(APPS.map((app) => [app.id, app]));

/** Renvoie la définition d'une application (ou `undefined`). */
export const getApp = (id) => BY_ID.get(id);

/** Vrai si l'application existe réellement dans cette version : elle seule peut être lancée. */
export const isAvailable = (app) => typeof app?.kind === 'string' && app.kind !== '';

/** Applications que l'on peut lancer, puis celles qui sont seulement annoncées. */
export const AVAILABLE_APPS = Object.freeze(APPS.filter(isAvailable));
export const UPCOMING_APPS = Object.freeze(APPS.filter((app) => !isAvailable(app)));

/** Nom court d'une application (barre des tâches, grille du menu Démarrer). */
export const appLabel = (app) => app.shortName ?? app.name;

/** Applications épinglées dans la barre des tâches (dans l'ordre) : des applications disponibles seulement. */
export const TASKBAR_PINNED = Object.freeze(['explorer']);

/**
 * Icônes du bureau. Chacune ouvre une application disponible ; pour
 * l'explorateur, `location` est l'emplacement à afficher (voir LOCATION_IDS,
 * apps/explorer-nav.js). Aucune icône ne mène à une application ou à un
 * emplacement qui n'existe pas.
 */
export const DESKTOP_ICONS = Object.freeze([
  { id: 'this-pc', name: 'Ce PC', glyph: 'desktop', colors: ['#a6b8ff', '#5a3fe0'], open: { app: 'explorer', location: 'pc' } },
  { id: 'documents', name: 'Documents', glyph: 'folder', colors: ['#d3b0ff', '#7c3aed'], open: { app: 'explorer', location: 'documents' } },
  { id: 'downloads', name: 'Téléchargements', glyph: 'download-simple', colors: ['#9fe3ff', '#4f6df5'], open: { app: 'explorer', location: 'downloads' } },
  { id: 'pictures', name: 'Images', glyph: 'images', colors: ['#ffb3ec', '#a548f2'], open: { app: 'explorer', location: 'pictures' } },
]);

/**
 * Evolve — Registre des applications affichées dans l'interface.
 *
 * `kind` indique le contenu de la fenêtre :
 *   - 'explorer' : explorateur de fichiers (interface complète) ;
 *   - 'settings' : paramètres d'Evolve (interface complète).
 *
 * Evolve ne présente volontairement que ces deux applications : chacune est
 * réellement utilisable, plutôt qu'une vitrine de fenêtres vides. De nouvelles
 * applications s'ajouteront ici, une à une, lorsqu'elles seront prêtes.
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
    id: 'settings',
    name: 'Paramètres',
    kind: 'settings',
    glyph: 'gear-six',
    colors: ['#b4b4dc', '#51409c'],
    keywords: ['réglages', 'configuration', 'options', 'personnalisation', 'mises à jour', 'version'],
    size: { w: 54, h: 36, minW: 30, minH: 22 },
  },
]);

/** Applications épinglées dans la barre des tâches (dans l'ordre). */
export const TASKBAR_PINNED = Object.freeze(['explorer', 'settings']);

/** Applications de la grille « Épinglées » du menu Démarrer (dans l'ordre). */
export const START_PINNED = Object.freeze(APPS.map((app) => app.id));

/**
 * Icônes du bureau. `open` désigne l'application à ouvrir et, pour
 * l'explorateur, l'emplacement à afficher (voir LOCATION_IDS, apps/explorer-nav.js).
 */
export const DESKTOP_ICONS = Object.freeze([
  { id: 'this-pc', name: 'Ce PC', glyph: 'desktop', colors: ['#a6b8ff', '#5a3fe0'], open: { app: 'explorer', location: 'pc' } },
  { id: 'documents', name: 'Documents', glyph: 'folder', colors: ['#d3b0ff', '#7c3aed'], open: { app: 'explorer', location: 'documents' } },
  { id: 'trash', name: 'Corbeille', glyph: 'trash', colors: ['#b9b3d6', '#4a3a8c'], open: { app: 'explorer', location: 'trash' } },
  { id: 'settings', name: 'Paramètres', glyph: 'gear-six', colors: ['#b4b4dc', '#51409c'], open: { app: 'settings' } },
]);

const BY_ID = new Map(APPS.map((app) => [app.id, app]));

/** Renvoie la définition d'une application (ou `undefined`). */
export const getApp = (id) => BY_ID.get(id);

/** Nom court d'une application (barre des tâches, grille du menu Démarrer). */
export const appLabel = (app) => app.shortName ?? app.name;

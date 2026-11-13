/**
 * Evolve — Explorateur de fichiers : navigation (sans affichage).
 *
 * Tient l'emplacement courant et l'historique (précédent, suivant), demande le
 * contenu des dossiers au service « files » de l'application de bureau — qui
 * lit les vrais dossiers de l'ordinateur, en lecture seule — et prépare la
 * « page » à afficher : titre, fil d'Ariane, éléments ou message. Les
 * opérations sur les fichiers sont tenues par explorer-actions.js.
 *
 * Dans un simple navigateur (aperçu de développement), aucun service
 * n'existe : chaque page annonce que l'accès aux fichiers nécessite
 * l'application Windows. Aucun fichier fictif n'est jamais présenté.
 *
 * Module sans DOM : il se teste directement avec Node.
 */

import { extensionOf } from '../core/file-types.js';
import { normalize } from '../core/text.js';

/** Dossiers personnels, dans l'ordre de l'accès rapide. */
export const PLACES = Object.freeze([
  { id: 'desktop', name: 'Bureau', icon: 'desktop' },
  { id: 'documents', name: 'Documents', icon: 'file-text' },
  { id: 'pictures', name: 'Images', icon: 'images' },
  { id: 'music', name: 'Musique', icon: 'music-notes' },
  { id: 'downloads', name: 'Téléchargements', icon: 'download-simple' },
  { id: 'videos', name: 'Vidéos', icon: 'film-strip' },
]);

const PLACE_BY_ID = new Map(PLACES.map((place) => [place.id, place]));

/** Pages qui ne sont pas des dossiers. */
const PAGES = Object.freeze({
  home: { name: 'Accueil', icon: 'house' },
  pc: { name: 'Ce PC', icon: 'desktop' },
  network: {
    name: 'Réseau',
    icon: 'network',
    message: {
      glyph: 'network',
      title: 'Réseau non disponible',
      text: 'Evolve ne parcourt pas le réseau : cette version consulte uniquement les dossiers et les lecteurs de cet ordinateur.',
    },
  },
  trash: {
    name: 'Corbeille',
    icon: 'trash',
    message: {
      glyph: 'trash',
      title: 'Corbeille non disponible',
      text: "Evolve n'affiche pas encore le contenu de la Corbeille. Les éléments que vous y envoyez depuis l'explorateur se retrouvent dans la Corbeille de Windows, où vous pouvez les restaurer.",
    },
  },
});

/** Emplacements désignés par un simple nom (icônes du bureau, barre latérale). */
export const LOCATION_IDS = Object.freeze([...Object.keys(PAGES), ...PLACES.map((place) => place.id)]);

/** Message affiché dans un navigateur, où aucun dossier ne peut être lu. */
const PREVIEW_MESSAGE = Object.freeze({
  glyph: 'app-window',
  title: "L'accès à vos fichiers nécessite l'application Windows",
  text: "Cet aperçu dans un navigateur ne peut lire aucun dossier de l'ordinateur. Lancez l'application Evolve (.exe) pour parcourir vos vrais dossiers. Aucun fichier fictif n'est affiché ici.",
});

/** Messages d'erreur, selon le code renvoyé par le service. */
const ERRORS = Object.freeze({
  'access-denied': {
    glyph: 'lock',
    title: 'Accès refusé',
    text: "Windows n'autorise pas votre compte à ouvrir ce dossier. Evolve ne demande jamais de droits d'administrateur.",
  },
  'not-found': {
    glyph: 'question',
    title: 'Dossier introuvable',
    text: 'Ce dossier a peut-être été déplacé, renommé ou supprimé. Revenez en arrière, puis actualisez.',
  },
  'not-a-directory': {
    glyph: 'file',
    title: "Cet élément n'est pas un dossier",
    text: 'Il ne peut pas être parcouru comme un dossier. Revenez en arrière, puis actualisez.',
  },
  'outside-allowed': {
    glyph: 'warning-circle',
    title: 'Emplacement indisponible',
    text: "Ce dossier ne fait plus partie des emplacements qu'Evolve peut consulter : son lecteur a peut-être été retiré. Revenez à « Ce PC », puis actualisez.",
  },
  'leads-outside': {
    glyph: 'lock',
    title: 'Emplacement non autorisé',
    text: "Cet élément mène en dehors des dossiers et des lecteurs de cet ordinateur (vers un dossier réseau, par exemple). Evolve ne l'ouvre pas.",
  },
  'invalid-path': {
    glyph: 'warning-circle',
    title: 'Emplacement non pris en charge',
    text: "Evolve ne peut pas ouvrir cet élément : son nom ou son emplacement n'est pas pris en charge.",
  },
  unavailable: {
    glyph: 'warning-circle',
    title: 'Emplacement indisponible',
    text: "Le lecteur n'est pas prêt ou n'a pas pu être lu. Vérifiez qu'il est branché, puis actualisez.",
  },
  failed: {
    glyph: 'warning-circle',
    title: 'Lecture impossible',
    text: "Une erreur est survenue pendant la lecture de cet emplacement. Réessayez avec le bouton Actualiser.",
  },
});

/**
 * Dossier personnel absent (Bureau, Documents…) : le message le nomme, explique
 * pourquoi il peut manquer, et précise qu'Evolve ne l'a pas créé — un dossier
 * n'est créé qu'à la demande de l'utilisateur, un dossier absent le reste.
 */
function missingPlaceMessage(name) {
  return {
    glyph: 'folder-open',
    title: `Dossier « ${name} » introuvable`,
    text:
      `Windows n'indique aucun dossier « ${name} » sur cet ordinateur : il a peut-être été supprimé ou déplacé, ` +
      "ou il se trouve sur un lecteur débranché ou sur le réseau. Evolve ne crée jamais de dossier à votre place : rien n'a été modifié.",
  };
}

const pageLocation = (id) => ({ type: 'page', id });
const placeLocation = (id) => ({ type: 'place', id });
const folderLocation = (path, name) => ({ type: 'folder', path, name });

/** Dernier nom d'un chemin (« C:\Users\Léo » → « Léo »). */
function lastSegment(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Emplacement désigné par un nom (« pc », « documents »…) ou par un objet
 * `{ path, name }` (dossier). Tout autre valeur mène à l'accueil.
 */
export function toLocation(input) {
  if (typeof input === 'string') {
    if (Object.hasOwn(PAGES, input)) return pageLocation(input);
    if (PLACE_BY_ID.has(input)) return placeLocation(input);
  } else if (input && typeof input === 'object') {
    if (input.type === 'page' && Object.hasOwn(PAGES, input.id)) return pageLocation(input.id);
    if (input.type === 'place' && PLACE_BY_ID.has(input.id)) return placeLocation(input.id);
    if (typeof input.path === 'string' && input.path !== '') {
      return folderLocation(input.path, typeof input.name === 'string' && input.name ? input.name : lastSegment(input.path));
    }
  }
  return pageLocation('home');
}

/** Identité d'un emplacement (historique, comparaison). */
export function locationKey(location) {
  return location.type === 'folder' ? `folder:${location.path}` : `${location.type}:${location.id}`;
}

/** Nom affiché d'un lecteur : la lettre est la seule information certaine. */
export function driveName(drive) {
  if (!drive.letter) return 'Ordinateur';
  return drive.system ? `Disque local (${drive.letter}:)` : `Lecteur (${drive.letter}:)`;
}

/**
 * Éléments à afficher : sans les éléments masqués (sauf demande), et dont le
 * nom contient le texte recherché — casse et accents indifférents.
 */
export function visibleNodes(nodes, { filter = '', showHidden = false } = {}) {
  const needle = normalize(filter);
  return nodes.filter((node) => (showHidden || !node.hidden) && (needle === '' || normalize(node.name).includes(needle)));
}

const crumbOf = (location, label, icon) => ({ label, icon, location });
const pcCrumb = () => crumbOf(pageLocation('pc'), PAGES.pc.name, PAGES.pc.icon);

function placeNode(place, available) {
  return { id: `place:${place.id}`, kind: 'folder', name: place.name, icon: place.icon, size: null, modified: null, hidden: false, available, location: placeLocation(place.id) };
}

function driveNode(drive) {
  const name = driveName(drive);
  return {
    id: `drive:${drive.id}`,
    kind: 'drive',
    name,
    size: null,
    modified: null,
    hidden: false,
    totalBytes: drive.totalBytes,
    freeBytes: drive.freeBytes,
    location: folderLocation(drive.path, name),
  };
}

/** Élément d'un dossier, tel que le service le décrit, prêt à être affiché. */
function entryNode(entry) {
  // Un dossier personnel porte son nom habituel (« Bureau »), comme dans Windows.
  const place = entry.place ? PLACE_BY_ID.get(entry.place) : null;
  const name = place ? place.name : entry.name;
  const node = {
    id: entry.path,
    // Chemin réel : seuls les éléments lus dans un dossier en ont un (opérations sur les fichiers).
    path: entry.path,
    kind: entry.kind,
    name,
    ext: entry.kind === 'file' ? extensionOf(entry.name) : '',
    size: entry.kind === 'file' && typeof entry.size === 'number' ? entry.size : null,
    modified: typeof entry.modified === 'number' ? new Date(entry.modified) : null,
    hidden: entry.hidden === true,
  };
  if (place) {
    node.icon = place.icon;
    // Dossier personnel : il se parcourt, mais ne se renomme, ne se déplace et ne se supprime pas.
    node.place = entry.place;
  }
  // Un lien s'ouvre comme un dossier : le service vérifie où il mène réellement.
  if (entry.kind === 'folder' || entry.kind === 'link') node.location = folderLocation(entry.path, name);
  return node;
}

/** Page d'un message (information, erreur, aperçu) pour l'emplacement `location`. */
function messagePage(kind, location, message, extra = {}) {
  let title;
  let crumbs;
  let active;
  if (location.type === 'page') {
    const page = PAGES[location.id];
    title = page.name;
    crumbs = [crumbOf(location, page.name, page.icon)];
    active = location.id;
  } else if (location.type === 'place') {
    const place = PLACE_BY_ID.get(location.id);
    title = place.name;
    crumbs = [pcCrumb(), crumbOf(location, place.name, place.icon)];
    active = `place:${location.id}`;
  } else {
    title = location.name;
    crumbs = [pcCrumb(), crumbOf(location, location.name)];
    active = null;
  }
  return {
    key: locationKey(location),
    kind,
    title,
    crumbs,
    up: crumbs.length > 1 ? crumbs[crumbs.length - 2].location : null,
    active,
    sections: [],
    message,
    truncated: false,
    limit: null,
    ...extra,
  };
}

/**
 * Navigation de l'explorateur.
 *
 * `files` donne accès au service de fichiers :
 *   { available: boolean, places(): Promise<object>, list(path): Promise<object> }
 * `onChange` est appelée à chaque changement d'état (chargement, nouvelle page).
 */
export class Navigator {
  #files;
  #onChange;
  /** Emplacement courant (celui de la page affichée, ou en cours de chargement). */
  #current = null;
  #back = [];
  #forward = [];
  /** Numéro de la demande en cours : une réponse tardive est ignorée. */
  #ticket = 0;
  #loading = false;
  #page = null;
  /** Dossiers personnels et lecteurs connus (dernière réponse du service). */
  #known = null;

  constructor({ files, onChange = () => {} }) {
    this.#files = files;
    this.#onChange = onChange;
  }

  /** Page à afficher ; `null` avant la première réponse. */
  get page() {
    return this.#page;
  }

  /** Vrai tant qu'une lecture est en cours. */
  get loading() {
    return this.#loading;
  }

  get canGoBack() {
    return this.#back.length > 0;
  }

  get canGoForward() {
    return this.#forward.length > 0;
  }

  /** Lecteurs connus, sous forme d'éléments affichables (barre latérale). */
  get drives() {
    return (this.#known?.drives ?? []).map(driveNode);
  }

  /** Affiche un emplacement et l'inscrit dans l'historique. */
  open(input) {
    const target = this.#canonical(toLocation(input));
    if (this.#current && locationKey(target) !== locationKey(this.#current)) {
      this.#back.push(this.#current);
      this.#forward = [];
    }
    this.#current = target;
    // « Accueil » et « Ce PC » montrent les lecteurs : ils sont recherchés à nouveau.
    return this.#load({ probe: target.type === 'page' });
  }

  goBack() {
    const previous = this.#back.pop();
    if (!previous) return Promise.resolve();
    this.#forward.push(this.#current);
    this.#current = previous;
    return this.#load();
  }

  goForward() {
    const next = this.#forward.pop();
    if (!next) return Promise.resolve();
    this.#back.push(this.#current);
    this.#current = next;
    return this.#load();
  }

  /** Remonte d'un niveau dans le fil d'Ariane. */
  goUp() {
    const up = this.#page?.up;
    return up ? this.open(up) : Promise.resolve();
  }

  /** Relit l'emplacement courant (et recherche à nouveau les lecteurs). */
  refresh() {
    return this.#current ? this.#load({ probe: true }) : Promise.resolve();
  }

  /** Relit l'emplacement courant, sans rechercher à nouveau les lecteurs (après une opération sur les fichiers). */
  reload() {
    return this.#current ? this.#load() : Promise.resolve();
  }

  /** Un dossier personnel connu est désigné par son chemin réel. */
  #canonical(location) {
    if (location.type !== 'place') return location;
    const path = this.#known?.places.find((place) => place.id === location.id)?.path;
    return path ? folderLocation(path, PLACE_BY_ID.get(location.id).name) : location;
  }

  async #load({ probe = false } = {}) {
    this.#ticket += 1;
    const ticket = this.#ticket;
    this.#loading = true;
    this.#onChange();

    let location = this.#current;
    let page;
    try {
      if (!this.#files.available) {
        page = messagePage('preview', location, PREVIEW_MESSAGE);
      } else {
        if (probe || !this.#known) this.#known = await this.#files.places();
        if (ticket !== this.#ticket) return;
        location = this.#canonical(location);
        page = await this.#read(location);
      }
    } catch (error) {
      const code = typeof error?.code === 'string' && Object.hasOwn(ERRORS, error.code) ? error.code : 'failed';
      page = messagePage('error', location, ERRORS[code], { code, ...this.#contextOf(location) });
    }
    if (ticket !== this.#ticket) return;

    // Le dossier affiché est celui que le service a réellement lu (liens résolus).
    if (page.location) location = page.location;
    this.#current = location;
    this.#page = page;
    this.#loading = false;
    this.#onChange();
  }

  /**
   * Fil d'Ariane d'un dossier qui n'a pas pu être lu : celui de la page
   * affichée, si ce dossier en fait partie (double-clic, actualisation).
   */
  #contextOf(location) {
    const from = this.#page;
    if (location.type !== 'folder' || from?.kind !== 'folder') return {};
    if (from.key === locationKey(location)) return { crumbs: from.crumbs, up: from.up, active: from.active };
    const isChild = from.sections.some((section) => section.nodes.some((node) => node.location?.path === location.path));
    return isChild ? { crumbs: [...from.crumbs, crumbOf(location, location.name)], up: from.location, active: from.active } : {};
  }

  async #read(location) {
    if (location.type === 'page') return this.#virtualPage(location);
    if (location.type === 'place') {
      // Dossier personnel sans chemin connu : absent, ou hors de cet ordinateur. Rien n'est créé.
      return messagePage('error', location, missingPlaceMessage(PLACE_BY_ID.get(location.id).name), { code: 'place-unavailable' });
    }
    return this.#folderPage(await this.#files.list(location.path));
  }

  #virtualPage(location) {
    const page = PAGES[location.id];
    if (page.message) return messagePage('info', location, page.message);

    const available = new Map((this.#known?.places ?? []).map((place) => [place.id, place.available === true]));
    const places = PLACES.map((place) => placeNode(place, available.get(place.id) === true));
    const sections =
      location.id === 'home'
        ? [{ title: 'Accès rapide', layout: 'grid', nodes: places }]
        : [
            { title: 'Dossiers', layout: 'collection', nodes: places },
            { title: 'Périphériques et lecteurs', layout: 'drives', nodes: this.drives },
          ];
    return { ...messagePage(location.id, location, null), sections };
  }

  #folderPage(listing) {
    const { root } = listing;
    let rootCrumb;
    let active;
    if (root.kind === 'place' && PLACE_BY_ID.has(root.id)) {
      const place = PLACE_BY_ID.get(root.id);
      rootCrumb = crumbOf(folderLocation(root.path, place.name), place.name, place.icon);
      active = `place:${root.id}`;
    } else {
      const drive = this.#known?.drives.find((item) => item.id === root.id) ?? { letter: /^[A-Z]:$/.test(root.id) ? root.id[0] : null, system: false };
      const name = driveName(drive);
      rootCrumb = crumbOf(folderLocation(root.path, name), name, 'hard-drive');
      active = `drive:${root.id}`;
    }
    const crumbs = [pcCrumb(), rootCrumb, ...listing.trail.map((step) => crumbOf(folderLocation(step.path, step.name), step.name))];
    const title = crumbs[crumbs.length - 1].label;
    const location = folderLocation(listing.path, title);
    return {
      key: locationKey(location),
      kind: 'folder',
      title,
      crumbs,
      up: crumbs[crumbs.length - 2].location,
      active,
      sections: [{ title: null, layout: 'collection', nodes: listing.entries.map(entryNode) }],
      message: null,
      truncated: listing.truncated === true,
      limit: listing.limit ?? null,
      location,
    };
  }
}

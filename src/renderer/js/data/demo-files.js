/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  CONTENU D'EXEMPLE — DÉMONSTRATION UNIQUEMENT                        ║
 * ║  Arborescence fictive affichée par l'explorateur de fichiers.        ║
 * ║  Aucun accès au disque ni aux données de l'utilisateur.              ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Module pur (sans DOM) : il se teste directement avec Node.
 */

import { normalize } from '../core/text.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/** Types de fichiers reconnus : libellé, pictogramme et teinte de l'icône. */
export const FILE_TYPES = Object.freeze({
  docx: { label: 'Document', icon: 'file-doc', tone: 'blue' },
  xlsx: { label: 'Feuille de calcul', icon: 'file-xls', tone: 'green' },
  pptx: { label: 'Présentation', icon: 'file-ppt', tone: 'amber' },
  pdf: { label: 'Document PDF', icon: 'file-pdf', tone: 'red' },
  txt: { label: 'Document texte', icon: 'file-text', tone: 'violet' },
  md: { label: 'Document Markdown', icon: 'file-text', tone: 'violet' },
  png: { label: 'Image PNG', icon: 'file-image', tone: 'magenta' },
  jpg: { label: 'Image JPEG', icon: 'file-image', tone: 'magenta' },
  mp3: { label: 'Audio MP3', icon: 'file-audio', tone: 'magenta' },
  flac: { label: 'Audio FLAC', icon: 'file-audio', tone: 'magenta' },
  mp4: { label: 'Vidéo MP4', icon: 'file-video', tone: 'blue' },
  zip: { label: 'Archive ZIP', icon: 'file-zip', tone: 'amber' },
  exe: { label: 'Application', icon: 'app-window', tone: 'cyan' },
  html: { label: 'Page HTML', icon: 'file-code', tone: 'cyan' },
  css: { label: 'Feuille de style', icon: 'file-code', tone: 'cyan' },
  js: { label: 'Script JavaScript', icon: 'file-code', tone: 'cyan' },
});

const UNKNOWN_TYPE = Object.freeze({ label: 'Fichier', icon: 'file', tone: 'violet' });

/** Le fond d'écran officiel du projet, présenté dans « Images › Fonds d'écran ». */
export const WALLPAPER_FILE = Object.freeze({
  name: 'panorama-cosmique-violet-sur-lac-miroir.png',
  size: 2_398_788,
  dimensions: '1672 × 941',
});

// --- Constructeurs de la description de l'arborescence ----------------------

const dir = (name, children = [], extra = {}) => ({ kind: 'folder', name, children, ...extra });
const file = (name, size, age, extra = {}) => ({ kind: 'file', name, size, age, ...extra });
const drive = (name, letter, totalGb, freeGb, children = []) => ({
  kind: 'drive',
  name,
  letter,
  totalBytes: totalGb * GB,
  freeBytes: freeGb * GB,
  children,
});

/** Description de l'arborescence d'exemple (les âges sont relatifs à « maintenant »). */
function describeTree() {
  return [
    { kind: 'home', id: 'home', name: 'Accueil', icon: 'house', children: [] },
    {
      kind: 'pc',
      id: 'pc',
      name: 'Ce PC',
      icon: 'desktop',
      children: [
        dir(
          'Bureau',
          [
            dir('Projet Evolve', [
              dir('Maquettes', [
                file('Bureau.png', 1.8 * MB, 3 * DAY),
                file('Menu Démarrer.png', 1.2 * MB, 3 * DAY + 2 * HOUR),
                file('Fenêtres.png', 1.5 * MB, 4 * DAY),
              ]),
              file('Feuille de route.md', 6 * KB, 26 * HOUR),
              file('Idées.txt', 2 * KB, 5 * DAY),
            ]),
            file('Notes de réunion.txt', 3 * KB, 4 * HOUR),
            file("Capture d'écran.png", 842 * KB, 2 * DAY),
          ],
          { icon: 'desktop', place: 'desktop' },
        ),
        dir(
          'Documents',
          [
            dir('Projets', [
              dir('Evolve', [
                file('Cahier des charges.docx', 148 * KB, 2 * HOUR),
                file('Planning.xlsx', 62 * KB, 28 * HOUR),
                file('Présentation.pptx', 3.4 * MB, 3 * DAY),
              ]),
              dir('Site web', [
                file('index.html', 9 * KB, 9 * DAY),
                file('style.css', 14 * KB, 9 * DAY),
                file('script.js', 21 * KB, 8 * DAY),
              ]),
            ]),
            dir('Factures', [
              file('Facture 2026-09.pdf', 212 * KB, 41 * DAY),
              file('Facture 2026-10.pdf', 208 * KB, 11 * DAY),
            ]),
            dir('Administratif', [
              file('Attestation.pdf', 96 * KB, 63 * DAY),
              file('Contrat.pdf', 344 * KB, 120 * DAY),
            ]),
            file('Rapport annuel.docx', 284 * KB, 35 * MINUTE),
            file('Budget 2026.xlsx', 88 * KB, 20 * HOUR),
            file('Présentation Evolve.pptx', 5.2 * MB, 2 * DAY),
            file('Guide de démarrage.pdf', 1.1 * MB, 6 * DAY),
            file('Notes.txt', 1 * KB, 12 * DAY),
          ],
          { icon: 'file-text', place: 'documents' },
        ),
        dir(
          'Images',
          [
            dir("Fonds d'écran", [
              file(WALLPAPER_FILE.name, WALLPAPER_FILE.size, 50 * MINUTE, {
                thumbnail: 'wallpaper',
                dimensions: WALLPAPER_FILE.dimensions,
              }),
            ]),
            dir("Captures d'écran", [
              file('Capture 01.png', 1.3 * MB, 2 * DAY),
              file('Capture 02.png', 1.6 * MB, 2 * DAY + HOUR),
            ]),
            dir('Vacances', [
              file('Montagne.jpg', 4.1 * MB, 96 * DAY),
              file('Lac.jpg', 3.7 * MB, 96 * DAY),
              file('Coucher de soleil.jpg', 5.3 * MB, 95 * DAY),
            ]),
            file('Logo Evolve.png', 96 * KB, 7 * DAY),
          ],
          { icon: 'images', place: 'pictures' },
        ),
        dir(
          'Musique',
          [
            dir('Listes de lecture', []),
            file('Ambiance nocturne.mp3', 7.4 * MB, 18 * DAY),
            file('Horizon violet.flac', 31 * MB, 22 * DAY),
            file('Piano au clair de lune.mp3', 5.9 * MB, 40 * DAY),
          ],
          { icon: 'music-notes', place: 'music' },
        ),
        dir(
          'Téléchargements',
          [
            file('Evolve-0.1.0-portable.exe', 141 * MB, 90 * MINUTE),
            file('Documentation.pdf', 2.6 * MB, 5 * HOUR),
            file('Archive photos.zip', 156 * MB, 4 * DAY),
            file('Polices.zip', 3.2 * MB, 9 * DAY),
          ],
          { icon: 'download-simple', place: 'downloads' },
        ),
        dir(
          'Vidéos',
          [
            dir('Enregistrements', []),
            file("Présentation de l'interface.mp4", 248 * MB, 3 * DAY),
            file('Tutoriel.mp4', 96 * MB, 15 * DAY),
          ],
          { icon: 'film-strip', place: 'videos' },
        ),
        drive('Disque local (C:)', 'C', 476, 289, [
          dir('Programmes', [dir('Evolve', [file('Evolve.exe', 172 * MB, 90 * MINUTE)])]),
          dir('Utilisateurs', [dir('Utilisateur', [])]),
          dir('Windows', []),
        ]),
        drive('Données (D:)', 'D', 931, 612, [
          dir('Sauvegardes', [file('Sauvegarde 2026-10.zip', 2.4 * GB, 14 * DAY)]),
          dir('Archives', []),
        ]),
      ],
    },
    {
      kind: 'place',
      id: 'network',
      name: 'Réseau',
      icon: 'network',
      children: [],
      emptyTitle: 'Aucun appareil détecté',
      emptyText: 'La découverte du réseau sera disponible dans une prochaine étape.',
    },
    {
      kind: 'place',
      id: 'trash',
      name: 'Corbeille',
      icon: 'trash',
      children: [],
      emptyTitle: 'La corbeille est vide',
      emptyText: 'Les éléments supprimés apparaîtront ici.',
    },
  ];
}

/** Extension en minuscules d'un nom de fichier (sans le point). */
export function extensionOf(name) {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toLowerCase() : '';
}

/** Informations d'affichage d'un nœud : libellé de type, pictogramme, teinte. */
export function describeNode(node) {
  if (node.kind === 'file') return FILE_TYPES[node.ext] ?? UNKNOWN_TYPE;
  if (node.kind === 'drive') return { label: 'Disque local', icon: 'hard-drive', tone: 'violet' };
  if (node.kind === 'folder') return { label: 'Dossier de fichiers', icon: node.icon ?? 'folder', tone: 'violet' };
  return { label: 'Emplacement', icon: node.icon ?? 'folder', tone: 'violet' };
}

/** Vrai si le nœud peut être ouvert comme un dossier. */
export const isContainer = (node) => node.kind !== 'file';

/**
 * Trie des éléments : dossiers d'abord, puis selon la clé demandée.
 * @param {object[]} nodes
 * @param {'name'|'modified'|'type'|'size'} key
 * @param {1|-1} direction
 */
export function sortNodes(nodes, key = 'name', direction = 1) {
  const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
  const byName = (a, b) => collator.compare(a.name, b.name);
  const compare = {
    name: byName,
    modified: (a, b) => a.modified - b.modified || byName(a, b),
    type: (a, b) => collator.compare(describeNode(a).label, describeNode(b).label) || byName(a, b),
    size: (a, b) => (a.size ?? -1) - (b.size ?? -1) || byName(a, b),
  }[key] ?? byName;

  return [...nodes].sort((a, b) => {
    const containers = Number(isContainer(b)) - Number(isContainer(a));
    if (containers !== 0) return containers; // les dossiers restent toujours en premier
    return compare(a, b) * direction;
  });
}

/**
 * Construit l'arborescence d'exemple.
 * @param {Date} [now]  instant de référence (les dates des fichiers en découlent)
 */
export function createDemoFileSystem(now = new Date()) {
  const byId = new Map();
  const places = {};
  const nowMs = now.getTime();

  function build(spec, parent) {
    const node = { ...spec };
    node.parent = parent;
    node.id = spec.id ?? `${parent.id}/${spec.name}`;
    if (byId.has(node.id)) throw new Error(`Identifiant en double dans l'arborescence : ${node.id}`);
    byId.set(node.id, node);
    if (spec.place) places[spec.place] = node;

    if (node.kind === 'file') {
      node.ext = extensionOf(node.name);
      node.size = Math.round(spec.size);
      node.modified = new Date(nowMs - spec.age);
      delete node.age;
      return node;
    }

    node.children = (spec.children ?? []).map((child) => build(child, node));
    const latest = Math.max(0, ...node.children.map((child) => child.modified.getTime()));
    node.modified = new Date(latest || nowMs - 30 * DAY);
    return node;
  }

  const root = { id: '', name: '', kind: 'root', parent: null, children: [] };
  root.children = describeTree().map((spec) => build(spec, root));

  const get = (id) => byId.get(id);
  places.home = get('home');
  places.pc = get('pc');
  places.network = get('network');
  places.trash = get('trash');

  /** Chemin d'un nœud, de l'emplacement racine jusqu'à lui (pour le fil d'Ariane). */
  function pathTo(node) {
    const path = [];
    for (let current = node; current && current.kind !== 'root'; current = current.parent) path.unshift(current);
    return path;
  }

  /** Tous les fichiers de l'arborescence. */
  function allFiles() {
    return [...byId.values()].filter((node) => node.kind === 'file');
  }

  /** Fichiers les plus récemment modifiés. */
  function recents(limit = 8) {
    return allFiles()
      .sort((a, b) => b.modified - a.modified)
      .slice(0, limit);
  }

  /** Recherche par nom (insensible à la casse et aux accents). */
  function search(query, limit = 6) {
    const needle = normalize(query);
    if (!needle) return [];
    return [...byId.values()]
      .filter((node) => node.kind === 'file' || node.kind === 'folder')
      .filter((node) => normalize(node.name).includes(needle))
      .sort((a, b) => normalize(a.name).indexOf(needle) - normalize(b.name).indexOf(needle) || b.modified - a.modified)
      .slice(0, limit);
  }

  return { root, get, places, pathTo, allFiles, recents, search, isDemo: true };
}

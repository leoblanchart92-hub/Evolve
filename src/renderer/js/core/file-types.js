/**
 * Evolve — Types de fichiers : libellé, pictogramme et teinte d'un élément
 * (fichier, dossier, lecteur, lien), et tri d'une liste d'éléments.
 *
 * Module pur (sans DOM) : il se teste directement avec Node.
 */

/**
 * Familles de fichiers : [libellé, pictogramme, teinte, extensions].
 * Le libellé peut être une fonction de l'extension (« Image PNG »).
 */
const FAMILIES = [
  ['Document', 'file-doc', 'blue', ['docx', 'doc', 'odt', 'rtf']],
  ['Feuille de calcul', 'file-xls', 'green', ['xlsx', 'xls', 'ods']],
  ['Fichier CSV', 'file-xls', 'green', ['csv']],
  ['Présentation', 'file-ppt', 'amber', ['pptx', 'ppt', 'odp']],
  ['Document PDF', 'file-pdf', 'red', ['pdf']],
  ['Document texte', 'file-text', 'violet', ['txt']],
  ['Document Markdown', 'file-text', 'violet', ['md']],
  ['Fichier journal', 'file-text', 'violet', ['log']],
  ['Paramètres de configuration', 'file-text', 'violet', ['ini', 'cfg', 'conf']],
  [(ext) => `Image ${ext.toUpperCase()}`, 'file-image', 'magenta', ['png', 'gif', 'bmp', 'svg', 'tiff', 'heic', 'avif']],
  ['Image JPEG', 'file-image', 'magenta', ['jpg', 'jpeg']],
  ['Image WebP', 'file-image', 'magenta', ['webp']],
  ['Image TIFF', 'file-image', 'magenta', ['tif']],
  ['Icône', 'file-image', 'magenta', ['ico']],
  [(ext) => `Audio ${ext.toUpperCase()}`, 'file-audio', 'magenta', ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma', 'opus']],
  [(ext) => `Vidéo ${ext.toUpperCase()}`, 'file-video', 'blue', ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'm4v']],
  [(ext) => `Archive ${ext.toUpperCase()}`, 'file-zip', 'amber', ['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz', 'cab']],
  ['Image de disque', 'file-zip', 'amber', ['iso']],
  ['Application', 'app-window', 'cyan', ['exe']],
  ['Package Windows Installer', 'app-window', 'cyan', ['msi']],
  ["Extension de l'application", 'gear-six', 'violet', ['dll']],
  ['Fichier système', 'gear-six', 'violet', ['sys']],
  ['Raccourci', 'arrow-square-out', 'cyan', ['lnk']],
  ['Raccourci Internet', 'arrow-square-out', 'cyan', ['url']],
  ['Fichier de commandes Windows', 'terminal-window', 'cyan', ['bat', 'cmd']],
  ['Script Windows PowerShell', 'terminal-window', 'cyan', ['ps1']],
  ['Page HTML', 'file-code', 'cyan', ['html', 'htm']],
  ['Feuille de style', 'file-code', 'cyan', ['css']],
  ['Script JavaScript', 'file-code', 'cyan', ['js', 'mjs', 'cjs']],
  ['Script TypeScript', 'file-code', 'cyan', ['ts', 'tsx']],
  ['Script Python', 'file-code', 'cyan', ['py']],
  [(ext) => `Fichier ${ext.toUpperCase()}`, 'file-code', 'cyan', ['json', 'xml', 'yaml', 'yml', 'toml', 'sql']],
  ['Code source', 'file-code', 'cyan', ['c', 'cpp', 'h', 'cs', 'java', 'rs', 'go', 'php', 'sh']],
  ['Fichier de police', 'file', 'violet', ['ttf', 'otf', 'woff', 'woff2']],
  ['Fichier temporaire', 'file', 'violet', ['tmp']],
];

/** Types de fichiers reconnus, par extension : libellé, pictogramme et teinte de l'icône. */
export const FILE_TYPES = Object.freeze(
  Object.fromEntries(
    FAMILIES.flatMap(([label, icon, tone, extensions]) =>
      extensions.map((ext) => [ext, Object.freeze({ label: typeof label === 'function' ? label(ext) : label, icon, tone })]),
    ),
  ),
);

const UNKNOWN_TYPE = Object.freeze({ label: 'Fichier', icon: 'file', tone: 'violet' });

/** Extension en minuscules d'un nom de fichier (sans le point). */
export function extensionOf(name) {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toLowerCase() : '';
}

/** Informations d'affichage d'un élément : libellé de type, pictogramme, teinte. */
export function describeNode(node) {
  if (node.kind === 'file') return (Object.hasOwn(FILE_TYPES, node.ext) && FILE_TYPES[node.ext]) || UNKNOWN_TYPE;
  if (node.kind === 'drive') return { label: 'Disque local', icon: 'hard-drive', tone: 'violet' };
  if (node.kind === 'folder') return { label: 'Dossier de fichiers', icon: node.icon ?? 'folder', tone: 'violet' };
  if (node.kind === 'link') return { label: 'Lien', icon: 'link', tone: 'cyan' };
  if (node.kind === 'other') return { label: 'Élément système', icon: 'file', tone: 'violet' };
  return { label: 'Emplacement', icon: node.icon ?? 'folder', tone: 'violet' };
}

/** Vrai si l'élément se range avec les dossiers (les liens se rangent avec les fichiers). */
export const isContainer = (node) => node.kind !== 'file' && node.kind !== 'link' && node.kind !== 'other';

const timeOf = (node) => (node.modified ? Number(node.modified) : 0);

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
    modified: (a, b) => timeOf(a) - timeOf(b) || byName(a, b),
    type: (a, b) => collator.compare(describeNode(a).label, describeNode(b).label) || byName(a, b),
    size: (a, b) => (a.size ?? -1) - (b.size ?? -1) || byName(a, b),
  }[key] ?? byName;

  return [...nodes].sort((a, b) => {
    const containers = Number(isContainer(b)) - Number(isContainer(a));
    if (containers !== 0) return containers; // les dossiers restent toujours en premier
    return compare(a, b) * direction;
  });
}

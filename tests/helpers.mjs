/**
 * Evolve — Outils partagés par les tests.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Racine du projet. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Dossier de l'interface (page affichée par l'application). */
export const RENDERER = path.join(ROOT, 'src', 'renderer');

/** Chemin absolu d'un fichier du projet. */
export const fromRoot = (...parts) => path.join(ROOT, ...parts);

/** Lit un fichier texte du projet. */
export const readText = (...parts) => readFileSync(fromRoot(...parts), 'utf8');

/** Liste récursive des fichiers d'un dossier portant l'une des extensions données. */
export function listFiles(dir, extensions) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full, extensions));
    else if (extensions.includes(path.extname(entry.name))) found.push(full);
  }
  return found.sort();
}

/** Chemin relatif à la racine, avec des « / » (messages d'erreur lisibles). */
export const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');

/** Retire les commentaires d'un source JavaScript ou CSS (analyse simplifiée). */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Remplace les espaces insécables par des espaces simples (comparaisons de textes). */
export const plainSpaces = (text) => text.replace(/[\u00a0\u202f]/g, ' ');

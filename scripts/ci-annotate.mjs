#!/usr/bin/env node
/**
 * Evolve — Signale la cause d'un échec de la compilation automatique.
 *
 * Publie la fin du journal d'une étape sous forme d'annotation GitHub Actions :
 * la cause de l'échec apparaît ainsi directement sur la page de l'exécution,
 * sans avoir à ouvrir les journaux détaillés. Appelé par scripts/ci-run.sh.
 *
 * Utilisation :
 *   node scripts/ci-annotate.mjs JOURNAL [NOM_DE_L_ETAPE]
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Taille maximale du texte d'une annotation, et nombre maximal d'annotations. */
const CHUNK = 3000;
const MAX_CHUNKS = 4;

/** Échappe le texte d'une commande d'annotation GitHub Actions. */
export const escapeData = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** Échappe la valeur d'une propriété (titre) d'une commande d'annotation. */
export const escapeProperty = (text) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

/**
 * Commande d'annotation GitHub Actions.
 * @param {'error'|'warning'|'notice'} kind
 */
export const annotation = (kind, title, message) => `::${kind} title=${escapeProperty(title)}::${escapeData(message)}`;

/** Retire les séquences de couleur et les lignes vides répétées d'une sortie de terminal. */
export function cleanLog(text) {
  return String(text)
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Découpe la fin d'un journal en au plus `maxChunks` morceaux de `chunk`
 * caractères, coupés en fin de ligne et rendus dans l'ordre de lecture.
 * @returns {string[]}
 */
export function tailChunks(text, chunk = CHUNK, maxChunks = MAX_CHUNKS) {
  const lines = cleanLog(text).split('\n');
  const chunks = [];
  let current = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].length > chunk ? `${lines[i].slice(0, chunk - 1)}…` : lines[i];
    if (current.length && size + line.length + 1 > chunk) {
      chunks.unshift(current.join('\n'));
      current = [];
      size = 0;
      if (chunks.length === maxChunks) break;
    }
    current.unshift(line);
    size += line.length + 1;
  }
  if (current.length && chunks.length < maxChunks) chunks.unshift(current.join('\n'));
  return chunks.filter((item) => item.trim() !== '');
}

/**
 * Annotations d'erreur décrivant l'échec d'une étape.
 * @param {string} step nom de l'étape
 * @param {string} log  contenu de son journal
 * @returns {string[]} commandes à écrire sur la sortie standard
 */
export function failureAnnotations(step, log) {
  const chunks = tailChunks(log);
  if (chunks.length === 0) chunks.push("(la commande n'a rien affiché)");
  return chunks.map((chunk, index) => {
    const part = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : '';
    return annotation('error', `Échec : ${step}${part}`, chunk);
  });
}

function main([file, name]) {
  if (!file) {
    console.error('Utilisation : node scripts/ci-annotate.mjs JOURNAL [NOM_DE_L_ETAPE]');
    return 2;
  }
  const step = (name ?? path.basename(file, '.log')).replaceAll('-', ' ');
  let log;
  try {
    log = readFileSync(file, 'utf8');
  } catch (error) {
    log = `(journal illisible : ${error.message})`;
  }
  for (const line of failureAnnotations(step, log)) console.log(line);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

#!/usr/bin/env node
/**
 * Evolve — Signale la cause d'un échec de la compilation automatique.
 *
 * Publie la fin du journal d'une étape sous forme d'annotation GitHub Actions :
 * la cause de l'échec apparaît ainsi directement sur la page de l'exécution,
 * sans avoir à ouvrir les journaux détaillés. Appelé par scripts/ci-run.sh.
 *
 * Publie aussi, à la demande, le bilan d'une série de tests : combien ont
 * réussi sur la machine, et lesquels n'y ont pas été exécutés — certains
 * tests ne s'appliquent qu'à un système. La page de l'exécution dit ainsi ce
 * qui a réellement été vérifié sous Windows.
 *
 * Utilisation :
 *   node scripts/ci-annotate.mjs JOURNAL [NOM_DE_L_ETAPE]
 *   node scripts/ci-annotate.mjs --tests JOURNAL
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

/**
 * Bilan d'une série de tests de Node (`node --test --test-reporter=spec`), relevé
 * dans sa sortie : les totaux, et le nom des tests qui n'ont pas été exécutés.
 * @returns {{ tests: number, pass: number, fail: number, skipped: number, cancelled: number, todo: number,
 *            notRun: { name: string, reason: string }[] } | null}  `null` si la sortie ne comporte pas ce bilan
 */
export function testsOutcome(log) {
  const text = cleanLog(log);
  const totals = { cancelled: 0, todo: 0 };
  // Si plusieurs bilans se suivent, le dernier est celui de la série entière.
  for (const [, key, value] of text.matchAll(/^ℹ (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) totals[key] = Number(value);
  if (!['tests', 'pass', 'fail', 'skipped'].every((key) => key in totals)) return null;
  const notRun = [...text.matchAll(/^\s*﹣ (.+) \(\d+(?:\.\d+)?ms\)(?: # (.*))?$/gm)].map(([, name, reason]) => ({
    name,
    reason: !reason || reason === 'SKIP' ? '' : reason,
  }));
  return { ...totals, notRun };
}

/**
 * Notes décrivant une série de tests : ses totaux, puis le nom de chaque test non
 * exécuté sur cette machine, sous le motif que le test en donne. Une longue liste
 * est répartie sur plusieurs notes.
 * @param {string} log     sortie de la série de tests
 * @param {string} system  machine sur laquelle elle a eu lieu
 * @returns {string[]} commandes à écrire sur la sortie standard ; aucune si la sortie n'est pas celle de tests
 */
export function testsAnnotations(log, system = `${process.platform} ${process.arch}, Node.js ${process.versions.node}`) {
  const outcome = testsOutcome(log);
  if (!outcome) return [];
  const { tests, pass, fail, skipped, cancelled, todo, notRun } = outcome;
  const plural = (count, one, many) => `${count} ${count > 1 ? many : one}`;
  const counts = [
    plural(pass, 'réussi', 'réussis'),
    fail ? `${fail} en échec` : 'aucun échec',
    ...(cancelled ? [plural(cancelled, 'interrompu', 'interrompus')] : []),
    ...(todo ? [`${todo} à écrire`] : []),
    skipped ? plural(skipped, 'non exécuté', 'non exécutés') : 'tous exécutés',
  ];
  /** Paragraphes de la note : les totaux, puis un paragraphe par motif. */
  const blocks = [[`Sur cette machine (${system}) : ${plural(tests, 'test', 'tests')} — ${counts.join(', ')}.`]];
  if (skipped || notRun.length) {
    // Les noms relevés devraient être aussi nombreux que le total annoncé : tout écart est dit.
    blocks[0].push(notRun.length === skipped ? 'Non exécutés ici, et pourquoi :' : `Non exécutés ici (${notRun.length} relevés dans la sortie, pour ${skipped} annoncés) :`);
    /** @type {Map<string, string[]>} noms des tests, par motif, dans l'ordre de la sortie */
    const byReason = new Map();
    for (const { name, reason } of notRun) byReason.set(reason, [...(byReason.get(reason) ?? []), name]);
    for (const [reason, names] of byReason) {
      const title = `▸ ${reason || 'sans motif indiqué'}${names.length > 1 ? ` (${names.length} tests)` : ''} :`;
      blocks.push([title.slice(0, 400), ...names.map((name) => `  ﹣ ${name}`.slice(0, 300))]);
    }
  }

  // Répartition : des notes de taille limitée. Un paragraphe n'est coupé que s'il ne tient pas dans une note.
  const length = (lines) => lines.reduce((total, line) => total + line.length + 1, 0);
  const chunks = [[]];
  for (const block of blocks) {
    if (chunks.at(-1).length && length(block) <= CHUNK && length(chunks.at(-1)) + length(block) > CHUNK) chunks.push([]);
    for (const line of block) {
      if (chunks.at(-1).length && length(chunks.at(-1)) + line.length + 1 > CHUNK) chunks.push([]);
      chunks.at(-1).push(line);
    }
  }
  const kept = chunks.slice(0, MAX_CHUNKS);
  const dropped = chunks.slice(MAX_CHUNKS).reduce((total, chunk) => total + chunk.length, 0);
  if (dropped) kept.at(-1).push(`… et ${dropped} autres lignes.`);
  return kept.map((chunk, index) => annotation('notice', `Tests automatiques${kept.length > 1 ? ` (${index + 1}/${kept.length})` : ''}`, chunk.join('\n')));
}

const USAGE = 'Utilisation : node scripts/ci-annotate.mjs JOURNAL [NOM_DE_L_ETAPE]\n              node scripts/ci-annotate.mjs --tests JOURNAL';

function main(args) {
  const tests = args[0] === '--tests';
  const [file, name] = tests ? args.slice(1) : args;
  if (!file || file.startsWith('--')) {
    console.error(USAGE);
    return 2;
  }
  if (tests) {
    // Bilan d'une série de tests. Un journal absent, ou qui n'est pas celui de tests : rien à dire.
    let log = '';
    try {
      log = readFileSync(file, 'utf8');
    } catch {
      return 0;
    }
    for (const line of testsAnnotations(log)) console.log(line);
    return 0;
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

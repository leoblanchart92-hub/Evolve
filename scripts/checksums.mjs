#!/usr/bin/env node
/**
 * Evolve — Empreintes des fichiers publiés.
 *
 * Écrit un fichier « SHA256SUMS.txt » : une ligne par fichier, de la forme
 * « <empreinte>  <nom> », comme le produit `sha256sum`. Ce fichier est publié
 * avec chaque version : le service des mises à jour s'en sert pour vérifier
 * qu'un fichier téléchargé est bien celui qui a été publié, et refuse
 * l'installation dans le cas contraire.
 *
 * Utilisation :
 *   node scripts/checksums.mjs [--out=FICHIER] [FICHIER …]
 *
 * Sans argument : les fichiers publiés de la version en cours, dans dist/
 * (les trois exécutables et l'image .iso) ; ceux qui n'existent pas encore
 * sont simplement laissés de côté.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

/** Empreinte SHA-256 d'un fichier, lue par morceaux (les fichiers sont gros). */
export async function sha256File(file) {
  const hash = createHash('sha256');
  const stream = createReadStream(file, { highWaterMark: 1024 * 1024 });
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/** Ligne d'un fichier d'empreintes : « <empreinte>  <nom> ». */
export const checksumLine = (hash, name) => `${hash}  ${name}`;

/**
 * Lit un fichier d'empreintes.
 * @param {string} text
 * @returns {Map<string, string>} nom de fichier → empreinte
 */
export function parseChecksums(text) {
  const found = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})[ \t]+\*?(.+)$/i.exec(line.trim());
    if (!match) continue;
    found.set(match[2].trim().replace(/^.*[\\/]/, ''), match[1].toLowerCase());
  }
  return found;
}

/** Fichiers publiés par défaut. */
export function defaultFiles() {
  const version = pkg.version;
  return [
    `Evolve-${version}-portable.exe`,
    `Evolve-${version}-setup.exe`,
    `Evolve-${version}-setup-tous-utilisateurs.exe`,
    `Evolve-${version}.iso`,
  ].map((name) => path.join(root, 'dist', name));
}

export async function main(argv) {
  const outOption = argv.find((arg) => arg.startsWith('--out='));
  const requested = argv.filter((arg) => !arg.startsWith('--'));
  const files = requested.length ? requested.map((file) => path.resolve(file)) : defaultFiles();
  const out = path.resolve(outOption ? outOption.slice('--out='.length) : path.join(root, 'dist', 'SHA256SUMS.txt'));

  const lines = [];
  for (const file of files) {
    try {
      const stats = await stat(file);
      if (!stats.isFile()) throw new Error("n'est pas un fichier");
      lines.push(checksumLine(await sha256File(file), path.basename(file)));
    } catch (error) {
      // Un fichier publié peut manquer : au premier passage, l'image .iso n'existe
      // pas encore, et les exécutables ne sont pas tous encore fabriqués. Seul un
      // fichier explicitement demandé est signalé, pour ne pas bruiter la compilation.
      if (requested.length) console.warn(`! ${path.relative(root, file)} : ignoré (${error?.message ?? error})`);
    }
  }
  if (!lines.length) {
    console.error('✖ aucun fichier à mesurer');
    return 1;
  }

  await writeFile(out, `${lines.join('\n')}\n`, 'utf8');
  console.log(`✔ ${path.relative(root, out)} : ${lines.length} fichier(s)`);
  for (const line of lines) console.log(`  ${line}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`✖ ${error?.message ?? error}`);
      process.exit(1);
    },
  );
}

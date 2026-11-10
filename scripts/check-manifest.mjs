#!/usr/bin/env node
/**
 * Evolve — Vérifie qu'un exécutable Windows ne demande aucun droit administrateur.
 *
 * Windows décide d'afficher (ou non) la demande d'élévation d'après le
 * « manifeste » incorporé au fichier .exe : niveau `asInvoker` (droits de
 * l'utilisateur, aucune demande), `highestAvailable` ou `requireAdministrator`.
 * Ce script lit ce niveau dans chaque fichier indiqué et échoue si l'un d'eux
 * demande autre chose que `asInvoker`.
 *
 * Utilisation :
 *   node scripts/check-manifest.mjs [FICHIER.exe …]
 *
 * Par défaut : l'exécutable portable et l'application qu'il contient
 * (dist/Evolve-<version>-portable.exe et dist/win-unpacked/Evolve.exe).
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { annotation } from './ci-annotate.mjs';

const MARKER = 'requestedExecutionLevel';
const LEVEL = /^requestedExecutionLevel\s+level\s*=\s*["']([A-Za-z]+)["']/;

/**
 * Niveaux d'exécution demandés par les manifestes présents dans `bytes`
 * (texte en UTF-8 ou en UTF-16, selon l'outil qui a produit l'exécutable).
 * @param {Buffer} bytes
 * @returns {string[]}
 */
export function executionLevels(bytes) {
  const levels = [];
  for (const encoding of ['latin1', 'utf16le']) {
    const marker = Buffer.from(MARKER, encoding);
    const width = marker.length / MARKER.length;
    let index = bytes.indexOf(marker);
    while (index !== -1) {
      const text = bytes.subarray(index, index + 160 * width).toString(encoding);
      const match = text.match(LEVEL);
      if (match) levels.push(match[1]);
      index = bytes.indexOf(marker, index + marker.length);
    }
  }
  return levels;
}

/**
 * @param {string[]} levels
 * @returns {'ok'|'elevation'|'unknown'}
 */
export function verdict(levels) {
  if (levels.length === 0) return 'unknown';
  return levels.every((level) => level === 'asInvoker') ? 'ok' : 'elevation';
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = argv.length
    ? argv.map((file) => path.resolve(file))
    : [path.join(root, 'dist', `Evolve-${pkg.version}-portable.exe`), path.join(root, 'dist', 'win-unpacked', 'Evolve.exe')];

  let failed = false;
  const rows = [];
  /** Résumé d'une ligne par fichier, publié en annotation sur GitHub Actions. */
  const notes = [];
  for (const file of files) {
    const name = path.relative(root, file) || file;
    if (!existsSync(file)) {
      console.error(`✖ ${name} : fichier introuvable`);
      rows.push(`| \`${name}\` | ❌ introuvable |`);
      notes.push(`✖ ${name} : fichier introuvable`);
      failed = true;
      continue;
    }
    const levels = executionLevels(readFileSync(file));
    const result = verdict(levels);
    if (result === 'ok') {
      console.log(`✔ ${name} : niveau « asInvoker » (aucun droit administrateur demandé)`);
      rows.push(`| \`${name}\` | ✅ \`asInvoker\` — aucun droit administrateur demandé |`);
      notes.push(`✔ ${name} : asInvoker (aucun droit administrateur demandé)`);
    } else if (result === 'elevation') {
      console.error(`✖ ${name} : demande une élévation de droits (${[...new Set(levels)].join(', ')})`);
      rows.push(`| \`${name}\` | ❌ \`${[...new Set(levels)].join(', ')}\` |`);
      notes.push(`✖ ${name} : élévation demandée (${[...new Set(levels)].join(', ')})`);
      failed = true;
    } else {
      // Niveau illisible (manifeste absent ou compressé) : rien n'indique une
      // demande d'élévation, mais rien ne l'exclut non plus. On le signale
      // sans faire échouer la compilation.
      console.warn(`! ${name} : aucun niveau d'exécution lisible dans le fichier`);
      rows.push(`| \`${name}\` | ⚠️ niveau d'exécution non lisible |`);
      notes.push(`! ${name} : niveau d'exécution non lisible`);
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        ['### 🔒 Droits demandés à Windows', '', '| Fichier | Niveau d\'exécution |', '| --- | --- |', ...rows, '', ''].join('\n'),
      );
    } catch {
      /* le résumé est facultatif */
    }
  }
  if (process.env.GITHUB_ACTIONS === 'true') {
    const kind = failed ? 'error' : notes.some((note) => note.startsWith('!')) ? 'warning' : 'notice';
    console.log(annotation(kind, 'Droits demandés à Windows', notes.join('\n')));
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

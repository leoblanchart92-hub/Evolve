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
 *   node scripts/check-manifest.mjs [FICHIER.exe[=admin] …]
 *
 * Le suffixe « =admin » marque un fichier pour lequel une élévation est
 * attendue : c'est le cas de l'installateur pour tous les utilisateurs, qui
 * écrit dans « Program Files ». Tout autre fichier demandant l'élévation fait
 * échouer la vérification.
 *
 * Par défaut : l'exécutable portable, l'application qu'il contient et les deux
 * installateurs (dist/Evolve-<version>-portable.exe, dist/win-unpacked/Evolve.exe,
 * dist/Evolve-<version>-setup.exe et dist/Evolve-<version>-setup-tous-utilisateurs.exe=admin).
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
  /** Fichiers vérifiés par défaut : le dernier demande l'élévation, c'est attendu. */
  const DEFAULT_TARGETS = [
    `dist/Evolve-${pkg.version}-portable.exe`,
    'dist/win-unpacked/Evolve.exe',
    `dist/Evolve-${pkg.version}-setup.exe`,
    `dist/Evolve-${pkg.version}-setup-tous-utilisateurs.exe=admin`,
  ];

  /** @type {{ file: string, expectsAdmin: boolean }[]} */
  const targets = (argv.length ? argv : DEFAULT_TARGETS).map((entry) => {
    const mark = entry.endsWith('=admin');
    return { file: path.resolve(mark ? entry.slice(0, -'=admin'.length) : entry), expectsAdmin: mark };
  });

  let failed = false;
  const rows = [];
  /** Résumé d'une ligne par fichier, publié en annotation sur GitHub Actions. */
  const notes = [];
  for (const { file, expectsAdmin } of targets) {
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
      if (expectsAdmin) {
        // Attendu : cet installateur écrit dans « Program Files ».
        console.log(`✔ ${name} : élévation demandée (${[...new Set(levels)].join(', ')}), comme prévu`);
        rows.push(`| \`${name}\` | ✅ \`${[...new Set(levels)].join(', ')}\` — droits d'administrateur demandés, comme prévu |`);
        notes.push(`✔ ${name} : élévation demandée, comme prévu (${[...new Set(levels)].join(', ')})`);
      } else {
        console.error(`✖ ${name} : demande une élévation de droits (${[...new Set(levels)].join(', ')})`);
        rows.push(`| \`${name}\` | ❌ \`${[...new Set(levels)].join(', ')}\` |`);
        notes.push(`✖ ${name} : élévation demandée (${[...new Set(levels)].join(', ')})`);
        failed = true;
      }
    } else if (result === 'ok' && expectsAdmin) {
      console.warn(`! ${name} : niveau « asInvoker » alors qu'une élévation était attendue`);
      rows.push(`| \`${name}\` | ⚠️ \`asInvoker\` — aucune élévation demandée |`);
      notes.push(`! ${name} : aucune élévation demandée alors qu'elle était attendue`);
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

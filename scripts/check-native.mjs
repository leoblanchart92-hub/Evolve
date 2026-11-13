#!/usr/bin/env node
/**
 * Evolve — Vérifie, sur cette machine, que renommer ou déplacer ne remplace jamais rien.
 *
 * Evolve confie chaque renommage et chaque déplacement à un module natif
 * (native/evolve_fs.c, chargé par src/main/atomic-move.js) : il demande au
 * système de ne déplacer un élément que si le nom d'arrivée est libre, d'un
 * seul geste. Ce script éprouve ce module sur un vrai disque, dans un dossier
 * d'essai qu'il crée dans le dossier temporaire puis retire. La vérification
 * elle-même est celle de src/main/selftest-no-replace.js — nom libre, nom
 * déjà pris, casse, déplacements simultanés, autre lecteur — que
 * l'application mène aussi sur elle-même pendant son auto-test.
 *
 * Sous Windows, le script lit aussi dans le module la liste des bibliothèques
 * que Windows doit charger avec lui : aucune ne doit manquer sur un Windows
 * fraîchement installé, puisque l'exécutable est portable.
 *
 * Refuser de remplacer est l'affaire du système de fichiers : le compte rendu
 * cite donc celui de chaque lecteur éprouvé (« NTFS »…), tel que le système
 * l'annonce. La vérification ne vaut que pour ceux-là.
 *
 * Utilisation :
 *   node scripts/check-native.mjs [--module=FICHIER] [--record=FICHIER] [--expect=FICHIER] [--rounds=N] [--other-volume=DOSSIER]
 *
 *   --module=FICHIER        module à vérifier (par défaut : native/build/Release/evolve_fs.node,
 *                           produit par « npm run build:native »)
 *   --record=FICHIER        après une vérification réussie, inscrit dans ce fichier l'empreinte
 *                           SHA-256 du module vérifié
 *   --expect=FICHIER        exige que le module vérifié ait l'empreinte inscrite dans ce fichier :
 *                           le module embarqué dans l'exécutable doit être, octet pour octet, celui
 *                           qui a été compilé puis éprouvé avant les tests
 *   --rounds=N              nombre de courses de chaque sorte (par défaut : 40)
 *   --other-volume=DOSSIER  dossier situé sur un autre lecteur, où un dossier d'essai est créé
 *                           puis retiré (par défaut : recherché parmi quelques dossiers usuels)
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { annotation } from './ci-annotate.mjs';

const require = createRequire(import.meta.url);
const { loadAtomicMove, ADDON_FILE } = require('../src/main/atomic-move.js');
const { verifyNoReplace, describeFacts, DEFAULT_ROUNDS } = require('../src/main/selftest-no-replace.js');

/** Titre des annotations publiées sur la page de l'exécution GitHub Actions. */
const TITLE = 'Déplacement sans remplacement';
/** Titre employé quand une empreinte est exigée du module vérifié : celui qui est embarqué dans l'exécutable. */
const EMBEDDED_TITLE = `${TITLE} — module embarqué dans l'exécutable`;

/** Empreinte SHA-256 d'un fichier. */
export const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Bibliothèques qui ne font pas partie de Windows : elles n'y sont présentes
 * que si un autre programme les a installées (« Visual C++ Redistributable »).
 * Un module qui en dépendrait ne se chargerait pas sur un Windows neuf.
 */
export const NOT_IN_WINDOWS = /^(?:vcruntime|msvcp|msvcr|concrt|vccorlib|vcomp)\d/i;

/**
 * Bibliothèques qu'un module Windows (format PE) fait charger avec lui.
 * @param {string} file
 * @returns {{ required: string[], delayed: string[] } | null} bibliothèques chargées d'emblée, et
 *          celles qui ne le sont qu'au premier usage ; `null` si le fichier n'est pas à ce format
 */
export function importedLibraries(file) {
  const data = fs.readFileSync(file);
  // En-tête « MZ », puis en-tête « PE » à l'adresse inscrite en 0x3C.
  if (data.length < 0x40 || data.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = data.readUInt32LE(0x3c);
  if (pe + 24 > data.length || data.readUInt32LE(pe) !== 0x00004550) return null;
  const sectionCount = data.readUInt16LE(pe + 6);
  const optional = pe + 24;
  const sections = optional + data.readUInt16LE(pe + 20);
  const magic = data.readUInt16LE(optional);
  // Table des répertoires : sa place dépend du format (64 bits : 0x20B, 32 bits : 0x10B).
  const directories = magic === 0x20b ? optional + 112 : magic === 0x10b ? optional + 96 : null;
  if (directories === null || sections + sectionCount * 40 > data.length) return null;
  const directoryCount = data.readUInt32LE(directories - 4);

  /** Place dans le fichier d'une adresse relative au module chargé, ou `null`. */
  const offsetOf = (address) => {
    for (let index = 0; index < sectionCount; index += 1) {
      const header = sections + index * 40;
      const start = data.readUInt32LE(header + 12);
      const size = Math.max(data.readUInt32LE(header + 8), data.readUInt32LE(header + 16));
      if (address >= start && address < start + size) return address - start + data.readUInt32LE(header + 20);
    }
    return null;
  };
  const textAt = (address) => {
    const start = offsetOf(address);
    if (start === null || start >= data.length) return null;
    const end = data.indexOf(0, start);
    return data.toString('latin1', start, end < 0 ? data.length : end);
  };
  /** Noms inscrits dans un répertoire d'importation : `size` octets par bibliothèque, nom à l'octet `nameAt`. */
  const namesIn = (directory, size, nameAt) => {
    if (directory >= directoryCount) return [];
    const address = data.readUInt32LE(directories + directory * 8);
    const found = [];
    for (let at = address ? offsetOf(address) : null; at !== null && at + size <= data.length; at += size) {
      const name = data.readUInt32LE(at + nameAt);
      if (name === 0) break; // fin de la liste
      found.push(textAt(name) ?? '?');
    }
    return found;
  };
  return { required: namesIn(1, 20, 12), delayed: namesIn(13, 32, 4) };
}

/** Demande à Windows le système de fichiers de chaque lecteur cité dans EVOLVE_VOLUMES (« C:\|D:\ »). */
const VOLUMES_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "foreach ($root in ($env:EVOLVE_VOLUMES -split '\\|')) {",
  "  try { 'EVOLVE:' + $root + '=' + [System.IO.DriveInfo]::new($root).DriveFormat } catch { }",
  '}',
].join('\r\n');

/**
 * Système de fichiers des lecteurs qui contiennent ces dossiers, tel que le
 * système l'annonce : « NTFS », « exFAT »… sous Windows (demandé à Windows par
 * PowerShell) ; « ext2/ext3 », « tmpfs »… sous Linux (demandé à « stat »).
 * @param {string[]} folders  dossiers existants, désignés par leur chemin complet
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {typeof spawnSync} [options.run]  lancement d'un programme
 * @returns {{ place: string, fileSystem: string|null }[]} un lecteur par dossier — sous Windows, sa
 *          racine (« C:\ ») —, sans répétition ; `fileSystem` vaut `null` si le système n'a pas répondu
 */
export function fileSystems(folders, { platform = process.platform, run = spawnSync } = {}) {
  const isWindows = platform === 'win32';
  const places = [...new Set(folders.map((folder) => (isWindows ? path.win32.parse(folder).root.toUpperCase() : folder)))];
  /** @type {Map<string, string>} */
  const names = new Map();
  try {
    if (isWindows) {
      // Seules des racines « X:\ » sont transmises, et par une variable d'environnement : rien n'est interprété.
      const roots = places.filter((place) => /^[A-Z]:\\$/.test(place));
      const result = roots.length
        ? run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(VOLUMES_SCRIPT, 'utf16le').toString('base64')], {
            env: { ...process.env, EVOLVE_VOLUMES: roots.join('|') },
            encoding: 'utf8',
            timeout: 60_000,
            windowsHide: true,
          })
        : null;
      for (const line of String(result?.stdout ?? '').split(/\r?\n/)) {
        const [, root, name] = /^EVOLVE:([A-Z]:\\)=([A-Za-z0-9]{2,16})$/.exec(line.trim()) ?? [];
        if (root && roots.includes(root)) names.set(root, name);
      }
    } else {
      for (const place of places) {
        const result = run('stat', ['-f', '-c', '%T', '--', place], { encoding: 'utf8', timeout: 20_000 });
        const name = String(result?.stdout ?? '').trim();
        if (result?.status === 0 && /^[\w./+-]{2,30}$/.test(name)) names.set(place, name);
      }
    }
  } catch {
    /* sans réponse : les systèmes de fichiers ne sont pas relevés */
  }
  return places.map((place) => ({ place, fileSystem: names.get(place) ?? null }));
}

/** Ligne du compte rendu citant les lecteurs éprouvés ; elle commence par « ! » si l'un d'eux n'a pas pu être identifié. */
export function describeVolumes(volumes) {
  const unknown = volumes.some(({ fileSystem }) => !fileSystem);
  return `${unknown ? '! ' : ''}Lecteurs éprouvés : ${volumes.map(({ place, fileSystem }) => `${place} (${fileSystem ?? 'système de fichiers non relevé'})`).join(' ; ')}`;
}

/**
 * Dossier situé sur un autre lecteur que `base`, parmi `candidates`, ou
 * `null`. Deux dossiers sont sur le même lecteur si le système leur attribue
 * le même numéro de volume.
 * @param {string} base
 * @param {(string|undefined|null)[]} [candidates]
 * @returns {string|null}
 */
export function findOtherVolume(base, candidates = [process.env.RUNNER_TEMP, os.homedir(), process.cwd(), '/dev/shm']) {
  let volume;
  try {
    volume = fs.statSync(base).dev;
  } catch {
    return null;
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    try {
      const info = fs.statSync(candidate);
      if (!info.isDirectory() || info.dev === volume) continue;
      fs.accessSync(candidate, fs.constants.W_OK);
      return candidate;
    } catch {
      /* dossier absent ou inaccessible : candidat suivant */
    }
  }
  return null;
}

/** Options de la ligne de commande. */
export function parseOptions(argv) {
  const options = { module: null, record: null, expect: null, rounds: DEFAULT_ROUNDS, otherVolume: null };
  for (const arg of argv) {
    const [, name, value] = arg.match(/^--([a-z-]+)=(.*)$/) ?? [];
    if (name === 'module' && value) options.module = value;
    else if (name === 'record' && value) options.record = value;
    else if (name === 'expect' && value) options.expect = value;
    else if (name === 'other-volume' && value) options.otherVolume = value;
    else if (name === 'rounds' && /^\d{1,4}$/.test(value) && Number(value) >= 1) options.rounds = Number(value);
    else throw new Error(`Option inconnue ou invalide : ${arg}`);
  }
  return options;
}

/**
 * Vérifie le module et rend compte.
 * @param {string[]} argv  options de la ligne de commande
 * @returns {Promise<number>} code de sortie : 0 = rien n'est jamais remplacé, 1 = échec
 */
export async function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const shown = (file) => {
    const relative = path.relative(root, file);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
  };
  const onGitHub = process.env.GITHUB_ACTIONS === 'true';
  /** Titre du compte rendu : fixé dès que les options sont lues. */
  let title = TITLE;
  const summarize = (markdown) => {
    if (!process.env.GITHUB_STEP_SUMMARY) return;
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    } catch {
      /* le résumé est facultatif */
    }
  };
  const fail = (lines) => {
    for (const line of lines) console.error(line);
    console.error("\n✖ Déplacement sans remplacement non garanti : l'exécutable ne doit pas être distribué.");
    if (onGitHub) console.log(annotation('error', title, lines.join('\n').slice(0, 3500)));
    summarize(`### ❌ ${title} : échec\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
    return 1;
  };

  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    return fail([`✖ ${error.message}`]);
  }
  if (options.expect) title = EMBEDDED_TITLE;

  // Le module : présent, et — si demandé — identique à celui qui a été compilé et éprouvé.
  const file = path.resolve(options.module ?? ADDON_FILE);
  if (!fs.existsSync(file)) return fail([`✖ Module natif introuvable : ${shown(file)}`, 'Compilez-le avec « npm run build:native ».']);
  const fingerprint = sha256(file);
  const header = [`Module : ${shown(file)} (${fs.statSync(file).size} octets, SHA-256 ${fingerprint})`, `Système : ${process.platform} ${process.arch}, Node.js ${process.versions.node}`];
  if (options.expect) {
    const record = path.resolve(options.expect);
    let expected;
    try {
      expected = fs.readFileSync(record, 'utf8').match(/^[0-9a-f]{64}\b/)?.[0] ?? null;
    } catch {
      expected = null;
    }
    if (!expected) return fail([...header, `✖ Empreinte de référence introuvable ou illisible : ${shown(record)}`]);
    if (expected !== fingerprint) return fail([...header, `✖ Ce module n'est pas celui qui a été compilé puis éprouvé (SHA-256 ${expected}, inscrite dans ${shown(record)}).`]);
    header.push(`✔ même empreinte que le module compilé puis éprouvé avant les tests (${shown(record)})`);
  }

  // Sous Windows : ce que le module fait charger avec lui. Rien qui puisse manquer sur un Windows neuf.
  const libraries = importedLibraries(file);
  if (libraries) {
    const missing = libraries.required.filter((name) => NOT_IN_WINDOWS.test(name));
    const listed = `Bibliothèques requises : ${libraries.required.join(', ') || 'aucune'}${libraries.delayed.length ? ` ; au premier usage : ${libraries.delayed.join(', ')} (le programme qui charge le module)` : ''}`;
    if (missing.length) return fail([...header, listed, `✖ Le module dépend de ${missing.join(', ')}, absent d'un Windows fraîchement installé : l'exécutable ne serait plus portable.`]);
    header.push(`✔ ${listed}`);
  }

  let move;
  try {
    move = loadAtomicMove({ file });
  } catch (error) {
    return fail([...header, `✖ ${error.message}`]);
  }

  // Dossiers d'essai : l'un dans le dossier temporaire, l'autre — s'il existe — sur un autre lecteur.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-natif-')));
  let elsewhere = null;
  let result;
  try {
    const volume = options.otherVolume ? path.resolve(options.otherVolume) : findOtherVolume(base);
    if (volume) elsewhere = fs.realpathSync.native(fs.mkdtempSync(path.join(volume, 'evolve-natif-')));
    // Les lecteurs sur lesquels la vérification a lieu, et leur système de fichiers : c'est lui qui refuse.
    header.push(describeVolumes(fileSystems([base, ...(elsewhere ? [elsewhere] : [])].map((folder) => path.dirname(folder)))));
    result = await verifyNoReplace(move, { base, rounds: options.rounds, otherVolume: elsewhere });
  } catch (error) {
    return fail([...header, `✖ Vérification impossible : ${error?.message ?? error}`]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    if (elsewhere) fs.rmSync(elsewhere, { recursive: true, force: true });
  }

  if (!result.ok) return fail([...header, ...result.problems.map((message) => `✖ ${message}`)]);
  const lines = [...header, ...describeFacts(result.facts)];
  if (!result.facts.crossVolume) lines.push("! d'un lecteur à l'autre : non vérifié (un seul lecteur disponible sur cette machine)");
  if (options.record) {
    // L'empreinte du module éprouvé : celle que devra avoir le module embarqué dans l'exécutable.
    const record = path.resolve(options.record);
    try {
      fs.mkdirSync(path.dirname(record), { recursive: true });
      fs.writeFileSync(record, `${fingerprint}  ${path.basename(file)}\n`);
    } catch (error) {
      return fail([...lines, `✖ Empreinte impossible à inscrire dans ${shown(record)} : ${error?.message ?? error}`]);
    }
    lines.push(`✔ empreinte inscrite dans ${shown(record)}`);
  }
  for (const line of lines) console.log(line);
  console.log('\n✔ Renommer ou déplacer ne remplace jamais rien sur cette machine, même en cas de concurrence.');
  if (onGitHub) console.log(annotation(lines.some((line) => line.startsWith('!')) ? 'warning' : 'notice', title, lines.join('\n').slice(0, 3500)));
  summarize(`### 🔒 ${title}\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}

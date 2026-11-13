#!/usr/bin/env node
/**
 * Evolve — Vérification : un dossier Documents absent n'est jamais recréé.
 *
 * Evolve ne crée rien de lui-même : un dossier n'apparaît que si
 * l'utilisateur le demande (« Nouveau dossier »). Parcourir l'ordinateur ne
 * doit donc rien créer, pas même le dossier Documents quand celui-ci n'existe
 * pas. Cette vérification place l'application dans cette situation, sur une
 * vraie machine :
 *
 *   1. le dossier Documents du compte est mis de côté — renommé, sans que son
 *      contenu soit touché : pour Windows, il n'existe plus ;
 *   2. l'application est lancée ; elle ouvre son explorateur puis le dossier
 *      Documents par les gestes d'un utilisateur (scénario « documents-missing »
 *      de l'auto-test, voir src/main/selftest-documents.js) : un message doit
 *      l'annoncer comme introuvable, et la navigation doit continuer ;
 *   3. ce script constate lui-même, sur le disque, que le dossier est
 *      toujours absent, que rien d'autre n'est apparu à côté de lui et que
 *      son contenu, mis de côté, est intact ;
 *   4. le dossier est remis en place, quoi qu'il arrive.
 *
 * Parce qu'elle déplace un instant le dossier Documents du compte, cette
 * vérification est réservée à la machine de compilation (GitHub Actions, sous
 * Windows) : partout ailleurs, elle refuse de s'exécuter. L'option --folder
 * permet d'éprouver le script lui-même sur un dossier d'essai.
 *
 * Utilisation :
 *   node scripts/check-documents.mjs [EXÉCUTABLE] [options] [-- ARGUMENTS…]
 *
 *   EXÉCUTABLE          comme scripts/check-exe.mjs (par défaut : le .exe de
 *                       dist/ ; « electron » : version de développement)
 *   --out=DOSSIER       résultats (par défaut : self-test-output/documents-absent/)
 *   --folder=DOSSIER    dossier à mettre de côté à la place du dossier
 *                       Documents du compte (essais de ce script)
 *   --timeout=SECONDES  durée maximale du lancement
 *   --idle=SECONDES     attente, dossier mis de côté, avant le lancement
 *                       (par défaut : 5) : la machine ne doit pas recréer
 *                       le dossier d'elle-même
 *   ARGUMENTS           transmis à l'application (sauf --self-test et
 *                       --self-test-scenario, que ce script fixe lui-même)
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { annotation } from './ci-annotate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
// Ce que l'application doit avoir contrôlé : mêmes définitions qu'elle.
const { SCENARIO, CHECKS } = require('../src/main/selftest-documents.js');

/** Suffixe du dossier mis de côté : son nom dit d'où il vient s'il devait rester en place. */
const ASIDE_SUFFIX = '.mis-de-cote-par-la-verification-evolve';
/** Suffixe d'un dossier recréé pendant la vérification, conservé comme pièce à examiner. */
const RECREATED_SUFFIX = '.recree-pendant-la-verification-evolve';
/** Attente par défaut, dossier mis de côté, avant le lancement : la machine ne doit pas le recréer d'elle-même. */
const DEFAULT_IDLE_SECONDS = 5;

// --- Arguments -------------------------------------------------------------------
const cli = process.argv.slice(2);
const separator = cli.indexOf('--');
const own = separator < 0 ? cli : cli.slice(0, separator);
const appArgs = separator < 0 ? [] : cli.slice(separator + 1);

const option = (name) => {
  const arg = own.find((item) => item.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
};
const target = own.find((arg) => !arg.startsWith('--')) ?? null;
const timeoutOption = option('timeout');
const outDir = path.resolve(option('out') ?? path.join(root, 'self-test-output', 'documents-absent'));
const requestedFolder = option('folder');
const idleOption = Number(option('idle') ?? DEFAULT_IDLE_SECONDS);
const idleMs = Number.isFinite(idleOption) && idleOption >= 0 ? Math.min(idleOption, 60) * 1000 : DEFAULT_IDLE_SECONDS * 1000;

const label = target === 'electron' ? 'electron' : path.basename(target ?? `Evolve-${pkg.version}-portable.exe`);
const TITLE = `Dossier Documents absent — ${label}`;

function annotate(kind, message) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  console.log(annotation(kind, TITLE, String(message).slice(0, 3500)));
}

/** Ajoute un texte au résumé de la compilation GitHub Actions (s'il existe). */
function summarize(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, `${markdown}\n`);
  } catch {
    /* le résumé est facultatif */
  }
}

// --- Dossier Documents, selon Windows ---------------------------------------------

/**
 * Interroge Windows sur le dossier Documents du compte : l'emplacement
 * enregistré (qu'il existe ou non) et l'emplacement « vérifié », vide si le
 * dossier n'existe pas — c'est cette seconde réponse que reçoit une
 * application qui demande où se trouve le dossier, sans demander à le créer.
 * @returns {{ registered: string, verified: string } | null} `null` si Windows n'a pas pu être interrogé
 */
function askWindows() {
  if (process.platform !== 'win32') return null;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$folder = [Environment+SpecialFolder]::MyDocuments',
    '$registered = [Environment]::GetFolderPath($folder, [Environment+SpecialFolderOption]::DoNotVerify)',
    '$verified = [Environment]::GetFolderPath($folder)',
    "$json = '{\"registered\":' + (ConvertTo-Json $registered) + ',\"verified\":' + (ConvertTo-Json $verified) + '}'",
    "'EVOLVE:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))",
  ].join('\r\n');
  try {
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true },
    );
    const line = String(result.stdout ?? '')
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item.startsWith('EVOLVE:'));
    if (!line) return null;
    const answer = JSON.parse(Buffer.from(line.slice('EVOLVE:'.length), 'base64').toString('utf8'));
    return typeof answer.registered === 'string' && typeof answer.verified === 'string' ? answer : null;
  } catch {
    return null;
  }
}

// --- État du disque ----------------------------------------------------------------

/** Vrai si quelque chose porte ce nom (dossier, fichier ou lien, même rompu). */
function present(target) {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/** Contenu direct d'un dossier : noms triés, les dossiers suivis de « / ». */
function listing(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .map((item) => `${item.name}${item.isDirectory() ? '/' : ''}`)
    .sort();
}

/** Différences entre deux contenus : éléments apparus et disparus. */
function difference(before, after) {
  const added = after.filter((name) => !before.includes(name));
  const removed = before.filter((name) => !after.includes(name));
  return [...added.map((name) => `apparu : ${name}`), ...removed.map((name) => `disparu : ${name}`)];
}

/** Refus passagers : un autre programme (antivirus, indexation) retient le dossier un instant. */
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

/** Exécute `operation` ; nouveaux essais, pendant dix secondes, si un autre programme retient le dossier. */
async function patiently(operation) {
  let last;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!TRANSIENT.has(error?.code)) throw error;
      last = error;
      await sleep(250);
    }
  }
  throw last;
}

/** Renomme un dossier. */
const rename = (from, to) => patiently(() => renameSync(from, to));

// --- Mise de côté et remise en place -----------------------------------------------

/** Dossier Documents à mettre de côté, son dossier parent, et le nom qu'il porte une fois de côté. */
let folder = null;
let aside = null;
/** Vrai tant que le dossier est de côté et doit être remis en place. */
let setAside = false;

/**
 * Remet le dossier en place. Si un dossier du même nom est apparu entre-temps
 * — ce que cette vérification redoute —, il est retiré s'il est vide, sinon
 * conservé sous un autre nom : aucun fichier n'est jamais effacé.
 * @returns {Promise<string|null>} message d'erreur, ou `null` si tout est en place
 */
async function restore() {
  if (!setAside) return null;
  try {
    if (present(folder)) {
      let empty = false;
      try {
        empty = lstatSync(folder).isDirectory() && readdirSync(folder).length === 0;
      } catch {
        empty = false;
      }
      if (empty) await patiently(() => rmdirSync(folder));
      else await rename(folder, `${folder}${RECREATED_SUFFIX}-${Date.now()}`);
    }
    await rename(aside, folder);
    setAside = false;
    return null;
  } catch (error) {
    return `Le dossier mis de côté n'a pas pu être remis en place (${error.message}).\n  Il se trouve ici : ${aside}\n  Renommez-le en : ${folder}`;
  }
}

/**
 * Termine en échec, après avoir remis le dossier en place.
 * @param {string} message
 * @param {object} [options]
 * @param {boolean} [options.verdict]  l'exécutable a été éprouvé et n'est pas conforme ;
 *        sinon, la vérification n'a pas pu avoir lieu
 */
async function fail(message, { verdict = true } = {}) {
  const problem = await restore();
  const text = problem ? `${message}\n\n${problem}` : message;
  console.error(`\n✖ ${text}`);
  console.error(
    verdict
      ? '\n✖ Dossier Documents absent : vérification en échec — l’exécutable ne doit pas être distribué.'
      : '\n✖ Dossier Documents absent : la vérification n’a pas pu avoir lieu.',
  );
  annotate('error', text);
  summarize(`### ❌ Dossier Documents absent : ${verdict ? 'échec' : 'vérification impossible'}\n\n${text}\n`);
  process.exit(1);
}

/** Termine sans avoir éprouvé l'exécutable : la situation « dossier absent » n'a pas pu être créée. */
const refuse = (message) => fail(message, { verdict: false });

// --- Vérification ------------------------------------------------------------------
const reserved = appArgs.find((arg) => /^--(?:self-test-scenario|self-test)(?:=|$)/.test(arg));
if (reserved) await refuse(`Option « ${reserved.split('=')[0]} » réservée à ce script : elle ne peut pas être transmise à l'application.`);

let windows = null;
if (requestedFolder) {
  folder = path.resolve(requestedFolder);
} else {
  // Le véritable dossier Documents du compte : sur la machine de compilation seulement.
  if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') {
    await refuse(
      'Cette vérification met de côté, le temps d’un lancement, le dossier Documents du compte : elle est réservée à la ' +
        'machine de compilation (GitHub Actions, sous Windows) et ne touche jamais au dossier Documents d’un autre ordinateur.\n' +
        '  Pour éprouver ce script sur un dossier d’essai : --folder=DOSSIER',
    );
  }
  windows = askWindows();
  folder = windows?.registered ? path.resolve(windows.registered) : path.join(homedir(), 'Documents');
  if (/^[\\/]{2}/.test(folder)) await refuse(`Le dossier Documents de ce compte se trouve sur le réseau (${folder}) : il ne peut pas être mis de côté.`);
}
const profile = path.dirname(folder);
aside = `${folder}${ASIDE_SUFFIX}`;

console.log(TITLE);
console.log(
  `Dossier Documents : ${folder}${requestedFolder ? ' (dossier d’essai)' : windows ? ' (emplacement indiqué par Windows)' : ' (emplacement par défaut : Windows n’a pas pu être interrogé)'}\n`,
);

if (!existsSync(profile)) await refuse(`Dossier introuvable : ${profile}`);
if (present(aside)) {
  await refuse(`${aside} existe déjà : une vérification précédente a été interrompue. Remettez ce dossier en place (renommez-le en ${path.basename(folder)}), puis relancez.`);
}

console.log('── 1. Le dossier Documents est mis de côté ──');
let asideBefore = null;
if (present(folder)) {
  if (!lstatSync(folder).isDirectory()) await refuse(`${folder} n'est pas un dossier.`);
  try {
    await rename(folder, aside);
  } catch (error) {
    await refuse(`Le dossier ${folder} n'a pas pu être mis de côté (${error.message}).`);
  }
  setAside = true;
  asideBefore = listing(aside);
  console.log(`  ✔ renommé en ${path.basename(aside)} (${asideBefore.length} élément${asideBefore.length > 1 ? 's' : ''}, contenu non touché)`);
} else {
  console.log('  ✔ déjà absent de cette machine : rien à mettre de côté');
}
// Si ce script est interrompu, le dossier est remis en place avant l'arrêt.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    restore().finally(() => process.exit(1));
  });
}

if (present(folder)) await refuse(`${folder} existe encore après sa mise de côté : la situation « dossier absent » n'a pas pu être créée.`);
/**
 * Vrai si Windows, interrogé comme le fait une application (même fonction du
 * système que celle du moteur d'Evolve), ne répond plus aucun emplacement.
 * Simple information : c'est le disque, après le lancement, qui fait foi.
 */
let confirmedByWindows = false;
if (windows) {
  const now = askWindows();
  confirmedByWindows = now !== null && now.verified === '';
  if (confirmedByWindows) console.log('  ✔ Windows le confirme : interrogé sur le dossier Documents, il ne répond plus aucun emplacement');
  else if (now) console.log(`  ! Windows répond encore un emplacement (${now.verified}) bien que le dossier n'existe plus`);
  else console.log('  ! Windows n’a pas pu être interrogé une seconde fois');
  if (present(folder)) await refuse(`${folder} a été recréé par la simple question posée à Windows : la vérification ne peut rien conclure.`);
}
await sleep(idleMs);
if (present(folder)) {
  await refuse(`${folder} a été recréé avant même le lancement d'Evolve : un autre programme de cette machine le recrée, la vérification ne peut rien conclure.`);
}
console.log(`  ✔ toujours absent ${String(idleMs / 1000).replace('.', ',')} s plus tard : cette machine ne le recrée pas d'elle-même`);
const profileBefore = listing(profile);

console.log('\n── 2. Evolve est lancé et ouvre le dossier Documents ──');
const launched =
  spawnSync(
    process.execPath,
    [
      path.join(root, 'scripts', 'check-exe.mjs'),
      ...(target ? [target] : []),
      `--out=${outDir}`,
      ...(timeoutOption ? [`--timeout=${timeoutOption}`] : []),
      '--',
      ...appArgs,
      `--self-test-scenario=${SCENARIO}`,
    ],
    { cwd: root, stdio: 'inherit' },
  ).status === 0;

console.log('\n── 3. Constat sur le disque ──');
// D'abord le disque, avant toute autre opération : c'est lui qui fait foi.
const recreated = present(folder);
let recreatedDetails = '';
if (recreated) {
  try {
    const info = lstatSync(folder);
    const content = info.isDirectory() ? readdirSync(folder) : null;
    recreatedDetails = ` (${info.isDirectory() ? `dossier de ${content.length} élément${content.length > 1 ? 's' : ''}` : 'fichier'}, créé à ${info.birthtime.toISOString()})`;
  } catch {
    recreatedDetails = '';
  }
}
const profileAfter = listing(profile);
const asideAfter = setAside && present(aside) ? listing(aside) : null;

if (recreated) {
  await fail(`Le dossier Documents a été recréé pendant le lancement d'Evolve : ${folder}${recreatedDetails}.\n  Un dossier absent doit le rester : Evolve ne crée rien de lui-même.`);
}
console.log(`  ✔ le dossier Documents est toujours absent : ${folder} n'a pas été recréé`);

const changes = difference(profileBefore, profileAfter);
if (changes.length) await fail(`Le contenu de ${profile} a changé pendant le lancement d'Evolve :\n  ${changes.join('\n  ')}`);
console.log(`  ✔ rien n'est apparu ni n'a disparu dans ${profile} (${profileAfter.length} éléments, liste identique)`);

if (setAside) {
  if (asideAfter === null) await fail(`Le dossier mis de côté a disparu pendant le lancement d'Evolve : ${aside}`);
  const touched = difference(asideBefore, asideAfter);
  if (touched.length) await fail(`Le contenu du dossier mis de côté a changé pendant le lancement d'Evolve :\n  ${touched.join('\n  ')}`);
  console.log(`  ✔ le contenu mis de côté est intact (${asideAfter.length} élément${asideAfter.length > 1 ? 's' : ''})`);
}

if (!launched) await fail("Le lancement d'Evolve est en échec : le dossier Documents absent n'a pas été annoncé comme prévu (voir le rapport ci-dessus).");

// Le rapport est bien celui du scénario demandé, et chaque contrôle attendu y figure, réussi.
let report;
try {
  report = JSON.parse(readFileSync(path.join(outDir, 'result.json'), 'utf8'));
} catch (error) {
  await fail(`Rapport de l'application illisible (${error.message}).`);
}
if (report.scenario !== SCENARIO) await fail(`L'application n'a pas exécuté le scénario demandé (« ${SCENARIO} ») : ${JSON.stringify(report.scenario ?? null)}.`);
const passed = new Set((Array.isArray(report.checks) ? report.checks : []).filter((item) => item?.ok === true).map((item) => item.name));
const missing = [CHECKS.absent, CHECKS.home, CHECKS.tile, CHECKS.back, CHECKS.sidebar, CHECKS.desktop, CHECKS.refresh].filter((name) => !passed.has(name));
if (missing.length) await fail(`Contrôles absents du rapport de l'application :\n  ${missing.join('\n  ')}`);
console.log('  ✔ Evolve a annoncé le dossier comme introuvable (accueil, volet latéral, icône du bureau), sans bloquer la navigation');

console.log('\n── 4. Le dossier Documents est remis en place ──');
const wasAside = setAside;
const problem = await restore();
if (problem) {
  console.error(`\n✖ ${problem}`);
  annotate('error', problem);
  summarize(`### ❌ Dossier Documents absent : remise en place impossible\n\n${problem}\n`);
  process.exit(1);
}
if (wasAside) {
  const back = listing(folder);
  if (difference(asideBefore, back).length) {
    console.error(`\n✖ Le dossier remis en place n'a plus le même contenu : ${difference(asideBefore, back).join(', ')}`);
    process.exit(1);
  }
  console.log(`  ✔ ${folder} est de nouveau en place, avec son contenu`);
} else {
  console.log('  ✔ rien à remettre en place');
}

const facts = [
  `dossier Documents mis de côté${confirmedByWindows ? ' (Windows, interrogé, ne répondait plus aucun emplacement)' : ''} : ${folder}`,
  "ouvert dans Evolve depuis l'accueil, le volet latéral et l'icône du bureau : message « Dossier « Documents » introuvable », navigation intacte",
  "après le lancement : dossier toujours absent du disque — Evolve ne l'a pas recréé",
  `rien n'est apparu dans ${profile} (${profileAfter.length} éléments, liste identique)`,
  wasAside ? `contenu mis de côté intact (${asideBefore.length} élément${asideBefore.length > 1 ? 's' : ''}), dossier remis en place` : 'dossier déjà absent de cette machine : rien à remettre en place',
];
console.log(`\n✔ Dossier Documents absent : jamais recréé\n${facts.map((fact) => `  ✔ ${fact}`).join('\n')}`);
annotate('notice', `Dossier Documents absent : jamais recréé\n${facts.map((fact) => `✔ ${fact}`).join('\n')}`);
summarize(['### ✅ Dossier Documents absent : jamais recréé', '', ...facts.map((fact) => `- ${fact}`), ''].join('\n'));

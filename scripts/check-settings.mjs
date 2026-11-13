#!/usr/bin/env node
/**
 * Evolve — Vérification : les réglages survivent à un redémarrage.
 *
 * Lance l'application deux fois de suite sur le même dossier de réglages :
 *
 *   1. premier lancement : l'application part des valeurs par défaut,
 *      modifie des réglages depuis son interface, comme le ferait
 *      l'utilisateur, donne une nouvelle place à la fenêtre de l'explorateur,
 *      puis se ferme ;
 *   2. ce script lit lui-même le fichier settings.json laissé sur le disque ;
 *   3. second lancement (nouveau processus) : l'interface doit afficher les
 *      réglages modifiés, sans aucune action, et la fenêtre de l'explorateur
 *      doit s'ouvrir où elle avait été laissée.
 *
 * Il vérifie aussi que le dossier des réglages ne reçoit rien d'autre que
 * settings.json et que le relire — fenêtre de l'explorateur rouverte
 * comprise — ne le modifie pas.
 *
 * Utilisation :
 *   node scripts/check-settings.mjs [EXÉCUTABLE] [options] [-- ARGUMENTS…]
 *
 *   EXÉCUTABLE             comme scripts/check-exe.mjs (par défaut : le .exe
 *                          de dist/ ; « electron » : version de développement)
 *   --out=DOSSIER          résultats (par défaut : self-test-output/reglages/)
 *   --settings-dir=DOSSIER dossier de réglages à utiliser. Par défaut : un
 *                          dossier temporaire neuf. Un dossier qui contient
 *                          déjà des réglages est refusé : ils ne sont jamais
 *                          écrasés. Le fichier créé est retiré à la fin.
 *   --timeout=SECONDES     durée maximale de chaque lancement
 *   ARGUMENTS              transmis à l'application (sauf --settings-dir et
 *                          --self-test-scenario, que ce script fixe lui-même)
 *
 * Exemples :
 *   npm run check:settings                  vérifie l'exécutable de dist/
 *   npm run check:settings -- electron -- . vérifie la version de développement
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { annotation } from './ci-annotate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
// Ce que l'application doit avoir enregistré : mêmes définitions qu'elle.
const { CHANGED_SETTINGS, PLACEMENT_SETTINGS, readPlacement, describePlacement } = require('../src/main/selftest-settings.js');
const { SCHEMA_VERSION } = require('../src/services/settings-schema.js');
const { SETTINGS_FILE } = require('../src/services/platform.js');

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
const outDir = path.resolve(option('out') ?? path.join(root, 'self-test-output', 'reglages'));
const requestedDir = option('settings-dir');

const label = target === 'electron' ? 'electron' : path.basename(target ?? `Evolve-${pkg.version}-portable.exe`);

/** Dossier de réglages : celui demandé, sinon un dossier temporaire neuf. */
const settingsDir = requestedDir ? path.resolve(requestedDir) : mkdtempSync(path.join(tmpdir(), 'evolve-reglages-'));
const settingsFile = path.join(settingsDir, SETTINGS_FILE);
/** Vrai si le dossier a été créé pour cette vérification (il est alors retiré à la fin). */
const ownDir = !requestedDir || !existsSync(settingsDir);
/** Contenu du dossier avant la vérification : rien de cela n'est touché. */
const before = new Set(existsSync(settingsDir) ? readdirSync(settingsDir) : []);
/** Seuls fichiers que l'application peut créer dans ce dossier — et que ce script retire à la fin. */
const SETTINGS_FILES = [SETTINGS_FILE, `${SETTINGS_FILE}.tmp`, 'settings.corrupt.json'];

function annotate(kind, message) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  console.log(annotation(kind, `Réglages et redémarrage — ${label}`, String(message).slice(0, 3500)));
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

/** Fichiers apparus dans le dossier des réglages depuis le début de la vérification. */
function createdEntries() {
  return existsSync(settingsDir) ? readdirSync(settingsDir).filter((name) => !before.has(name)).sort() : [];
}

/**
 * Remet le dossier dans son état initial : seuls les fichiers de réglages
 * créés par la vérification sont retirés — jamais un fichier déjà présent, ni
 * un fichier d'une autre nature. Le fichier des réglages est d'abord copié
 * avec les résultats.
 */
function cleanUp() {
  try {
    if (before.has(SETTINGS_FILE)) return; // réglages déjà présents : rien n'a été lancé ni créé
    if (existsSync(settingsFile)) {
      mkdirSync(outDir, { recursive: true });
      copyFileSync(settingsFile, path.join(outDir, SETTINGS_FILE));
    }
    for (const name of createdEntries()) {
      if (SETTINGS_FILES.includes(name)) rmSync(path.join(settingsDir, name), { force: true });
    }
    if (ownDir && existsSync(settingsDir) && readdirSync(settingsDir).length === 0) rmdirSync(settingsDir);
  } catch (error) {
    console.error(`! Nettoyage incomplet de ${settingsDir} : ${error.message}`);
  }
}

function fail(message) {
  cleanUp();
  console.error(`\n✖ ${message}`);
  console.error('\n✖ Réglages non conservés : l’exécutable ne doit pas être distribué.');
  annotate('error', message);
  summarize(`### ❌ Réglages et redémarrage : échec\n\n${message}\n`);
  process.exit(1);
}

/** Lance l'application avec le scénario d'auto-test donné ; vrai si tout est conforme. */
function launch(step, scenario) {
  const args = [
    path.join(root, 'scripts', 'check-exe.mjs'),
    ...(target ? [target] : []),
    `--out=${path.join(outDir, step)}`,
    ...(timeoutOption ? [`--timeout=${timeoutOption}`] : []),
    '--',
    ...appArgs,
    `--settings-dir=${settingsDir}`,
    `--self-test-scenario=${scenario}`,
  ];
  return spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' }).status === 0;
}

/**
 * Lit le fichier des réglages laissé sur le disque et le compare à ce que
 * l'application devait enregistrer : les réglages modifiés, à leur valeur
 * exacte, et un emplacement valide pour la fenêtre de l'explorateur — ses
 * valeurs dépendent de l'écran. Renvoie le contenu brut du fichier et
 * l'emplacement relevé.
 */
function inspect(moment) {
  const entries = createdEntries();
  if (!entries.includes(SETTINGS_FILE)) {
    fail(`${moment} : aucun fichier ${SETTINGS_FILE} dans ${settingsDir} — les réglages n'ont pas été enregistrés.`);
  }
  if (entries.length !== 1) {
    const kept = entries.filter((name) => !SETTINGS_FILES.includes(name));
    fail(
      `${moment} : le dossier des réglages contient autre chose que ${SETTINGS_FILE} : ${entries.join(', ')}` +
        (kept.length ? `\n  Laissé en place, à examiner : ${kept.map((name) => path.join(settingsDir, name)).join(', ')}` : ''),
    );
  }

  const text = readFileSync(settingsFile, 'utf8');
  let content;
  try {
    content = JSON.parse(text);
  } catch (error) {
    fail(`${moment} : ${SETTINGS_FILE} illisible (${error.message}).`);
  }

  const sorted = (values) => JSON.stringify(Object.entries(values ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  const values = content.values && typeof content.values === 'object' ? content.values : {};
  // Les réglages modifiés depuis l'interface : exactement eux, à leur valeur exacte.
  const changed = Object.fromEntries(Object.entries(values).filter(([key]) => !PLACEMENT_SETTINGS.includes(key)));
  if (sorted(changed) !== sorted(CHANGED_SETTINGS)) {
    fail(
      `${moment} : ${SETTINGS_FILE} ne contient pas exactement les réglages modifiés.\n` +
        `  attendu  : ${JSON.stringify(CHANGED_SETTINGS)}\n  constaté : ${JSON.stringify(changed)}`,
    );
  }
  // L'emplacement donné à la fenêtre de l'explorateur : présent, et fait de valeurs admises.
  const found = readPlacement(values);
  if (!found.ok) {
    const kept = Object.fromEntries(Object.entries(values).filter(([key]) => PLACEMENT_SETTINGS.includes(key)));
    fail(`${moment} : emplacement de la fenêtre de l'explorateur non enregistré — ${found.problem}.\n  constaté : ${JSON.stringify(kept)}`);
  }
  if (content.schema !== SCHEMA_VERSION) fail(`${moment} : format du fichier inattendu (${JSON.stringify(content.schema)}).`);
  if (content.app !== pkg.version) fail(`${moment} : version notée dans le fichier inattendue (${JSON.stringify(content.app)}).`);
  if (!Number.isFinite(Date.parse(content.savedAt))) fail(`${moment} : date d'enregistrement invalide (${JSON.stringify(content.savedAt)}).`);
  return { text, placement: found.placement };
}

// --- Vérification ----------------------------------------------------------------
// Ce script décide lui-même du dossier et du scénario de chaque lancement : la
// même option transmise à l'application prendrait le pas sur la sienne, et la
// vérification porterait sur un autre dossier que celui qu'elle inspecte.
const reserved = appArgs.find((arg) => /^--(?:settings-dir|self-test-scenario|self-test)(?:=|$)/.test(arg));
if (reserved) {
  fail(`Option « ${reserved.split('=')[0]} » réservée à ce script : elle ne peut pas être transmise à l'application. Pour choisir le dossier des réglages, placez --settings-dir=… avant « -- ».`);
}
if (before.has(SETTINGS_FILE)) {
  fail(`${settingsFile} existe déjà : cette vérification n'écrase jamais des réglages existants. Indiquez un autre dossier avec --settings-dir=…`);
}

console.log(`Réglages et redémarrage — ${label}`);
console.log(`Dossier des réglages : ${settingsDir}\n`);
console.log('── 1. Premier lancement : réglages modifiés depuis l’interface ──');
if (!launch('1-modification', 'settings-write')) fail('Premier lancement en échec : les réglages n’ont pas pu être modifiés (voir le rapport ci-dessus).');

const { text: saved, placement } = inspect('Après le premier lancement');
/** Ce que le premier lancement a fait de la fenêtre : déplacée à la souris, sinon agrandie depuis son menu. */
const windowLine = `fenêtre de l'explorateur ${placement.maximized ? 'agrandie' : 'déplacée'} — ${describePlacement(placement)}`;
console.log(`\n  ✔ ${SETTINGS_FILE} enregistré (${Buffer.byteLength(saved)} octets), seul dans son dossier :`);
for (const [key, value] of Object.entries(CHANGED_SETTINGS)) console.log(`      ${key} = ${JSON.stringify(value)}`);
console.log(`      ${windowLine}`);

console.log('\n── 2. Nouveau lancement : réglages retrouvés ──');
if (!launch('2-relance', 'settings-read')) fail('Second lancement en échec : l’interface n’a pas retrouvé les réglages enregistrés (voir le rapport ci-dessus).');

const { text: reread } = inspect('Après le second lancement');
if (reread !== saved) fail(`Le second lancement a modifié ${SETTINGS_FILE} alors qu'aucun réglage n'a changé.`);

cleanUp();

const count = Object.keys(CHANGED_SETTINGS).length;
const overview =
  `${count} réglages modifiés depuis l'interface et l'emplacement de la fenêtre de l'explorateur (${placement.maximized ? 'agrandie' : 'déplacée'}), ` +
  `enregistrés dans ${settingsFile} (${Buffer.byteLength(saved)} octets), puis retrouvés par un nouveau lancement. ` +
  `Le dossier ne contient que ${SETTINGS_FILE} ; le relire ne le modifie pas.`;
console.log(`\n✔ Réglages conservés après redémarrage — ${overview}`);
annotate('notice', `Réglages conservés après redémarrage — ${overview}`);
summarize(
  [
    '### ✅ Réglages et redémarrage : réussi',
    '',
    overview,
    '',
    '| Réglage | Valeur enregistrée |',
    '| --- | --- |',
    ...Object.entries(CHANGED_SETTINGS).map(([key, value]) => `| \`${key}\` | \`${JSON.stringify(value)}\` |`),
    ...Object.entries(placement).map(([name, value]) => `| \`explorerWindow.${name}\` | \`${JSON.stringify(value)}\` |`),
    '',
    `Emplacement retrouvé : ${windowLine}.`,
    '',
  ].join('\n'),
);

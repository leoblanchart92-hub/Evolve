/**
 * Evolve — Outils communs aux vérifications de l'installateur
 * (check-setup.mjs : installation et désinstallation ; check-update.mjs :
 * mise à jour).
 *
 * Windows est interrogé par PowerShell, en lecture seule : inscription du
 * programme parmi ceux de l'utilisateur, raccourcis, lancement au démarrage.
 * Ce que ces relevés doivent contenir est décidé ici, par des fonctions sans
 * effet, que les tests exécutent sur tout système.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Nom du produit, de son programme et de son désinstallateur, tels que l'installateur les écrit. */
export const PRODUCT_NAME = 'Evolve';
export const APP_EXE = 'Evolve.exe';
export const UNINSTALLER_EXE = 'Uninstall Evolve.exe';
/** Dossier, dans %LOCALAPPDATA%, où l'installateur d'electron-builder garderait une copie de lui-même. */
export const INSTALLER_COPY_DIR = 'evolve-updater';

/**
 * Relevé de l'installation (PowerShell). Écrit, dans le fichier désigné par
 * EVOLVE_STATE_FILE, un objet JSON :
 *   user / machine   inscriptions « Evolve … » parmi les programmes de
 *                    l'utilisateur (HKCU) et de la machine (HKLM) ;
 *   startMenu / desktop   raccourcis « Evolve », avec leur cible, ou null ;
 *   run / startupLinks    ce qui lancerait Evolve au démarrage de Windows ;
 *   localAppData / appData / temp   dossiers du profil.
 */
export const STATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Get-Entries([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return @() }
  $found = @()
  foreach ($key in @(Get-ChildItem -LiteralPath $path -ErrorAction SilentlyContinue)) {
    $values = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
    if ($values -and (([string]$values.DisplayName) -match '^Evolve( |$)')) {
      $found += [ordered]@{
        key = [string]$key.PSChildName
        name = [string]$values.DisplayName
        version = [string]$values.DisplayVersion
        location = [string]$values.InstallLocation
        uninstall = [string]$values.UninstallString
        quiet = [string]$values.QuietUninstallString
      }
    }
  }
  return $found
}
$shell = New-Object -ComObject WScript.Shell
function Get-Link([string]$file) {
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  $link = $shell.CreateShortcut($file)
  return [ordered]@{ file = $file; target = [string]$link.TargetPath; arguments = [string]$link.Arguments }
}
$uninstall = 'Software\Microsoft\Windows\CurrentVersion\Uninstall'
$programs = [Environment]::GetFolderPath('Programs')
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$startup = [Environment]::GetFolderPath('Startup')
$run = @()
$runKey = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
if ($runKey) {
  foreach ($property in $runKey.PSObject.Properties) {
    if ($property.Name -like 'PS*') { continue }
    if (($property.Name -like '*Evolve*') -or (([string]$property.Value) -like '*Evolve*')) {
      $run += [ordered]@{ name = [string]$property.Name; value = [string]$property.Value }
    }
  }
}
$startupLinks = @()
if ($startup -and (Test-Path -LiteralPath $startup)) {
  foreach ($item in @(Get-ChildItem -LiteralPath $startup -ErrorAction SilentlyContinue)) {
    if ($item.Name -like '*Evolve*') { $startupLinks += [string]$item.Name }
  }
}
$state = [ordered]@{
  user = @(Get-Entries ('HKCU:\' + $uninstall))
  machine = @(Get-Entries ('HKLM:\' + $uninstall)) + @(Get-Entries ('HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'))
  startMenu = Get-Link (Join-Path $programs 'Evolve.lnk')
  desktop = Get-Link (Join-Path $desktop 'Evolve.lnk')
  run = @($run)
  startupLinks = @($startupLinks)
  localAppData = [string]$env:LOCALAPPDATA
  appData = [string]$env:APPDATA
  temp = [System.IO.Path]::GetTempPath()
}
$json = ConvertTo-Json -InputObject $state -Depth 6 -Compress
[System.IO.File]::WriteAllText($env:EVOLVE_STATE_FILE, $json, (New-Object System.Text.UTF8Encoding $false))
`;

/** Première ligne utile d'une sortie de PowerShell (sans son habillage XML). */
export function firstLine(text) {
  return (
    String(text ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#< CLIXML') && !line.startsWith('<Objs')) ?? ''
  ).slice(0, 300);
}

/**
 * Exécute un script PowerShell ; ses paramètres lui sont passés par des
 * variables d'environnement.
 * @returns {{ ok: boolean, detail: string }}
 */
export function runPowerShell(script, { env = {}, timeout = 90_000 } = {}) {
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, ...env }, encoding: 'utf8', timeout, windowsHide: true },
  );
  if (result.error) return { ok: false, detail: result.error.message };
  if (result.status !== 0) return { ok: false, detail: firstLine(result.stderr || result.stdout) || `code ${result.status}` };
  return { ok: true, detail: '' };
}

const isText = (value) => typeof value === 'string';
const isList = (value) => Array.isArray(value);

/**
 * Contrôle la forme d'un relevé d'installation.
 * @param {string} text  contenu JSON écrit par STATE_SCRIPT
 * @returns {object} le relevé
 * @throws {Error} si le relevé n'a pas la forme attendue
 */
export function parseInstallState(text) {
  let state;
  try {
    state = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`relevé de l'installation illisible : ${error.message}`);
  }
  const entry = (item) => item && typeof item === 'object' && ['key', 'name', 'version', 'location', 'uninstall', 'quiet'].every((name) => isText(item[name]));
  const link = (item) => item === null || (item && typeof item === 'object' && isText(item.file) && isText(item.target) && isText(item.arguments));
  const valid =
    state &&
    typeof state === 'object' &&
    isList(state.user) &&
    state.user.every(entry) &&
    isList(state.machine) &&
    state.machine.every(entry) &&
    link(state.startMenu) &&
    link(state.desktop) &&
    isList(state.run) &&
    isList(state.startupLinks) &&
    isText(state.localAppData) &&
    state.localAppData !== '' &&
    isText(state.appData) &&
    state.appData !== '';
  if (!valid) throw new Error("relevé de l'installation incomplet");
  return state;
}

/**
 * Relève l'installation d'Evolve sur cette machine Windows.
 * @returns {object} voir STATE_SCRIPT
 */
export function readInstallState({ run = runPowerShell } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'evolve-releve-'));
  const file = path.join(dir, 'installation.json');
  try {
    const result = run(STATE_SCRIPT, { env: { EVOLVE_STATE_FILE: file } });
    if (!result.ok) throw new Error(`relevé de l'installation impossible : ${result.detail}`);
    if (!existsSync(file)) throw new Error("relevé de l'installation impossible : aucun résultat écrit");
    return parseInstallState(readFileSync(file, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Compare deux chemins de Windows : ni la casse, ni une barre finale ne comptent. */
export function sameWindowsPath(first, second) {
  const canonical = (value) => {
    const text = String(value ?? '').trim();
    return text === '' ? '' : path.win32.normalize(text).replace(/[\\/]+$/, '').toLowerCase();
  };
  return canonical(first) !== '' && canonical(first) === canonical(second);
}

/**
 * Découpe une ligne de commande de Windows : programme entre guillemets,
 * puis arguments séparés par des espaces.
 * @returns {string[]} programme, puis arguments ; liste vide si la ligne est inutilisable
 */
export function parseCommandLine(text) {
  const parts = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  for (const match of String(text ?? '').matchAll(pattern)) parts.push(match[1] ?? match[2]);
  return parts;
}

/** Dossier où l'installateur place le programme : dans le profil de l'utilisateur, jamais ailleurs. */
export function expectedInstallDir(state) {
  return path.win32.join(state.localAppData, 'Programs', PRODUCT_NAME);
}

/**
 * Dossier d'une installation relevée. L'installateur ne l'inscrit pas parmi
 * les informations de désinstallation : c'est le dossier du désinstallateur
 * que Windows lancerait.
 * @param {{ location?: string, uninstall?: string, quiet?: string }} entry
 * @returns {string} chaîne vide si rien ne permet de le savoir
 */
export function installDirOf(entry) {
  if (typeof entry?.location === 'string' && entry.location.trim() !== '') return entry.location.trim();
  const [program] = parseCommandLine(entry?.uninstall || entry?.quiet);
  return program && /[\\/]/.test(program) ? path.win32.dirname(program) : '';
}

/**
 * Ce qui, dans un relevé pris après l'installation, n'est pas conforme :
 * une seule inscription, pour l'utilisateur seul, à la version attendue, dans
 * son profil ; deux raccourcis vers le programme installé ; rien au démarrage.
 * @param {object} state  relevé (voir STATE_SCRIPT)
 * @param {{ version: string }} expected
 * @returns {string[]} problèmes ; liste vide si tout est conforme
 */
export function installProblems(state, { version }) {
  const problems = [];
  if (state.machine.length > 0) {
    problems.push(`inscrit pour toute la machine (HKLM), ce qui exige des droits d'administrateur : ${state.machine.map((item) => item.name).join(', ')}`);
  }
  if (state.user.length !== 1) {
    problems.push(`${state.user.length} inscription(s) parmi les programmes de l'utilisateur, au lieu d'une seule`);
    return problems;
  }
  const [entry] = state.user;
  const dir = expectedInstallDir(state);
  const exe = path.win32.join(dir, APP_EXE);
  if (entry.name !== `${PRODUCT_NAME} ${version}`) problems.push(`nom inscrit : « ${entry.name} », au lieu de « ${PRODUCT_NAME} ${version} »`);
  if (entry.version !== version) problems.push(`version inscrite : ${entry.version || '(aucune)'}, au lieu de ${version}`);
  if (!sameWindowsPath(installDirOf(entry), dir)) problems.push(`dossier d'installation inattendu : ${installDirOf(entry) || '(aucun)'}, au lieu de ${dir}`);

  // La désinstallation proposée par Windows : le désinstallateur du dossier installé, pour l'utilisateur seul.
  for (const [label, command, silent] of [['désinstallation', entry.uninstall, false], ['désinstallation silencieuse', entry.quiet, true]]) {
    const [program, ...args] = parseCommandLine(command);
    if (!sameWindowsPath(program, path.win32.join(dir, UNINSTALLER_EXE))) problems.push(`${label} : programme inattendu (${command || 'aucun'})`);
    if (!args.includes('/currentuser')) problems.push(`${label} : l'option /currentuser est absente (${command || 'aucune commande'})`);
    if (args.includes('/allusers')) problems.push(`${label} : demandée pour tous les utilisateurs (${command})`);
    if (silent && !args.includes('/S')) problems.push(`${label} : l'option /S est absente (${command || 'aucune commande'})`);
  }

  for (const [label, link] of [['menu Démarrer', state.startMenu], ['bureau', state.desktop]]) {
    if (!link) problems.push(`raccourci du ${label} absent`);
    else if (!sameWindowsPath(link.target, exe)) problems.push(`raccourci du ${label} : il mène à ${link.target || '(rien)'}, au lieu de ${exe}`);
    else if (link.arguments.trim() !== '') problems.push(`raccourci du ${label} : arguments inattendus (${link.arguments})`);
  }

  if (state.run.length > 0) problems.push(`lancement au démarrage de Windows (registre) : ${state.run.map((item) => `${item.name} = ${item.value}`).join(' ; ')}`);
  if (state.startupLinks.length > 0) problems.push(`lancement au démarrage de Windows (dossier Démarrage) : ${state.startupLinks.join(', ')}`);
  return problems;
}

/**
 * Ce qui, dans un relevé pris après la désinstallation, est resté :
 * inscription, raccourcis, lancement au démarrage.
 * @returns {string[]} restes ; liste vide si tout a été retiré
 */
export function uninstallLeftovers(state) {
  const left = [];
  for (const entry of [...state.user, ...state.machine]) left.push(`inscription « ${entry.name} » (${entry.key})`);
  if (state.startMenu) left.push(`raccourci du menu Démarrer (${state.startMenu.file})`);
  if (state.desktop) left.push(`raccourci du bureau (${state.desktop.file})`);
  for (const item of state.run) left.push(`lancement au démarrage (${item.name})`);
  for (const name of state.startupLinks) left.push(`raccourci du dossier Démarrage (${name})`);
  return left;
}

/**
 * Inventaire d'un dossier : nombre de fichiers, taille totale, et fichiers
 * dont le nom figure dans `watch` (sans tenir compte de la casse).
 * @returns {{ files: number, bytes: number, found: string[] }}
 */
export function inventory(dir, { watch = [] } = {}) {
  const wanted = new Set(watch.map((name) => name.toLowerCase()));
  const total = { files: 0, bytes: 0, found: [] };
  const walk = (current) => {
    let items;
    try {
      items = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(current, item.name);
      if (item.isDirectory() && !item.isSymbolicLink()) walk(full);
      else {
        total.files += 1;
        try {
          total.bytes += statSync(full).size;
        } catch {
          /* fichier disparu entre-temps */
        }
        if (wanted.has(item.name.toLowerCase())) total.found.push(path.relative(dir, full));
      }
    }
  };
  walk(dir);
  return total;
}

/** Noms des éléments d'un dossier (liste vide s'il n'existe pas). */
export function namesIn(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Éléments apparus dans un dossier, et parmi eux ceux qui ne sont pas attendus.
 * Seuls les noms qui évoquent Evolve comptent comme inattendus : d'autres
 * programmes de la machine écrivent aussi dans le profil pendant ce temps.
 * @param {string[]} before  noms avant l'installation
 * @param {string[]} after   noms après
 * @param {string[]} [allowed]  noms qu'Evolve peut créer
 * @returns {{ created: string[], unexpected: string[] }}
 */
export function profileChanges(before, after, allowed = []) {
  const known = new Set(before.map((name) => name.toLowerCase()));
  const permitted = new Set(allowed.map((name) => name.toLowerCase()));
  const created = after.filter((name) => !known.has(name.toLowerCase()));
  return { created, unexpected: created.filter((name) => /evolve/i.test(name) && !permitted.has(name.toLowerCase())) };
}

/** Taille lisible : « 312 Mo », « 14 Ko »… */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'taille inconnue';
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} Mo`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${bytes} octets`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Attend que `ready()` renvoie une valeur vraie.
 * @returns {Promise<any>} cette valeur, ou `null` si le délai est dépassé
 */
export async function waitFor(ready, { timeout = 60_000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value = null;
    try {
      value = await ready();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(interval);
  }
}

/**
 * Lance l'installateur sans aucune fenêtre (/S) et attend sa fin.
 * @param {string} setup  fichier de l'installateur
 * @param {{ args?: string[], timeout?: number }} [options]
 * @returns {{ ok: boolean, detail: string, seconds: number }}
 */
export function installSilently(setup, { args = [], timeout = 300_000 } = {}) {
  const started = Date.now();
  const result = spawnSync(setup, ['/S', ...args], { stdio: 'ignore', timeout, windowsHide: true });
  const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
  if (result.error) return { ok: false, detail: result.error.message, seconds };
  if (result.status !== 0) return { ok: false, detail: `code de sortie ${result.status ?? result.signal}`, seconds };
  return { ok: true, detail: '', seconds };
}

/**
 * Lance la désinstallation silencieuse inscrite par l'installateur — celle que
 * Windows emploierait — puis attend que le dossier et l'inscription aient
 * disparu. (Le désinstallateur se recopie dans le dossier temporaire pour
 * pouvoir se supprimer : son processus rend la main avant d'avoir fini.)
 * @param {{ quiet: string, uninstall?: string, location?: string }} entry  inscription relevée
 * @param {{ read?: () => object, timeout?: number }} [options]
 * @returns {Promise<{ ok: boolean, detail: string, state: object|null }>}
 */
export async function uninstallSilently(entry, { read = readInstallState, timeout = 180_000 } = {}) {
  const [program, ...args] = parseCommandLine(entry.quiet);
  if (!program || !existsSync(program)) return { ok: false, detail: `désinstallateur introuvable : ${entry.quiet || '(aucune commande inscrite)'}`, state: null };
  const dir = installDirOf(entry);
  const result = spawnSync(program, args, { stdio: 'ignore', timeout: 120_000, windowsHide: true });
  if (result.error) return { ok: false, detail: result.error.message, state: null };
  let state = null;
  const done = await waitFor(
    () => {
      if (dir && existsSync(dir)) return false;
      state = read();
      return state.user.length === 0;
    },
    { timeout, interval: 1000 },
  );
  if (!done) return { ok: false, detail: `après ${Math.round(timeout / 1000)} s, le programme est toujours inscrit ou son dossier existe encore (${dir})`, state };
  return { ok: true, detail: '', state };
}

#!/usr/bin/env node
/**
 * Evolve — Vérification du lancement normal de l'exécutable.
 *
 * Lance l'application comme le ferait un double-clic (plein écran, sans
 * option d'essai), puis contrôle de l'extérieur que :
 *   - l'interface démarre et la fenêtre est visible, en plein écran ;
 *   - l'écran affiche réellement l'interface : une capture de l'écran est
 *     comparée à l'image dessinée par l'application (sous Windows) ;
 *   - l'application reste ouverte, puis se ferme normalement sur demande
 *     (comme avec Alt+F4), avec un code de sortie nul.
 *
 * Pour l'exécutable portable, il mesure aussi l'espace occupé dans le dossier
 * temporaire pendant le fonctionnement, signale ce qui n'aurait pas été
 * supprimé à la fermeture, et indique la taille des données que l'application
 * conserve.
 *
 * L'application signale son état grâce à l'option `--status-file`
 * (voir src/main/status.js). Le dossier des résultats contient ensuite :
 *   etat.json   l'état signalé par l'application ;
 *   etat.png    l'image dessinée par l'application ;
 *   ecran.png   ce que l'écran affichait au même moment (sous Windows).
 *
 * Utilisation :
 *   node scripts/check-launch.mjs [EXÉCUTABLE] [OPTIONS] [-- ARGUMENTS…]
 *
 *   EXÉCUTABLE     par défaut : dist/Evolve-<version>-portable.exe ; le mot
 *                  « electron » désigne le moteur installé par « npm install »
 *   --out=DOSSIER  dossier des résultats (par défaut : self-test-output/lancement)
 *   --timeout=N    attente maximale du démarrage, en secondes (par défaut : 120)
 *   --close-timeout=N  attente maximale de la fermeture, en secondes (par défaut : 60)
 *   --observe=N    durée pendant laquelle l'application doit rester ouverte avant
 *                  la capture de l'écran, en secondes (par défaut : 1)
 *   ARGUMENTS      transmis à l'application (exemple : -- . --windowed)
 */

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { annotation } from './ci-annotate.mjs';

/**
 * Comparaison de l'écran avec l'image dessinée par l'application : les deux
 * images sont découpées en cases (carrées pour un écran 16:9), dont on compare
 * la couleur moyenne.
 */
const GRID = Object.freeze({ columns: 32, rows: 18 });
/** Écart maximal, par composante (0 à 255), entre deux cases jugées identiques. */
const CELL_TOLERANCE = 16;
/**
 * Part de l'écran correspondant à l'interface : au-delà de `shown`, elle est
 * affichée (une barre des tâches ou une notification peut masquer le reste) ;
 * en deçà de `absent`, elle ne l'est pas.
 */
export const SCREEN_MATCH = Object.freeze({ shown: 0.9, absent: 0.5 });

/** Attente maximale de la suppression des fichiers temporaires, une fois l'application fermée. */
const CLEANUP_TIMEOUT_MS = 10_000;

/**
 * Dossier de travail du lanceur de l'exécutable portable, créé dans le dossier
 * temporaire sous un nom variable : « ns », une lettre, puis un numéro
 * hexadécimal (exemple : nsk3F2A.tmp). Le motif accepte toute suite de lettres
 * et de chiffres : seuls les dossiers apparus depuis le lancement sont retenus.
 */
const LAUNCHER_DIR = /^ns[a-z0-9]+\.tmp$/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Anomalies relevées dans l'état signalé par l'application (liste vide : conforme).
 * @param {object} status contenu du fichier écrit par src/main/status.js
 * @param {{ expectFullscreen?: boolean }} [options]
 * @returns {string[]}
 */
export function statusProblems(status, { expectFullscreen = true } = {}) {
  if (!status || typeof status !== 'object') return ["compte rendu de l'application illisible"];
  const problems = [];
  if (status.closed === true) problems.push("la fenêtre s'est fermée pendant le démarrage");
  if (status.ready !== true) problems.push("l'interface n'a pas démarré (écran de démarrage toujours affiché)");
  if (status.closed !== true) {
    if (status.visible !== true) problems.push("la fenêtre n'est pas visible");
    if (status.minimized === true) problems.push('la fenêtre est réduite');
    const { bounds, display } = status;
    const sized = bounds && display && [bounds.width, bounds.height, display.width, display.height].every(Number.isFinite);
    if (!sized) {
      problems.push('dimensions de la fenêtre ou de l’écran absentes du compte rendu');
    } else if (expectFullscreen) {
      if (status.fullscreen !== true) problems.push("la fenêtre n'est pas en plein écran");
      // Deux points de marge : arrondis possibles lorsque l'affichage de Windows est agrandi.
      if (bounds.width < display.width - 2 || bounds.height < display.height - 2) {
        problems.push(`la fenêtre (${bounds.width} × ${bounds.height}) ne couvre pas l'écran (${display.width} × ${display.height})`);
      }
    } else if (status.fullscreen === true) {
      problems.push('la fenêtre est en plein écran alors que le mode fenêtré est demandé');
    }
  }
  for (const message of Array.isArray(status.errors) ? status.errors : []) problems.push(`erreur de l'interface : ${message}`);
  return problems;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Lit une image PNG courante : 8 bits par composante, couleurs RVB avec ou
 * sans transparence, non entrelacée (ce que produisent Electron et Windows).
 * @param {Buffer} bytes contenu du fichier
 * @returns {{ width: number, height: number, channels: 3|4, pixels: Buffer }} points de gauche à droite, de haut en bas
 */
export function decodePng(bytes) {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("ce fichier n'est pas une image PNG");

  let header = null;
  const data = [];
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (body.length < length) throw new Error('image PNG tronquée');
    if (type === 'IHDR' && length >= 13) {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], interlace: body[12] };
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new Error('image PNG sans en-tête');

  const { width, height, depth, colorType, interlace } = header;
  if (depth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) {
    throw new Error(`format PNG non pris en charge (${depth} bits, type ${colorType}${interlace ? ', entrelacé' : ''})`);
  }
  if (width === 0 || height === 0) throw new Error('image PNG vide');

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(data));
  } catch (error) {
    throw new Error(`image PNG illisible (${error.message})`);
  }
  if (raw.length < (stride + 1) * height) throw new Error('image PNG tronquée');

  // Chaque ligne est précédée de son filtre : la valeur enregistrée dépend des
  // points voisins déjà lus (a : à gauche, b : au-dessus, c : au-dessus à gauche).
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    const out = y * stride;
    if (filter > 4) throw new Error(`image PNG illisible (filtre ${filter})`);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[out + x - channels] : 0;
      const b = y > 0 ? pixels[out + x - stride] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const c = x >= channels && y > 0 ? pixels[out + x - stride - channels] : 0;
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[out + x] = (raw[line + x] + predicted) & 255;
    }
  }
  return { width, height, channels, pixels };
}

/**
 * Couleur moyenne [r, v, b] de chaque case d'une grille posée sur l'image.
 * @param {{ width: number, height: number, channels: number, pixels: Uint8Array }} image
 * @returns {number[][]} cases de gauche à droite, de haut en bas
 */
export function colorGrid({ width, height, channels, pixels }, columns = GRID.columns, rows = GRID.rows) {
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    const top = Math.floor((row * height) / rows);
    const bottom = Math.max(top + 1, Math.floor(((row + 1) * height) / rows));
    for (let column = 0; column < columns; column += 1) {
      const left = Math.floor((column * width) / columns);
      const right = Math.max(left + 1, Math.floor(((column + 1) * width) / columns));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = top; y < bottom; y += 1) {
        let at = (y * width + left) * channels;
        for (let x = left; x < right; x += 1, at += channels) {
          r += pixels[at];
          g += pixels[at + 1];
          b += pixels[at + 2];
        }
      }
      const count = (bottom - top) * (right - left);
      cells.push([Math.round(r / count), Math.round(g / count), Math.round(b / count)]);
    }
  }
  return cells;
}

/** Part (0 à 1) des cases de même couleur, à `tolerance` près, dans deux grilles de mêmes dimensions. */
export function gridMatch(first, second, tolerance = CELL_TOLERANCE) {
  if (first.length === 0 || first.length !== second.length) return 0;
  let same = 0;
  for (let index = 0; index < first.length; index += 1) {
    const [r1, g1, b1] = first[index];
    const [r2, g2, b2] = second[index];
    if (Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2)) <= tolerance) same += 1;
  }
  return same / first.length;
}

/** Couleur moyenne d'une grille, sous la forme « rvb(r, v, b) ». */
function meanColor(cells) {
  const mean = (channel) => Math.round(cells.reduce((sum, cell) => sum + cell[channel], 0) / cells.length);
  return `rvb(${mean(0)}, ${mean(1)}, ${mean(2)})`;
}

/**
 * Compare la capture de l'écran à l'image dessinée par l'application.
 *
 * Un écran qui ne montre pas l'interface n'est une erreur que si la fenêtre
 * de l'application est au premier plan : sinon, une autre fenêtre de la
 * machine la recouvre, ce qui ne dit rien de l'application.
 *
 * @param {Buffer} screenBytes capture de l'écran (PNG)
 * @param {Buffer} renderBytes image dessinée par l'application (PNG)
 * @param {{ foreground?: boolean|null, expected?: { width: number, height: number } }} [options]
 *   `foreground` : la fenêtre de l'application est-elle au premier plan ? (`null` : inconnu) ;
 *   `expected` : dimensions réelles de l'écran, en points — une capture d'une
 *   autre taille est tronquée ou vient d'un autre écran, et ne prouve rien
 * @returns {{ level: 'pass'|'warn'|'fail', text: string, ratio: number|null }}
 */
export function screenReport(screenBytes, renderBytes, { foreground = null, expected } = {}) {
  const screen = decodePng(screenBytes);
  if (expected && (Math.abs(screen.width - expected.width) > 2 || Math.abs(screen.height - expected.height) > 2)) {
    return {
      level: 'warn',
      ratio: null,
      text: `capture de l'écran aux dimensions inattendues (${screen.width} × ${screen.height} au lieu de ${expected.width} × ${expected.height}) : elle n'a pas été comparée à l'image dessinée par l'application`,
    };
  }
  const render = decodePng(renderBytes);
  const screenGrid = colorGrid(screen);
  const renderGrid = colorGrid(render);
  const ratio = gridMatch(screenGrid, renderGrid);
  // Arrondi vers le bas : « 100 % » signifie que tout l'écran correspond.
  const share = `${Math.floor(ratio * 100)} % de l'écran (${screen.width} × ${screen.height})`;

  if (ratio >= SCREEN_MATCH.shown) {
    return { level: 'pass', ratio, text: `l'écran affiche l'interface : ${share} correspond à l'image dessinée par l'application` };
  }
  const colors = `couleur moyenne de l'écran : ${meanColor(screenGrid)} ; de l'interface : ${meanColor(renderGrid)}`;
  if (ratio >= SCREEN_MATCH.absent) {
    return {
      level: 'warn',
      ratio,
      text: `l'écran n'affiche l'interface qu'en partie : ${share} correspond à l'image dessinée par l'application — une autre fenêtre la recouvre peut-être (${colors})`,
    };
  }
  if (foreground === true) {
    return {
      level: 'fail',
      ratio,
      text: `l'écran n'affiche pas l'interface alors que sa fenêtre est au premier plan : ${share} seulement correspond à l'image dessinée par l'application (${colors})`,
    };
  }
  const reason =
    foreground === false
      ? "la fenêtre de l'application n'est pas au premier plan sur cette machine"
      : "la fenêtre au premier plan n'a pas pu être identifiée";
  return {
    level: 'warn',
    ratio,
    text: `l'écran ne montre pas l'interface (${share} seulement correspond à l'image dessinée par l'application) ; ${reason} : l'affichage n'a pas pu être confirmé (${colors})`,
  };
}

// --- Fichiers temporaires --------------------------------------------------------

/** Dossiers de travail du lanceur présents dans le dossier temporaire `tempDir`. */
export function launcherDirs(tempDir) {
  try {
    return readdirSync(tempDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && LAUNCHER_DIR.test(entry.name))
      .map((entry) => path.join(tempDir, entry.name));
  } catch {
    return [];
  }
}

/** Nombre de fichiers et taille totale, en octets, d'un dossier (zéro s'il n'existe pas). */
export function folderUsage(dir) {
  let files = 0;
  let bytes = 0;
  const visit = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      try {
        bytes += statSync(full).size;
        files += 1;
      } catch {
        /* fichier supprimé entre-temps */
      }
    }
  };
  visit(dir);
  return { files, bytes };
}

/** Taille lisible : « 291 Mo », « 12 Ko ». */
export function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} Mo` : `${Math.ceil(bytes / 1024)} Ko`;
}

// --- Particularités du système ---------------------------------------------------

/**
 * Capture de l'écran principal (PowerShell), enregistrée en PNG, et relevé de
 * la fenêtre au premier plan. Le résultat est écrit, ligne par ligne, dans un
 * fichier texte (clé=valeur).
 *
 * `SetProcessDPIAware` donne les dimensions réelles de l'écran même si
 * l'affichage de Windows est agrandi (125 %, 150 %…) ; sans cela, la capture
 * serait tronquée.
 */
const CAPTURE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$info = New-Object System.Collections.Generic.List[string]
$failed = $false
try {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; public static class EvolveScreen { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int count); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId); }'
  [void][EvolveScreen]::SetProcessDPIAware()
  $window = [EvolveScreen]::GetForegroundWindow()
  if ($window -ne [IntPtr]::Zero) {
    $title = New-Object System.Text.StringBuilder 512
    [void][EvolveScreen]::GetWindowText($window, $title, 512)
    $processId = [uint32]0
    [void][EvolveScreen]::GetWindowThreadProcessId($window, [ref]$processId)
    $info.Add('foregroundPid=' + $processId)
    $info.Add('foregroundTitle=' + ($title.ToString() -replace '\\s+', ' '))
  } else {
    $info.Add('foregroundPid=0')
  }
} catch {
  $info.Add('foregroundError=' + ($_.Exception.Message -replace '\\s+', ' '))
}
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bitmap.Save($env:EVOLVE_CAPTURE_FILE, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
  $info.Add('captured=' + $bounds.Width + 'x' + $bounds.Height)
} catch {
  $failed = $true
  $info.Add('error=' + ($_.Exception.Message -replace '\\s+', ' '))
}
[System.IO.File]::WriteAllLines($env:EVOLVE_CAPTURE_INFO, $info, (New-Object System.Text.UTF8Encoding($false)))
if ($failed) { exit 1 }
`.replaceAll('\n', '\r\n');

/**
 * Lit le fichier texte écrit par la capture de l'écran.
 * @param {string} text lignes « clé=valeur »
 * @returns {{ error: string, foregroundPid: number|null, foregroundTitle: string }}
 */
export function parseCaptureInfo(text) {
  const values = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const pid = values.get('foregroundPid') ?? '';
  return {
    error: values.get('error') ?? '',
    // 0 : aucune fenêtre n'est au premier plan ; null : relevé impossible.
    foregroundPid: /^\d+$/.test(pid) ? Number(pid) : null,
    foregroundTitle: values.get('foregroundTitle') ?? '',
  };
}

/**
 * Capture l'écran dans `pngFile` et relève la fenêtre au premier plan.
 * @returns {{ bytes: Buffer, foregroundPid: number|null, foregroundTitle: string } | { unavailable: string }}
 */
function captureScreen(pngFile) {
  if (process.platform !== 'win32') return { unavailable: "capture de l'écran disponible sous Windows uniquement" };
  const infoFile = `${pngFile}.txt`;
  try {
    rmSync(infoFile, { force: true });
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(CAPTURE_SCRIPT, 'utf16le').toString('base64')],
      { env: { ...process.env, EVOLVE_CAPTURE_FILE: pngFile, EVOLVE_CAPTURE_INFO: infoFile }, encoding: 'utf8', timeout: 90_000, windowsHide: true },
    );
    if (result.error) return { unavailable: result.error.message };
    const info = parseCaptureInfo(existsSync(infoFile) ? readFileSync(infoFile, 'utf8') : '');
    if (result.status !== 0 || info.error) {
      return { unavailable: info.error || firstLine(result.stderr || result.stdout) || `code ${result.status}` };
    }
    return { bytes: readFileSync(pngFile), foregroundPid: info.foregroundPid, foregroundTitle: info.foregroundTitle };
  } catch (error) {
    return { unavailable: error.message };
  } finally {
    rmSync(infoFile, { force: true });
  }
}

/** Première ligne utile d'une sortie de PowerShell (sans son habillage XML). */
function firstLine(text) {
  return (
    String(text ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#< CLIXML') && !line.startsWith('<Objs')) ?? ''
  ).slice(0, 300);
}

/**
 * Demande à l'application de se fermer, comme le ferait Alt+F4.
 * @returns {string} réponse du système, utile si la fermeture n'a pas lieu
 */
function requestClose(pid) {
  if (process.platform === 'win32') {
    // Sans l'option /F, taskkill envoie à la fenêtre une demande de fermeture.
    const result = spawnSync('taskkill', ['/PID', String(pid)], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    return firstLine(result.error?.message || result.stderr || result.stdout);
  }
  try {
    process.kill(pid, 'SIGTERM');
    return '';
  } catch (error) {
    return error.message;
  }
}

/** Arrête de force l'application et tous ses processus. */
function forceKill(child, pid) {
  if (process.platform === 'win32') {
    for (const target of [child.pid, pid]) {
      if (target) spawnSync('taskkill', ['/PID', String(target), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
    return;
  }
  for (const target of [child.pid, pid]) {
    try {
      if (target) process.kill(target, 'SIGKILL');
    } catch {
      /* déjà terminée */
    }
  }
}

// --- Vérification ----------------------------------------------------------------

/**
 * @param {string[]} argv arguments de la ligne de commande
 * @param {{ capture?: typeof captureScreen }} [tools] `capture` : capture de l'écran (remplacée par les tests)
 * @returns {Promise<number>} code de sortie : 0 = lancement conforme
 */
export async function main(argv, { capture = captureScreen } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

  const separator = argv.indexOf('--');
  const own = separator < 0 ? argv : argv.slice(0, separator);
  const extraArgs = separator < 0 ? [] : argv.slice(separator + 1);
  // Si une option est répétée, la dernière l'emporte.
  const option = (name) => own.findLast((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const target = own.find((arg) => !arg.startsWith('--'));

  let exe;
  if (target === 'electron') {
    try {
      // Le paquet « electron » exporte le chemin de son programme.
      exe = createRequire(import.meta.url)('electron');
    } catch {
      exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
    }
  } else {
    exe = path.resolve(target ?? path.join(root, 'dist', `Evolve-${pkg.version}-portable.exe`));
  }
  const outDir = path.resolve(option('out') ?? path.join(root, 'self-test-output', 'lancement'));
  const timeoutSeconds = Number(option('timeout') ?? 120);
  const closeTimeoutSeconds = Number(option('close-timeout') ?? 60);
  const observeSeconds = Number(option('observe') ?? 1);
  const expectFullscreen = !extraArgs.includes('--windowed');
  const statusFile = path.join(outDir, 'etat.json');
  /** Image dessinée par l'application, enregistrée par elle à côté de son compte rendu. */
  const renderFile = path.join(outDir, 'etat.png');
  const screenFile = path.join(outDir, 'ecran.png');
  // Chemin court si l'exécutable se trouve dans le projet.
  const relative = path.relative(root, exe);
  const name = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : exe;

  /** Lignes du compte rendu : contrôles [réussite, texte], informations, avertissements. */
  const lines = [];
  const notes = [];
  const warnings = [];
  const pass = (text) => lines.push([true, text]);
  const fail = (text) => lines.push([false, text]);

  const finish = () => {
    const failed = lines.some(([ok]) => !ok);
    const body = [
      ...lines.map(([ok, text]) => `${ok ? '✔' : '✖'} ${text}`),
      ...notes.map((text) => `· ${text}`),
      ...warnings.map((text) => `! ${text}`),
    ];
    console.log(`Lancement normal de ${name}\n`);
    for (const text of body) console.log(`  ${text}`);
    console.log(failed ? "\n✖ Lancement non conforme : l'exécutable ne doit pas être distribué." : '\n✔ Lancement normal conforme.');

    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(annotation(failed ? 'error' : 'notice', `Lancement normal — ${path.basename(exe)}`, body.join('\n').slice(0, 3500)));
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          [`### ${failed ? '❌' : '✅'} Lancement normal de l'exécutable (comme un double-clic)`, '', ...body.map((text) => `- ${text}`), '', ''].join('\n'),
        );
      } catch {
        /* le résumé est facultatif */
      }
    }
    return failed ? 1 : 0;
  };

  for (const [value, text] of [
    [timeoutSeconds, option('timeout')],
    [closeTimeoutSeconds, option('close-timeout')],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      fail(`délai invalide : ${text}`);
      return finish();
    }
  }
  if (!Number.isFinite(observeSeconds) || observeSeconds < 0) {
    fail(`durée d'observation invalide : ${option('observe')}`);
    return finish();
  }
  const closeTimeoutMs = closeTimeoutSeconds * 1000;
  if (!existsSync(exe)) {
    fail(`exécutable introuvable : ${exe}`);
    return finish();
  }

  // Un ancien compte rendu ne doit jamais pouvoir être pris pour celui du jour.
  mkdirSync(outDir, { recursive: true });
  for (const file of [statusFile, `${statusFile}.tmp`, renderFile, screenFile]) rmSync(file, { force: true });

  // Dossiers de travail déjà présents : ils ne sont pas ceux de ce lancement.
  // Windows désigne le dossier temporaire par plusieurs variables, et parfois
  // sous deux écritures (nom long ou abrégé) : seuls les noms sont retenus.
  const temporaryDirs = [...new Set([tmpdir(), process.env.TMP, process.env.TEMP].filter(Boolean))];
  const earlierLauncherDirs = new Set(temporaryDirs.flatMap((dir) => launcherDirs(dir)).map((dir) => path.basename(dir).toLowerCase()));

  // --- 1. Lancement, comme un double-clic ---------------------------------------
  const started = Date.now();
  const child = spawn(exe, [...extraArgs, `--status-file=${statusFile}`], { cwd: root, stdio: 'ignore', windowsHide: false });
  /** @type {{ code: number|null, signal: string|null, error?: Error } | null} */
  let exited = null;
  child.on('error', (error) => {
    exited = { code: null, signal: null, error };
  });
  child.on('exit', (code, signal) => {
    exited ??= { code, signal };
  });
  const describeExit = () => (exited.error ? exited.error.message : `code ${exited.code ?? exited.signal}`);

  const deadline = started + timeoutSeconds * 1000;
  while (!existsSync(statusFile) && !exited && Date.now() < deadline) await sleep(100);

  if (!existsSync(statusFile)) {
    if (exited) {
      // Une seule instance d'Evolve à la fois : un second lancement rend la main aussitôt, sans erreur.
      const hint = exited.code === 0 ? " — Evolve est peut-être déjà ouvert : fermez-le avant de relancer la vérification" : '';
      fail(`l'application s'est terminée (${describeExit()}) avant d'avoir démarré son interface${hint}`);
    } else {
      forceKill(child, null);
      fail(`l'application n'a pas signalé son démarrage en ${timeoutSeconds} s : elle a été arrêtée`);
    }
    return finish();
  }
  const reportedAfter = ((Date.now() - started) / 1000).toFixed(1);

  let status;
  try {
    status = JSON.parse(readFileSync(statusFile, 'utf8'));
  } catch (error) {
    forceKill(child, null);
    fail(`compte rendu de l'application illisible : ${error.message}`);
    return finish();
  }
  const pid = Number.isInteger(status?.pid) ? status.pid : null;

  // --- 2. État de la fenêtre -----------------------------------------------------
  const problems = statusProblems(status, { expectFullscreen });
  if (status?.ready === true) pass(`interface démarrée (état signalé ${reportedAfter} s après le lancement)`);
  if (problems.length === 0) {
    const { bounds, display } = status;
    pass(
      `fenêtre visible, ${expectFullscreen ? 'en plein écran' : 'en mode fenêtré'} : ` +
        `${bounds.width} × ${bounds.height} sur un écran de ${display.width} × ${display.height}`,
    );
  }
  for (const problem of problems) fail(problem);

  // --- 3. Espace temporaire de l'exécutable portable ------------------------------
  // L'exécutable portable se décompresse dans un dossier de nom fixe ; son
  // lanceur travaille dans un second dossier, apparu depuis le lancement.
  const programDir = typeof status?.executable === 'string' ? path.dirname(status.executable) : '';
  /** Dossiers temporaires de ce lancement, à voir disparaître à la fermeture. */
  const tempFolders = [];
  if (path.basename(programDir) === pkg.build.portable.unpackDirName) {
    // Le lanceur travaille dans le même dossier temporaire que le programme.
    const fresh = launcherDirs(path.dirname(programDir)).filter((dir) => !earlierLauncherDirs.has(path.basename(dir).toLowerCase()));
    tempFolders.push(programDir, ...fresh);
    const usages = tempFolders.map((dir) => ({ dir, ...folderUsage(dir) }));
    const total = usages.reduce((sum, usage) => sum + usage.bytes, 0);
    notes.push(
      `espace temporaire occupé pendant le fonctionnement : ${formatSize(total)} ` +
        `(${usages.map((usage) => `${path.basename(usage.dir)} : ${formatSize(usage.bytes)}`).join(' ; ')})`,
    );
  }

  // --- 4. L'application reste ouverte ; ce que montre réellement l'écran ----------
  // Ce délai laisse aussi l'affichage se stabiliser avant la capture.
  await sleep(observeSeconds * 1000);
  if (!exited) {
    const screen = capture(screenFile);
    if (screen.unavailable) {
      warnings.push(`écran non capturé : ${screen.unavailable}`);
    } else if (!expectFullscreen) {
      notes.push("mode fenêtré : l'écran a été capturé, sans comparaison avec l'image dessinée par l'application");
    } else if (typeof status?.capture !== 'string') {
      warnings.push("l'application n'a pas enregistré l'image qu'elle dessine : l'écran capturé n'a pas pu lui être comparé");
    } else if (status.display?.x !== 0 || status.display?.y !== 0) {
      // Seul l'écran principal (origine 0, 0) est capturé.
      warnings.push("la fenêtre est affichée sur un écran secondaire : la capture de l'écran principal n'a pas été comparée");
    } else {
      // Dimensions réelles de l'écran : celles vues par l'application, multipliées par l'agrandissement de Windows.
      const scale = Number.isFinite(status.display.scaleFactor) && status.display.scaleFactor > 0 ? status.display.scaleFactor : 1;
      const expected = { width: Math.round(status.display.width * scale), height: Math.round(status.display.height * scale) };
      // La fenêtre au premier plan est-elle celle de l'application ?
      const foreground = screen.foregroundPid === null || !pid ? null : screen.foregroundPid === pid;
      if (foreground === true) notes.push("fenêtre au premier plan pendant la capture : celle de l'application");
      else if (foreground === false) {
        notes.push(
          screen.foregroundPid === 0
            ? 'aucune fenêtre au premier plan pendant la capture'
            : `fenêtre au premier plan pendant la capture : « ${screen.foregroundTitle} » (processus ${screen.foregroundPid}), et non celle de l'application`,
        );
      }
      try {
        const { level, text } = screenReport(screen.bytes, readFileSync(status.capture), { foreground, expected });
        if (level === 'pass') pass(text);
        else if (level === 'warn') warnings.push(text);
        else fail(text);
      } catch (error) {
        warnings.push(`comparaison de l'écran impossible : ${error.message}`);
      }
    }
  }
  if (exited) {
    fail(`l'application s'est fermée toute seule (${describeExit()})`);
    return finish();
  }

  // --- 5. Fermeture sur demande ----------------------------------------------------
  if (!pid) {
    forceKill(child, null);
    fail("le compte rendu n'indique pas le processus de l'application : fermeture normale impossible à vérifier");
    return finish();
  }

  const closing = Date.now();
  const answer = requestClose(pid);
  while (!exited && Date.now() - closing < closeTimeoutMs) await sleep(100);
  if (!exited) {
    forceKill(child, pid);
    fail(
      `l'application ne s'est pas fermée en ${closeTimeoutSeconds} s après la demande de fermeture : elle a été arrêtée` +
        (answer ? ` (réponse du système : ${answer})` : ''),
    );
    return finish();
  }
  if (exited.code === 0) pass(`fermeture normale en ${((Date.now() - closing) / 1000).toFixed(1)} s (code de sortie 0)`);
  else fail(`fermeture avec un code de sortie anormal (${describeExit()})`);

  // --- 6. Fichiers temporaires après la fermeture ----------------------------------
  // Leur suppression dépend du lanceur de l'exécutable portable, qui n'insiste
  // pas si Windows retient encore un fichier : un reste est signalé, sans être
  // une erreur (il est remplacé au lancement suivant).
  if (tempFolders.length > 0) {
    const cleaning = Date.now();
    const remaining = () => tempFolders.filter((dir) => existsSync(dir));
    while (remaining().length > 0 && Date.now() - cleaning < Math.min(closeTimeoutMs, CLEANUP_TIMEOUT_MS)) await sleep(100);
    const left = remaining();
    if (left.length === 0) {
      pass(`fichiers temporaires supprimés à la fermeture (${tempFolders.map((dir) => path.basename(dir)).join(', ')})`);
    } else {
      const details = left.map((dir) => {
        const { files, bytes } = folderUsage(dir);
        return `${dir} (${files} fichier${files > 1 ? 's' : ''}, ${formatSize(bytes)})`;
      });
      warnings.push(`fichiers temporaires encore présents après la fermeture : ${details.join(' ; ')}`);
    }
  }

  // --- 7. Ce que l'application conserve sur le PC ----------------------------------
  // Son seul dossier de données : le cache du moteur d'affichage.
  if (typeof status?.userData === 'string' && existsSync(status.userData)) {
    const { files, bytes } = folderUsage(status.userData);
    notes.push(`données conservées après la fermeture : ${status.userData} (${files} fichier${files > 1 ? 's' : ''}, ${formatSize(bytes)})`);
  }

  return finish();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}

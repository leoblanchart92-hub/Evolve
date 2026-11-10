'use strict';

/**
 * Evolve — Compte rendu de démarrage (`--status-file=FICHIER`).
 *
 * Utilisé par la compilation automatique (scripts/check-launch.mjs) pour
 * vérifier le lancement normal de l'exécutable, tel qu'un double-clic le
 * provoque : une fois l'interface démarrée, l'état de la fenêtre — visible,
 * en plein écran, dimensions — est écrit dans FICHIER, et l'image dessinée
 * par l'application est enregistrée à côté (même nom, extension .png). Le
 * script la compare à ce que l'écran affiche réellement.
 *
 * Sans cette option, l'application n'écrit aucun compte rendu.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Durées, en millisecondes (réduites par les tests unitaires). */
const DEFAULT_TIMINGS = Object.freeze({
  /** Attente maximale du démarrage de l'interface. */
  ready: 60_000,
  /** Intervalle entre deux interrogations de la page. */
  poll: 250,
  /** Attente maximale d'une réponse de la page. */
  response: 5_000,
  /**
   * Pause avant le relevé : la fenêtre finit de s'afficher (plein écran), les
   * animations d'entrée se terminent et la notification de bienvenue apparaît.
   */
  settle: 2_500,
});

/** Code exécuté dans la page : l'interface a-t-elle remplacé l'écran de démarrage ? */
const READY_CODE = `document.documentElement.classList.contains('is-ready')`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Borne la durée d'une opération : rejette au-delà de `ms` millisecondes. */
function withTimeout(promise, ms) {
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('aucune réponse de la page')), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/** Chemin de l'image enregistrée à côté du compte rendu `file` : même nom, extension .png. */
function captureFileFor(file) {
  const base = path.basename(file, path.extname(file));
  const capture = path.join(path.dirname(file), `${base}.png`);
  return capture === file ? `${file}.png` : capture;
}

/**
 * Attend le démarrage de l'interface, puis écrit l'état de la fenêtre.
 *
 * @param {import('electron').BrowserWindow} win
 * @param {object} options
 * @param {string} options.file fichier du compte rendu
 * @param {import('electron').Screen} options.screen
 * @param {string} [options.userData] dossier des données de l'application, cité dans le compte rendu
 * @param {() => object} [options.describeServices] état des services d'Evolve (emplacement des réglages…)
 * @param {Partial<typeof DEFAULT_TIMINGS>} [options.timings]
 * @returns {Promise<object>} l'état écrit dans le fichier
 */
async function reportStatus(win, { file, screen, userData, describeServices = null, timings = {} }) {
  const t = { ...DEFAULT_TIMINGS, ...timings };
  const started = Date.now();
  const { webContents } = win;
  const errors = [];

  webContents.on('console-message', (event, legacyLevel, legacyMessage) => {
    // Electron récent : détails portés par l'événement ; ancien : arguments.
    const level = typeof event?.level === 'string' ? event.level : ['debug', 'info', 'warning', 'error'][legacyLevel];
    const message = typeof event?.message === 'string' ? event.message : legacyMessage;
    if (level === 'error') errors.push(`console : ${message}`);
  });
  webContents.on('did-fail-load', (_event, code, description, url) => {
    errors.push(`échec de chargement (${code} ${description}) : ${url}`);
  });
  webContents.on('render-process-gone', (_event, details) => {
    errors.push(`processus de rendu interrompu : ${details?.reason}`);
  });

  let ready = false;
  const deadline = started + t.ready;
  while (!ready && !win.isDestroyed() && Date.now() < deadline) {
    try {
      ready = (await withTimeout(webContents.executeJavaScript(READY_CODE, true), t.response)) === true;
    } catch {
      ready = false;
    }
    if (!ready) await sleep(t.poll);
  }
  if (!win.isDestroyed()) await sleep(t.settle);

  const status = {
    ready,
    closed: win.isDestroyed(),
    visible: false,
    fullscreen: false,
    minimized: false,
    focused: false,
    title: null,
    bounds: null,
    display: null,
    /** Image dessinée par l'application (chemin du fichier .png), si elle a pu être relevée. */
    capture: null,
    startupMs: Date.now() - started,
    pid: process.pid,
    executable: process.execPath,
    /** Dossier où l'application conserve ses données (cache du moteur d'affichage). */
    userData: typeof userData === 'string' ? userData : null,
    /** Services d'Evolve : inventaire, état, emplacement du fichier des réglages. */
    services: null,
    versions: {
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
    },
    errors,
  };

  if (!status.closed) {
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    Object.assign(status, {
      visible: win.isVisible(),
      fullscreen: win.isFullScreen(),
      minimized: win.isMinimized(),
      focused: win.isFocused(),
      title: win.getTitle(),
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      display: { ...display.bounds, scaleFactor: display.scaleFactor },
    });
  }

  if (describeServices) {
    try {
      status.services = describeServices();
    } catch (error) {
      errors.push(`état des services indisponible : ${error?.message}`);
    }
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });

  // L'image est enregistrée avant le compte rendu, qui signale la fin du relevé.
  if (!status.closed) {
    try {
      const image = await withTimeout(webContents.capturePage(), t.response);
      const png = image.toPNG();
      if (png.length > 0) {
        const captureFile = captureFileFor(file);
        fs.writeFileSync(captureFile, png);
        status.capture = captureFile;
      }
    } catch {
      /* facultatif : le compte rendu indique alors qu'aucune image n'a été relevée */
    }
  }

  // Écriture en deux temps : le fichier n'apparaît qu'une fois complet.
  const draft = `${file}.tmp`;
  fs.writeFileSync(draft, `${JSON.stringify(status, null, 2)}\n`);
  fs.renameSync(draft, file);
  return status;
}

module.exports = { reportStatus, captureFileFor, DEFAULT_TIMINGS, READY_CODE };

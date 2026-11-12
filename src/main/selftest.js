'use strict';

/**
 * Evolve — Auto-test de l'application (`--self-test[=DOSSIER]`).
 *
 * Utilisé par la compilation automatique (GitHub Actions) pour vérifier, sur
 * un vrai Windows, que l'exécutable démarre et que l'interface répond :
 * chargement sans erreur, fond d'écran officiel, barre des tâches, menu
 * Démarrer, panneaux, fenêtres, explorateur de fichiers — qui parcourt de
 * vrais dossiers, en lecture seule (voir selftest-explorer.js).
 *
 * Il écrit un rapport (result.json) et des captures d'écran dans DOSSIER,
 * puis renvoie 0 (tout est conforme) ou 1 (au moins un contrôle en échec).
 *
 * Scénarios (`--self-test-scenario=NOM`) :
 *   full             contrôle complet de l'interface (par défaut) ;
 *   settings-write   modifie des réglages depuis l'interface ;
 *   settings-read    vérifie, après un nouveau lancement, que l'interface les
 *                    a retrouvés (voir selftest-settings.js) ;
 *   documents-missing  sur une machine dont le dossier Documents a été mis de
 *                    côté : l'explorateur l'annonce comme introuvable, sans
 *                    rien créer (voir selftest-documents.js).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { documentsScenarios } = require('./selftest-documents');
const { checkExplorer } = require('./selftest-explorer');
const { settingsScenarios } = require('./selftest-settings');

/** Scénario exécuté quand aucun n'est demandé. */
const DEFAULT_SCENARIO = 'full';

/** Durées de l'auto-test, en millisecondes (réduites par les tests unitaires). */
const DEFAULT_TIMINGS = Object.freeze({
  /** Durée maximale de l'auto-test complet. */
  total: 180_000,
  /** Attente maximale du démarrage de l'interface. */
  ready: 45_000,
  /** Attente maximale de l'état vérifié par un contrôle. */
  check: 10_000,
  /** Attente maximale d'une réponse de la page ou d'une capture d'écran. */
  response: 15_000,
  /** Intervalle entre deux essais d'un même contrôle. */
  poll: 150,
  /** Pause avant une capture d'écran (fin des animations). */
  settle: 800,
});

/** Fond d'écran officiel : fichier embarqué, dimensions et empreinte de l'image fournie. */
const WALLPAPER = Object.freeze({
  name: 'panorama-cosmique-violet-sur-lac-miroir.png',
  file: path.join(__dirname, '..', '..', 'assets', 'wallpapers', 'panorama-cosmique-violet-sur-lac-miroir.png'),
  width: 1672,
  height: 941,
  sha256: '13756eda633dcf18a16579202ad04354312f42449f09d1c7f6428b4fb8b32e53',
});

/**
 * Nombre minimal de couleurs distinctes (voir `countColors`) de la capture du
 * bureau : le fond d'écran et l'interface en produisent plusieurs centaines,
 * une fenêtre restée vide une seule.
 */
const MIN_CAPTURE_COLORS = 32;

/**
 * Fragment de code exécuté dans la page : `inView(élément)` indique si un
 * panneau est affiché en entier à l'intérieur de la fenêtre.
 */
const IN_VIEW = `const inView = (el) => {
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && box.top >= -0.5 && box.left >= -0.5
    && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5;
};`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Nombre de couleurs distinctes d'une image, estimé sur un échantillon de
 * points répartis sur toute sa surface. Les nuances très proches sont
 * confondues (16 niveaux par composante).
 * @param {Uint8Array} bitmap pixels bruts, 4 octets par point
 */
function countColors(bitmap, samples = 4096) {
  const pixels = Math.floor(bitmap.length / 4);
  if (pixels === 0) return 0;
  // Pas impair : évite de ne relire que quelques colonnes d'une image de largeur paire.
  const step = Math.max(1, Math.floor(pixels / samples)) | 1;
  const colors = new Set();
  for (let index = 0; index < pixels; index += step) {
    const offset = index * 4;
    colors.add(((bitmap[offset] >> 4) << 8) | ((bitmap[offset + 1] >> 4) << 4) | (bitmap[offset + 2] >> 4));
  }
  return colors.size;
}

/** Borne la durée d'une opération : rejette avec `message` au-delà de `ms`. */
function withTimeout(promise, ms, message) {
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {object} options
 * @param {string} options.outDir  dossier du rapport et des captures d'écran
 * @param {Partial<typeof DEFAULT_TIMINGS>} [options.timings]
 * @param {string} [options.scenario]  scénario à exécuter (voir l'en-tête)
 * @param {() => object} [options.describeServices]  état des services d'Evolve, joint au rapport
 * @param {string} [options.platform]  système sur lequel l'application s'exécute
 * @returns {Promise<number>} code de sortie : 0 = réussite, 1 = échec
 */
async function runSelfTest(win, { outDir, timings = {}, scenario: scenarioName = DEFAULT_SCENARIO, describeServices = null, platform = process.platform }) {
  const started = Date.now();
  const { webContents } = win;
  const t = { ...DEFAULT_TIMINGS, ...timings };

  const report = {
    ok: false,
    scenario: scenarioName,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    platform: `${process.platform} ${process.arch}`,
    executable: process.execPath,
    versions: {
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
      node: process.versions.node,
    },
    window: null,
    checks: [],
    errors: [],
    warnings: [],
    captures: [],
    /** Dimensions et nombre de couleurs de chaque capture (voir `countColors`). */
    images: [],
    /** Inventaire et état des services d'Evolve à la fin du test. */
    services: null,
    /** Dossiers personnels et lecteurs que l'explorateur a trouvés sur cette machine. */
    explorer: null,
  };

  fs.mkdirSync(outDir, { recursive: true });

  // --- Collecte des erreurs ----------------------------------------------------
  webContents.on('console-message', (event, legacyLevel, legacyMessage) => {
    // Electron récent : détails portés par l'événement ; ancien : arguments.
    const level = typeof event?.level === 'string' ? event.level : ['debug', 'info', 'warning', 'error'][legacyLevel];
    const message = typeof event?.message === 'string' ? event.message : legacyMessage;
    if (level === 'error') report.errors.push(`console : ${message}`);
    else if (level === 'warning') report.warnings.push(String(message));
  });
  // Après une erreur fatale, l'état attendu n'arrivera plus : inutile de patienter.
  let fatal = false;
  webContents.on('did-fail-load', (_event, code, description, url) => {
    fatal = true;
    report.errors.push(`échec de chargement (${code} ${description}) : ${url}`);
  });
  webContents.on('preload-error', (_event, preloadPath, error) => {
    report.errors.push(`erreur du script de préchargement ${preloadPath} : ${error?.message}`);
  });
  webContents.on('render-process-gone', (_event, details) => {
    fatal = true;
    report.errors.push(`processus de rendu interrompu : ${details?.reason}`);
  });

  /** Exécute du code dans la page et renvoie sa valeur. */
  const evaluate = (code) =>
    withTimeout(
      webContents.executeJavaScript(`(async () => { ${code} })()`, true),
      t.response,
      `aucune réponse de la page en ${t.response / 1000} s`,
    );

  /** Effectue une action dans la page (clic, saisie…). */
  const act = async (code) => {
    try {
      await evaluate(code);
    } catch (error) {
      report.errors.push(`action impossible : ${error?.message}`);
    }
  };

  /** Inscrit le résultat d'un contrôle au rapport ; seul `true` est une réussite. */
  const record = (name, value) => {
    const ok = value === true;
    report.checks.push(ok ? { name, ok } : { name, ok, value: value ?? null });
    return ok;
  };

  /**
   * Attend que `code` renvoie `true` dans la page (les animations, une lecture
   * du disque ou une machine lente peuvent retarder l'état attendu). Renvoie
   * la dernière valeur obtenue.
   */
  const until = async (code, { timeout = t.check } = {}) => {
    const deadline = Date.now() + timeout;
    let value;
    for (;;) {
      try {
        value = await evaluate(code);
      } catch (error) {
        value = `exception : ${error?.message}`;
      }
      if (value === true || fatal || Date.now() >= deadline) break;
      await sleep(t.poll);
    }
    return value;
  };

  /** Contrôle : l'état attendu doit apparaître dans la page (voir `until`). */
  const check = async (name, code, options) => record(name, await until(code, options));

  /**
   * Mesure une capture : dimensions et nombre de couleurs. Facultative —
   * renvoie `null` si l'image ne peut pas être lue point par point.
   */
  const measure = (name, image) => {
    try {
      const [scaleFactor = 1] = image.getScaleFactors();
      const { width, height } = image.getSize(scaleFactor);
      const colors = countColors(image.toBitmap({ scaleFactor }));
      if (colors === 0) return null;
      const stats = { file: `${name}.png`, width: Math.round(width * scaleFactor), height: Math.round(height * scaleFactor), colors };
      report.images.push(stats);
      return stats;
    } catch {
      return null;
    }
  };

  /**
   * Capture d'écran de la fenêtre (après la fin des animations).
   * @returns {Promise<{file: string, width: number, height: number, colors: number} | null>}
   */
  const capture = async (name) => {
    await sleep(t.settle);
    try {
      const image = await withTimeout(win.capturePage(), t.response, `aucune image en ${t.response / 1000} s`);
      if (image.isEmpty()) {
        report.warnings.push(`capture « ${name} » vide`);
        return null;
      }
      fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
      report.captures.push(`${name}.png`);
      return measure(name, image);
    } catch (error) {
      report.warnings.push(`capture « ${name} » impossible : ${error?.message}`);
      return null;
    }
  };

  /**
   * Début commun à tous les scénarios : la fenêtre s'affiche et l'écran de
   * démarrage laisse place au bureau. Renvoie faux si l'interface ne démarre pas.
   */
  const begin = async () => {
    win.show();
    const ready = await check("l'interface a démarré", `return document.documentElement.classList.contains('is-ready');`, {
      timeout: t.ready,
    });
    if (ready) {
      const bounds = win.getContentBounds();
      report.window = { width: bounds.width, height: bounds.height };
    }
    return ready;
  };

  const scenario = async () => {
    // 1. L'interface démarre.
    if (!(await begin())) return;

    // 2. Fond d'écran : le fichier embarqué est l'image fournie, à l'octet près,
    //    et l'interface l'affiche sans la déformer ni la retoucher.
    let digest;
    try {
      digest = crypto.createHash('sha256').update(fs.readFileSync(WALLPAPER.file)).digest('hex');
    } catch (error) {
      digest = `lecture impossible : ${error?.message}`;
    }
    record("fond d'écran embarqué identique à l'image fournie (empreinte SHA-256)", digest === WALLPAPER.sha256 || { sha256: digest });
    await check(
      "fond d'écran officiel affiché sans déformation ni filtre",
      `const img = document.getElementById('wallpaper');
       const style = getComputedStyle(img);
       const source = decodeURIComponent(img.currentSrc || img.src);
       const ok = img.complete && img.naturalWidth === ${WALLPAPER.width} && img.naturalHeight === ${WALLPAPER.height}
         && source.endsWith('/assets/wallpapers/${WALLPAPER.name}')
         && style.objectFit === 'cover' && style.filter === 'none' && style.opacity === '1';
       return ok || { complete: img.complete, width: img.naturalWidth, height: img.naturalHeight, source,
         objectFit: style.objectFit, filter: style.filter, opacity: style.opacity };`,
    );

    // 3. Éléments de l'environnement.
    await check(
      "passerelle de l'application de bureau (quitter, plein écran)",
      `return window.evolve?.isDesktopApp === true && typeof window.evolve.quit === 'function'
         && typeof window.evolve.toggleFullscreen === 'function';`,
    );
    // La page atteint la couche de services, qui contrôle ce qu'elle demande.
    await check(
      "services d'Evolve joignables depuis l'interface (réglages)",
      `const values = await window.evolve.services.call('settings', 'getAll');
       const refused = await window.evolve.services.call('settings', 'set', 'reglage.inconnu', true);
       return (values.ok === true && typeof values.value['quick.volume'] === 'number'
         && refused.ok === false && refused.code === 'unknown-key') || { values, refused };`,
    );
    await check(
      'polices embarquées chargées',
      `await document.fonts.ready;
       const faces = [...document.fonts].map((face) => ({ family: face.family.replace(/["']/g, ''), status: face.status }));
       const loaded = (family) => faces.some((face) => face.family === family && face.status === 'loaded');
       const failed = faces.filter((face) => face.status === 'error');
       return (loaded('Inter Variable') && loaded('Outfit Variable') && failed.length === 0) || faces;`,
    );
    await check('icônes du bureau', `return document.querySelectorAll('.desktop-icon').length >= 5;`);
    await check(
      'barre des tâches (Démarrer, recherche, applications, horloge)',
      `const bar = document.getElementById('taskbar').getBoundingClientRect();
       return bar.width > 300 && bar.height > 20 && Boolean(document.querySelector('.tb-start'))
         && Boolean(document.querySelector('.tb-search')) && document.querySelectorAll('.tb-app').length >= 5
         && /^\\d{2}:\\d{2}$/.test(document.querySelector('.tb-clock__time').textContent.trim());`,
    );
    await check(
      'widgets CPU, RAM et GPU signalés comme données de démonstration',
      `const cards = [...document.querySelectorAll('.widget.hw')];
       return cards.length === 3 && cards.every((card) => card.querySelector('.chip--demo'));`,
    );
    await check(
      "aucun débordement de la page (pas de barre de défilement parasite)",
      `const root = document.documentElement;
       return root.scrollWidth <= innerWidth && root.scrollHeight <= innerHeight
         || { scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight, innerWidth, innerHeight };`,
    );
    // La page peut se croire affichée alors que la fenêtre est restée vide :
    // la capture du bureau doit montrer une image réelle, pas un aplat uni.
    const desktop = await capture('01-bureau');
    if (desktop) {
      record("l'interface est réellement dessinée dans la fenêtre (capture d'écran non unie)", desktop.colors >= MIN_CAPTURE_COLORS || desktop);
    }

    // 4. Menu Démarrer et recherche.
    await act(`document.querySelector('.tb-start').click();`);
    await check(
      "le menu Démarrer s'ouvre avec sa grille d'applications",
      `${IN_VIEW}
       const start = document.querySelector('.start');
       return start.classList.contains('is-open') && inView(start) && document.querySelectorAll('.start-app').length >= 12;`,
    );
    await check(
      "la vue d'accueil du menu Démarrer est entièrement visible (sans défilement)",
      `const home = document.querySelector('.start__view--home');
       return home.scrollHeight <= home.clientHeight || { scrollHeight: home.scrollHeight, clientHeight: home.clientHeight };`,
    );
    await capture('02-menu-demarrer');
    await act(
      `const input = document.querySelector('.searchbox__input');
       input.value = 'doc';
       input.dispatchEvent(new Event('input', { bubbles: true }));`,
    );
    await check('la recherche propose des résultats', `return document.querySelectorAll('.start__view--search .start-row').length > 0;`);
    await capture('03-recherche');
    await act(`document.querySelector('.tb-start').click();`);
    await check('le menu Démarrer se ferme', `return !document.querySelector('.start').classList.contains('is-open');`);

    // 5. Paramètres rapides et centre de notifications.
    await act(`document.querySelector('.tb-tray').click();`);
    await check(
      "le panneau des paramètres rapides s'ouvre",
      `${IN_VIEW}
       const panel = document.querySelector('.qs');
       return panel.classList.contains('is-open') && inView(panel) && document.querySelectorAll('.qs-tile').length >= 6;`,
    );
    await capture('04-parametres-rapides');
    await act(`document.querySelector('.tb-clock').click();`);
    await check(
      "le centre de notifications s'ouvre avec son calendrier",
      `${IN_VIEW}
       const panel = document.querySelector('.nc');
       return panel.classList.contains('is-open') && inView(panel) && !document.querySelector('.qs').classList.contains('is-open')
         && document.querySelectorAll('.cal__day').length === 42;`,
    );
    await capture('05-notifications');
    await act(`document.querySelector('.tb-clock').click();`);
    await check('le centre de notifications se ferme', `return !document.querySelector('.nc').classList.contains('is-open');`);

    // 6. Fenêtres et explorateur de fichiers.
    await act(`document.querySelector('.tb-app[data-app="explorer"]').click();`);
    await check(
      "l'explorateur de fichiers s'ouvre dans une fenêtre",
      `${IN_VIEW}
       const win = document.querySelector('.window[data-app="explorer"]');
       return Boolean(win) && win.classList.contains('is-focused') && inView(win) && win.querySelectorAll('.ex-item').length > 0
         && document.querySelector('.tb-app[data-app="explorer"]').classList.contains('is-active');`,
    );
    // Vrais dossiers, navigation, refus du service, lecture seule (capture 06 comprise).
    await checkExplorer({ check, act, until, evaluate, record, capture, report, outDir, describeServices, platform });
    await act(`document.querySelector('.window[data-app="explorer"] .window__control--max').click();`);
    await check(
      "la fenêtre s'agrandit sur tout l'espace de travail",
      `const win = document.querySelector('.window[data-app="explorer"]');
       return win.classList.contains('is-maximized') && Math.abs(win.getBoundingClientRect().width - innerWidth) < 2;`,
    );
    await act(`document.querySelector('.window[data-app="explorer"] .window__control--max').click();`);
    await check(
      'la fenêtre retrouve sa taille',
      `const win = document.querySelector('.window[data-app="explorer"]');
       return !win.classList.contains('is-maximized') && win.getBoundingClientRect().width < innerWidth - 2;`,
    );
    await act(`document.querySelector('.tb-app[data-app="settings"]').click();`);
    await check(
      'plusieurs fenêtres coexistent, la dernière ouverte au premier plan',
      `const wins = [...document.querySelectorAll('.window')];
       return wins.length === 2 && document.querySelector('.window[data-app="settings"]').classList.contains('is-focused')
         && !document.querySelector('.window[data-app="explorer"]').classList.contains('is-focused');`,
    );
    await capture('07-fenetres');
    await act(`document.querySelector('.window[data-app="settings"] .window__control--min').click();`);
    await check(
      'une fenêtre se réduit dans la barre des tâches',
      `return document.querySelector('.window[data-app="settings"]').hidden
         && document.querySelector('.tb-app[data-app="settings"]').classList.contains('is-running');`,
    );
    await act(`document.querySelectorAll('.window .window__control--close').forEach((button) => button.click());`);
    await check('les fenêtres se ferment', `return document.querySelectorAll('.window').length === 0;`);
  };

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      report.errors.push(`délai dépassé (${t.total / 1000} s)`);
      resolve();
    }, t.total);
  });

  const scenarios = {
    [DEFAULT_SCENARIO]: scenario,
    ...settingsScenarios({ begin, check, act, capture }),
    ...documentsScenarios({ begin, check, act, until, evaluate, record, capture, report }),
  };
  // Un scénario inconnu est un échec : un test qui ne contrôle rien ne doit jamais réussir.
  const selected = Object.hasOwn(scenarios, scenarioName) ? scenarios[scenarioName] : null;
  if (!selected) report.errors.push(`scénario d'auto-test inconnu : ${scenarioName}`);

  try {
    if (selected) await Promise.race([selected(), timeout]);
  } catch (error) {
    report.errors.push(`exception : ${error?.stack ?? error}`);
  } finally {
    clearTimeout(timer);
  }

  if (describeServices) {
    try {
      report.services = describeServices();
    } catch (error) {
      report.warnings.push(`état des services indisponible : ${error?.message}`);
    }
  }

  report.durationMs = Date.now() - started;
  report.ok = report.checks.length > 0 && report.checks.every((item) => item.ok) && report.errors.length === 0;

  try {
    fs.writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(`Impossible d'écrire le rapport : ${error?.message}`);
    return 1;
  }

  return report.ok ? 0 : 1;
}

module.exports = { runSelfTest, countColors, DEFAULT_TIMINGS, DEFAULT_SCENARIO, MIN_CAPTURE_COLORS, WALLPAPER };

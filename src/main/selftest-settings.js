'use strict';

/**
 * Evolve — Auto-test : les réglages survivent à un redémarrage.
 *
 * Deux scénarios, exécutés par deux lancements successifs de l'application
 * sur le même dossier de réglages (voir scripts/check-settings.mjs) :
 *
 *   settings-write   part des valeurs par défaut, modifie des réglages comme
 *                    le ferait l'utilisateur (clics, curseurs), donne une
 *                    nouvelle place à la fenêtre de l'explorateur, puis quitte ;
 *   settings-read    vérifie, sans rien modifier, que l'interface affiche les
 *                    réglages laissés par le lancement précédent, et que la
 *                    fenêtre de l'explorateur s'ouvre où elle avait été laissée.
 *
 * Entre les deux, le script lit lui-même le fichier des réglages : la preuve
 * ne repose pas sur ce que l'application dit d'elle-même.
 *
 * La fenêtre est déplacée par un vrai geste de la souris (voir
 * selftest-input.js). Si la page ne reçoit pas la souris injectée, elle est
 * agrandie depuis son menu : c'est alors son agrandissement, et non sa
 * position, qui est enregistré puis retrouvé — et un avertissement le dit.
 */

const { SETTINGS, defaultsOf } = require('../services/settings-schema');
const { DESKTOP_TOOLS } = require('./selftest-desktop');

/** Réglages modifiés par le premier lancement et attendus au second. */
const CHANGED_SETTINGS = Object.freeze({
  'desktop.widgetsVisible': false,
  'quick.nightLight': true,
  'quick.doNotDisturb': true,
  'quick.brightness': 60,
  'quick.volume': 35,
});

/**
 * Réglages qui retiennent l'emplacement de la fenêtre de l'explorateur :
 * position et taille en centièmes de rem, et agrandissement. Leurs valeurs
 * dépendent de l'écran : elles sont contrôlées une à une (voir
 * `readPlacement`) et comparées à la fenêtre, jamais à des constantes.
 */
const PLACEMENT_SETTINGS = Object.freeze(['explorerWindow.x', 'explorerWindow.y', 'explorerWindow.width', 'explorerWindow.height', 'explorerWindow.maximized']);

/** Valeur de tous les autres réglages après les modifications. */
const EXPECTED_SETTINGS = Object.freeze(
  Object.fromEntries(Object.entries({ ...defaultsOf(SETTINGS), ...CHANGED_SETTINGS }).filter(([key]) => !PLACEMENT_SETTINGS.includes(key))),
);

/**
 * Emplacement de fenêtre relevé parmi des réglages (ceux du fichier, où un
 * réglage resté à sa valeur par défaut peut être absent). Chaque valeur doit
 * être de la nature et dans les bornes de son réglage, et une taille doit
 * être retenue : une largeur ou une hauteur nulle signifie « aucun
 * emplacement ».
 *
 * @param {Record<string, unknown>} values
 * @returns {{ ok: true, placement: { x: number, y: number, width: number, height: number, maximized: boolean } } | { ok: false, problem: string }}
 */
function readPlacement(values) {
  const placement = {};
  for (const key of PLACEMENT_SETTINGS) {
    const definition = SETTINGS[key];
    const value = values && Object.hasOwn(values, key) ? values[key] : definition.default;
    const valid = definition.type === 'boolean' ? typeof value === 'boolean' : Number.isInteger(value) && value >= definition.min && value <= definition.max;
    if (!valid) return { ok: false, problem: `valeur refusée pour « ${key} » : ${JSON.stringify(value)}` };
    placement[key.slice(key.indexOf('.') + 1)] = value;
  }
  if (placement.width <= 0 || placement.height <= 0) {
    return { ok: false, problem: "aucun emplacement n'est retenu pour la fenêtre de l'explorateur (largeur ou hauteur nulle)" };
  }
  return { ok: true, placement };
}

/** Emplacement d'une fenêtre, tel qu'il se lit : « position (x ; y), taille l × h centièmes de rem, agrandie ». */
function describePlacement({ x, y, width, height, maximized }) {
  return `position (${x} ; ${y}), taille ${width} × ${height} centièmes de rem${maximized ? ', agrandie' : ''}`;
}

/**
 * Code exécuté dans la page : `shown()` relève ce que l'interface affiche
 * pour les réglages modifiés ; `same(a, b)` compare deux relevés.
 */
const PAGE_TOOLS = `
  const shown = () => {
    const tile = (id) => document.querySelector('.qs-tile[data-setting="' + id + '"]').getAttribute('aria-pressed') === 'true';
    const slider = (id) => Number(document.querySelector('.qs-slider[data-setting="' + id + '"] input').value);
    return {
      'desktop.widgetsVisible': !document.querySelector('.widgets').classList.contains('is-hidden'),
      'quick.nightLight': tile('nightLight'),
      'quick.doNotDisturb': tile('doNotDisturb'),
      'quick.brightness': slider('brightness'),
      'quick.volume': slider('volume'),
    };
  };
  const same = (actual, expected) => Object.keys(expected).every((key) => actual[key] === expected[key]);
`;

/** Code exécuté dans la page : règle un curseur comme le ferait un glissement. */
const moveSlider = (id, value) => `{
  const input = document.querySelector('.qs-slider[data-setting="${id}"] input');
  input.value = '${value}';
  input.dispatchEvent(new Event('input', { bubbles: true }));
}`;

/**
 * Code exécuté dans la page, en lecture seule : la fenêtre de l'explorateur,
 * sa place dans la zone de travail, et l'emplacement que retient le service
 * des réglages — en centièmes de rem, et converti en pixels pour cet écran.
 */
const PLACEMENT_TOOLS = `
  const pWin = () => document.querySelector('.window[data-app="explorer"]:not(.is-closing)');
  const pBox = (el) => { const box = el.getBoundingClientRect(); return { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) }; };
  const pArea = () => pBox(document.getElementById('windows'));
  const pRect = (el) => { const rect = pBox(el); const area = pArea(); return { x: rect.x - area.x, y: rect.y - area.y, w: rect.w, h: rect.h }; };
  const pIdle = (el) => !['is-dragging', 'is-resizing', 'is-morphing'].some((name) => el.classList.contains(name))
    && el.getAnimations().every((animation) => animation.effect?.target !== el || animation.playState !== 'running');
  const pSame = (a, b, tolerance = 2) => ['x', 'y', 'w', 'h'].every((key) => Math.abs(a[key] - b[key]) <= tolerance);
  const pStored = async () => {
    const reply = await window.evolve.services.call('settings', 'getAll');
    if (reply.ok !== true) return { refus: reply.code ?? null };
    const value = (name) => reply.value['explorerWindow.' + name];
    const units = { x: value('x'), y: value('y'), w: value('width'), h: value('height') };
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const pixels = Object.fromEntries(Object.entries(units).map(([key, amount]) => [key, Math.round((amount * rem) / 100)]));
    const kept = Object.values(units).every(Number.isInteger) && units.w > 0 && units.h > 0 && typeof value('maximized') === 'boolean';
    return { units, pixels, maximized: value('maximized'), kept };
  };
`;

/** Intitulés des contrôles de l'emplacement de la fenêtre. */
const PLACEMENT_CHECKS = Object.freeze({
  untouched: "l'explorateur s'ouvre à sa place habituelle : tant que sa fenêtre n'a été ni déplacée ni agrandie, aucun emplacement n'est retenu",
  moved: "la fenêtre de l'explorateur est déplacée à la souris, par sa barre de titre",
  maximized: "la fenêtre de l'explorateur est agrandie depuis son menu",
  stored: "le service des réglages a reçu l'emplacement donné à la fenêtre",
  restored: "nouveau lancement : la fenêtre de l'explorateur s'ouvre à l'emplacement enregistré",
});

const js = (value) => JSON.stringify(value);
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Déplacement donné à la fenêtre, en pixels, et le plus petit qui vaille d'être tenté. */
const SHIFT = Object.freeze({ x: 64, y: 32, least: 8 });

/**
 * Déplacement à donner à une fenêtre pour qu'elle reste entière dans la zone
 * de travail : au lancement suivant, une fenêtre qui dépasse est ramenée à
 * l'écran — elle ne s'ouvrirait donc pas exactement où elle a été laissée.
 * Vers la droite et vers le bas s'il y a la place ; sinon vers la gauche ;
 * sinon du peu de place qui reste. Jamais vers le haut : glisser une barre de
 * titre contre le haut de l'écran agrandit la fenêtre.
 *
 * @param {{ x: number, y: number, w: number, h: number }} rect  place de la fenêtre dans la zone de travail
 * @param {{ w: number, h: number }} area  taille de la zone de travail
 * @returns {{ dx: number, dy: number }}
 */
function shiftInside(rect, area) {
  const right = Math.max(0, Math.floor(number(area?.w) - number(rect?.x) - number(rect?.w)));
  const left = Math.max(0, Math.floor(number(rect?.x)));
  const below = Math.max(0, Math.floor(number(area?.h) - number(rect?.y) - number(rect?.h)));
  const dx = right >= SHIFT.x ? SHIFT.x : left >= SHIFT.x ? -SHIFT.x : right >= left ? right : -left;
  return { dx, dy: Math.min(SHIFT.y, below) };
}

/** Code exécuté dans la page : le service enregistre réellement dans un fichier, sans incident. */
const STORAGE_OK = `
  const state = await window.evolve.services.call('settings', 'state');
  return (state.ok === true && state.value.storage === 'file' && state.value.durable === true
    && state.value.problem === null && state.value.recovered === null) || state;`;

/**
 * @param {object} tools  outils de l'auto-test (voir selftest.js) ; `input()` crée les gestes de la souris et
 *        du clavier (voir selftest-input.js)
 * @returns {Record<string, () => Promise<void>>} scénarios, par nom
 */
function settingsScenarios({ begin, check, act, capture, until, evaluate, record, report, input }) {
  const defaults = JSON.stringify(Object.fromEntries(Object.keys(CHANGED_SETTINGS).map((key) => [key, SETTINGS[key].default])));
  const changed = JSON.stringify(CHANGED_SETTINGS);
  const expected = JSON.stringify(EXPECTED_SETTINGS);

  /** Valeur d'une expression de page, ou `null` si elle ne peut pas être lue. */
  const read = async (expression) => {
    try {
      return await evaluate(`${PLACEMENT_TOOLS} return (${expression});`);
    } catch {
      return null;
    }
  };

  /** Referme le panneau des paramètres rapides, puis ouvre l'explorateur depuis la barre des tâches. */
  const openExplorer = async () => {
    await act(`document.querySelector('.tb-tray').click();`);
    await until(`return !document.querySelector('.qs').classList.contains('is-open');`);
    await act(`document.querySelector('.tb-app[data-app="explorer"]').click();`);
  };

  /**
   * Premier lancement : la fenêtre de l'explorateur reçoit une nouvelle place — déplacée à la souris, sinon
   * agrandie depuis son menu —, et le service des réglages doit l'avoir retenue.
   */
  const placeWindow = async () => {
    await openExplorer();
    const untouched = await check(
      PLACEMENT_CHECKS.untouched,
      `${PLACEMENT_TOOLS}
       const el = pWin();
       if (!el || !pIdle(el)) return 'fenêtre en cours d’ouverture';
       const stored = await pStored();
       return (!el.classList.contains('is-maximized') && stored.units?.w === 0 && stored.units?.h === 0 && stored.maximized === false)
         || { fenetre: pRect(el), agrandie: el.classList.contains('is-maximized'), retenu: stored };`,
    );
    if (!untouched) return;

    const before = await read('pRect(pWin())');
    const area = await read('pArea()');
    const gestures = input();
    const available = await gestures.prepare();
    report.input = { souris: available.mouse === true, clavier: available.keyboard === true, pageActive: available.focused === true };

    // Du côté où la fenêtre reste entière à l'écran ; sans place d'aucun côté, elle n'est pas déplacée.
    const { dx, dy } = shiftInside(before, area);
    const room = Math.abs(dx) >= SHIFT.least || dy >= SHIFT.least;

    if (available.mouse === true && room) {
      // Par la barre de titre — ni sur son icône, ni sur ses boutons.
      const grip = { x: number(area?.x) + number(before?.x) + Math.min(number(before?.w) * 0.4, 260), y: number(area?.y) + number(before?.y) + 14 };
      const moved = { x: number(before?.x) + dx, y: number(before?.y) + dy, w: number(before?.w), h: number(before?.h) };
      await gestures.drag(grip, { x: grip.x + dx, y: grip.y + dy });
      const placed = await until(
        `${PLACEMENT_TOOLS}
         const el = pWin();
         return (pIdle(el) && !el.classList.contains('is-maximized') && pSame(pRect(el), ${js(moved)}, 0)) || { attendu: ${js(moved)}, fenetre: pRect(el) };`,
      );
      if (!record(PLACEMENT_CHECKS.moved, placed)) return;
      await check(
        PLACEMENT_CHECKS.stored,
        `${PLACEMENT_TOOLS}
         const stored = await pStored();
         return (stored.kept === true && stored.maximized === false && pSame(stored.pixels, ${js(moved)}, 1)) || { attendu: ${js(moved)}, retenu: stored };`,
      );
    } else {
      const reason = available.mouse === true ? 'sans place à sa droite, à sa gauche ni au-dessous, elle ne peut être déplacée sans sortir de la zone de travail' : 'la page ne reçoit pas la souris injectée';
      report.warnings.push(
        `fenêtre de l'explorateur non déplacée : ${reason}. Elle a été agrandie depuis son menu : c'est son agrandissement, et non sa position, qui est enregistré puis retrouvé`,
      );
      await act(`${DESKTOP_TOOLS} dContext(dWins()[0].querySelector('.window__title-text'));`);
      await until(`${DESKTOP_TOOLS} return dMenu() !== null && dMenu().includes('Agrandir');`);
      await act(`${DESKTOP_TOOLS} dMenuPick('Agrandir');`);
      const whole = { x: 0, y: 0, w: number(area?.w), h: number(area?.h) };
      const placed = await until(
        `${PLACEMENT_TOOLS}
         const el = pWin();
         return (pIdle(el) && el.classList.contains('is-maximized') && pSame(pRect(el), ${js(whole)})) || { attendu: ${js(whole)}, fenetre: pRect(el) };`,
      );
      if (!record(PLACEMENT_CHECKS.maximized, placed)) return;
      // Retenus : l'agrandissement, et la place que la fenêtre retrouvera une fois restaurée.
      await check(
        PLACEMENT_CHECKS.stored,
        `${PLACEMENT_TOOLS}
         const stored = await pStored();
         return (stored.kept === true && stored.maximized === true && pSame(stored.pixels, ${js(before)}, 1)) || { attendu: ${js(before)}, retenu: stored };`,
      );
    }
    await capture('02-fenetre-placee');
  };

  return {
    'settings-write': async () => {
      if (!(await begin())) return;

      await check(
        'premier lancement : chaque réglage a sa valeur par défaut',
        `${PAGE_TOOLS} const state = shown(); return same(state, ${defaults}) || state;`,
      );
      await check('les réglages sont enregistrés dans un fichier', STORAGE_OK);

      // Les mêmes gestes que l'utilisateur : bouton des widgets, tuiles, curseurs.
      await act(`document.querySelector('.tb-widgets').click();`);
      await act(`document.querySelector('.tb-tray').click();`);
      await check("le panneau des paramètres rapides s'ouvre", `return document.querySelector('.qs').classList.contains('is-open');`);
      await act(`document.querySelector('.qs-tile[data-setting="nightLight"]').click();`);
      await act(`document.querySelector('.qs-tile[data-setting="doNotDisturb"]').click();`);
      await act(moveSlider('brightness', CHANGED_SETTINGS['quick.brightness']));
      await act(moveSlider('volume', CHANGED_SETTINGS['quick.volume']));

      await check(
        "l'interface affiche les réglages modifiés",
        `${PAGE_TOOLS} const state = shown(); return same(state, ${changed}) || state;`,
      );
      await check(
        'le service des réglages a reçu chaque changement',
        `${PAGE_TOOLS}
         const reply = await window.evolve.services.call('settings', 'getAll');
         return (reply.ok === true && same(reply.value, ${expected})) || reply;`,
      );
      await capture('01-reglages-modifies');

      await placeWindow();
    },

    'settings-read': async () => {
      if (!(await begin())) return;

      await check(
        "nouveau lancement : l'interface affiche les réglages enregistrés, sans aucune action",
        `${PAGE_TOOLS} const state = shown(); return same(state, ${changed}) || state;`,
      );
      await check(
        'leurs effets sont appliqués : teinte nocturne, luminosité réduite, widgets masqués',
        `const night = document.querySelector('.screen-fx__night').classList.contains('is-on');
         const dim = Number(document.querySelector('.screen-fx__dim').style.opacity);
         const widgets = document.querySelector('.tb-widgets').getAttribute('aria-pressed');
         return (night && dim > 0.2 && widgets === 'false') || { night, dim, widgets };`,
      );
      await check(
        'le service des réglages restitue les valeurs enregistrées',
        `${PAGE_TOOLS}
         const reply = await window.evolve.services.call('settings', 'getAll');
         return (reply.ok === true && same(reply.value, ${expected})) || reply;`,
      );
      await check('le fichier des réglages a été relu sans incident', STORAGE_OK);

      await act(`document.querySelector('.tb-tray').click();`);
      await check("le panneau des paramètres rapides s'ouvre", `return document.querySelector('.qs').classList.contains('is-open');`);
      await capture('01-reglages-restaures');

      // La fenêtre de l'explorateur, ouverte sans rien d'autre : elle doit apparaître où le lancement précédent l'a laissée.
      await openExplorer();
      await check(
        PLACEMENT_CHECKS.restored,
        `${PLACEMENT_TOOLS}
         const el = pWin();
         if (!el || !pIdle(el)) return 'fenêtre en cours d’ouverture';
         const stored = await pStored();
         if (stored.kept !== true) return { 'aucun emplacement retenu': stored };
         const rect = pRect(el);
         const area = pArea();
         const found = stored.maximized
           ? el.classList.contains('is-maximized') && pSame(rect, { x: 0, y: 0, w: area.w, h: area.h })
           : !el.classList.contains('is-maximized') && pSame(rect, stored.pixels);
         return found || { attendu: stored, fenetre: rect, agrandie: el.classList.contains('is-maximized') };`,
      );
      await capture('02-fenetre-retrouvee');
    },
  };
}

module.exports = { settingsScenarios, CHANGED_SETTINGS, EXPECTED_SETTINGS, PLACEMENT_SETTINGS, PLACEMENT_CHECKS, readPlacement, describePlacement, shiftInside };

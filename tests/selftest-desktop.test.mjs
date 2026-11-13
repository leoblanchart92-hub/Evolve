/**
 * Auto-test du bureau et des fenêtres (src/main/selftest-desktop.js), exécuté
 * ici contre une fausse page.
 *
 * On vérifie ce qui ne dépend pas de la page : les contrôles menés et leur
 * ordre ; ceux qui ne le sont PAS quand la page ne reçoit pas la souris ou le
 * clavier — signalés, jamais comptés comme réussis ; les gestes, calculés
 * d'après la position réelle de la fenêtre ; ce qui est consigné quand l'état
 * attendu n'apparaît pas ; et l'analyse du parcours de la touche Tab.
 *
 * Que la vraie interface réponde à ces gestes est vérifié par l'auto-test
 * lui-même, dans l'application, sous Windows.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

import { fromRoot } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { checkDesktop, CHECKS, DESKTOP_TOOLS, MAX_WINDOWS, WINDOW_MENU } = require('../src/main/selftest-desktop.js');

const SOURCE = readFileSync(fromRoot('src', 'main', 'selftest-desktop.js'), 'utf8');

/** Contrôles qui exigent de vrais gestes de la souris, et ceux qui exigent de vraies touches. */
const MOUSE_CHECKS = ['resize', 'drag', 'escape', 'doubleClick', 'snapDrag', 'click'];
const KEYBOARD_CHECKS = ['escape', 'switcher', 'tab', 'desktopKeys', 'startKeys'];

/** Code par lequel l'auto-test relève, après chaque pression de Tab, l'élément qui détient le clavier. */
const TAB_PROBE = 'window.__evolveStops.indexOf(el)';
const GESTURES = ['move', 'click', 'press', 'release', 'drag', 'key', 'keyDown', 'keyUp', 'chord'];

/**
 * Fausse page et faux gestes.
 * @param {object} [options]
 * @param {(code: string) => unknown} [options.answer]  réponse de la page ; `undefined` : réponse par défaut
 * @param {boolean} [options.mouse]  la page reçoit la souris injectée
 * @param {boolean} [options.keyboard]  la page reçoit le clavier injecté
 * @param {(presses: { forward: number, backward: number }) => object} [options.focus]  élément qui détient le
 *        clavier après les pressions de Tab ; par défaut, un parcours en boucle de cinq éléments dans la fenêtre
 * @param {object} [options.context]  options de `checkDesktop`
 */
function setup({ answer = () => undefined, mouse = true, keyboard = true, focus = null, context = {} } = {}) {
  const executed = [];
  const checks = [];
  const captures = [];
  const gestures = [];
  const report = { errors: [], warnings: [], input: null };
  const presses = { forward: 0, backward: 0 };
  const where = focus ?? (({ forward, backward }) => ({ lieu: 'dedans', rang: (((forward - backward) % 5) + 5) % 5 }));

  const reply = (code) => {
    const given = answer(code);
    if (given !== undefined) return given;
    return code.includes(TAB_PROBE) ? where(presses) : true;
  };
  const evaluate = async (code) => {
    executed.push(code);
    return reply(code);
  };
  const record = (name, value) => {
    checks.push(value === true ? { name, ok: true } : { name, ok: false, value: value ?? null });
    return value === true;
  };
  const input = { prepare: async () => ({ mouse, keyboard, focused: mouse || keyboard }) };
  for (const name of GESTURES) {
    input[name] = async (...args) => {
      gestures.push([name, ...args]);
      if (name === 'key' && args[0] === 'Tab') presses[(args[1] ?? []).includes('shift') ? 'backward' : 'forward'] += 1;
    };
  }
  const tools = { evaluate, until: evaluate, record, capture: async (name) => captures.push(name), report };
  return { run: () => checkDesktop(tools, { input, ...context }), executed, checks, captures, gestures, report };
}

const names = (keys) => keys.map((key) => CHECKS[key]);
const failed = (checks) => checks.filter((check) => !check.ok).map((check) => check.name);
/** Code de page sans les outils qui le précèdent. */
const body = (code) => code.replace(DESKTOP_TOOLS, '').trim();

test('page conforme, souris et clavier reçus : tous les contrôles sont menés, dans l’ordre annoncé', async () => {
  const { run, checks, captures, report, gestures } = setup();
  await run();

  assert.deepEqual(checks.map((check) => check.name), Object.values(CHECKS));
  assert.deepEqual(failed(checks), []);
  assert.equal(checks.length, 22);
  assert.equal(new Set(Object.values(CHECKS)).size, 22, 'intitulés tous différents');
  assert.deepEqual(captures, ['09-fenetres', '10-bascule-fenetres']);
  assert.deepEqual(report.input, { souris: true, clavier: true, pageActive: true });
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.errors, []);

  // Les gestes annoncés ont bien été faits : glissements, double-clic, Échap, Ctrl + Tab, Ctrl + N, Ctrl + W, F6, Tab.
  const made = gestures.map(([name, ...args]) => `${name} ${typeof args[0] === 'string' ? args[0] : ''}`.trim());
  for (const gesture of ['drag', 'press', 'release', 'click', 'key Escape', 'chord N', 'chord W', 'chord Down', 'chord Space', 'keyDown Control', 'keyUp Control', 'key F6', 'key Tab', 'key Home', 'key End', 'key Enter', 'key Up', 'key Down', 'key Left', 'key Right']) {
    assert.ok(made.includes(gesture), `geste absent : ${gesture}`);
  }
});

test('sans la souris : les contrôles qui en dépendent ne sont pas menés — signalés, jamais comptés comme réussis', async () => {
  const { run, checks, report, gestures, captures } = setup({ mouse: false });
  await run();

  const expected = Object.keys(CHECKS).filter((key) => !MOUSE_CHECKS.includes(key));
  assert.deepEqual(checks.map((check) => check.name), names(expected));
  assert.deepEqual(failed(checks), []);
  for (const name of names(MOUSE_CHECKS)) assert.equal(checks.some((check) => check.name === name), false, name);
  assert.deepEqual(report.input, { souris: false, clavier: true, pageActive: true });
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /^gestes à la souris non vérifiés \(déplacement, redimensionnement, ancrage, double-clic\)/);
  // Aucun geste de souris n'est tenté ; ceux du clavier le sont.
  assert.deepEqual(gestures.filter(([name]) => ['move', 'click', 'press', 'release', 'drag'].includes(name)), []);
  assert.ok(gestures.some(([name, keyName]) => name === 'chord' && keyName === 'N'));
  assert.deepEqual(captures, ['09-fenetres', '10-bascule-fenetres']);
});

test('sans le clavier : les raccourcis ne sont pas vérifiés, et les contrôles restants passent par les commandes de l’interface', async () => {
  const { run, checks, report, gestures, captures, executed } = setup({ keyboard: false });
  await run();

  // Échap pendant un déplacement exige la souris ET le clavier.
  const expected = Object.keys(CHECKS).filter((key) => !KEYBOARD_CHECKS.includes(key));
  assert.deepEqual(checks.map((check) => check.name), names(expected));
  assert.deepEqual(failed(checks), []);
  assert.deepEqual(report.input, { souris: true, clavier: false, pageActive: true });
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /^raccourcis clavier non vérifiés \(Ctrl \+ Tab, Ctrl \+ N, Ctrl \+ W, F6, flèches, Tab\)/);
  assert.deepEqual(gestures.filter(([name]) => ['key', 'keyDown', 'keyUp', 'chord'].includes(name)), [], 'aucune touche n’est tentée');
  // La capture de la bascule entre fenêtres n'existe que si la bascule a eu lieu.
  assert.deepEqual(captures, ['09-fenetres']);

  // Ce que les touches auraient fait est obtenu par les commandes de l'interface.
  const codes = executed.map(body);
  assert.ok(codes.includes(`dMenuPick('Restaurer');`), 'la fenêtre ancrée est restaurée par son menu');
  assert.ok(codes.includes('dNewWindow();'), 'la seconde fenêtre est ouverte depuis la barre des tâches');
  assert.ok(codes.some((code) => code.endsWith(`.querySelector('.window__control--close').click();`)), 'la fenêtre active est fermée par son bouton');
});

test('ni souris ni clavier : seuls les contrôles par les commandes de l’interface sont menés, et le rapport le dit', async () => {
  const { run, checks, report, gestures } = setup({ mouse: false, keyboard: false });
  await run();

  const skipped = new Set([...MOUSE_CHECKS, ...KEYBOARD_CHECKS]);
  assert.equal(skipped.size, 10);
  assert.deepEqual(checks.map((check) => check.name), names(Object.keys(CHECKS).filter((key) => !skipped.has(key))));
  assert.equal(checks.length, 12);
  assert.deepEqual(failed(checks), []);
  assert.deepEqual(report.input, { souris: false, clavier: false, pageActive: false });
  assert.equal(report.warnings.length, 2);
  assert.deepEqual(gestures, []);
});

test('le code exécuté dans la page est du JavaScript valide, avec ou sans gestes réels', async () => {
  for (const [mouse, keyboard] of [[true, true], [true, false], [false, true], [false, false]]) {
    const { run, executed } = setup({ mouse, keyboard });
    await run();
    assert.ok(executed.length >= 40);
    for (const code of executed) {
      assert.doesNotThrow(() => new vm.Script(`(async () => { ${code} })()`), `code invalide : ${body(code).slice(0, 160)}…`);
    }
  }
  // Les outils de page seuls : valides, et sans effet tant qu'aucune fonction n'est appelée.
  assert.doesNotThrow(() => new vm.Script(DESKTOP_TOOLS).runInNewContext({}));
});

test('outils de page : deux rectangles sont tenus pour égaux à deux points près, ou exactement sur demande', () => {
  const { near, sameRect } = new vm.Script(`${DESKTOP_TOOLS}; ({ near, sameRect })`).runInNewContext({});
  const rect = { x: 100, y: 50, w: 800, h: 500 };
  assert.equal(sameRect(rect, { ...rect }), true);
  assert.equal(sameRect(rect, { x: 102, y: 48, w: 801, h: 499 }), true, 'arrondis d’affichage');
  assert.equal(sameRect(rect, { ...rect, x: 103 }), false);
  assert.equal(sameRect(rect, { ...rect, h: 497 }), false);
  assert.equal(sameRect(rect, { ...rect, x: 101 }, 0), false, 'tolérance nulle : exactement');
  assert.equal(sameRect(rect, { ...rect }, 0), true);
  assert.equal(sameRect(null, rect), false);
  assert.equal(sameRect(rect, undefined), false);
  assert.equal(near(10, 12), true);
  assert.equal(near(10, 13), false);
});

/** Page qui décrit une fenêtre de 992 × 640 placée en (304, 77) dans une zone de travail donnée. */
function pageWithWindow(rect, area) {
  return (code) => {
    const text = body(code);
    if (text === 'return (dArea());') return { x: 0, y: 0, ...area };
    if (text.startsWith('return ((dActive() ?? dWins()[0])?.dataset.window')) return 'window-1';
    if (text.startsWith('return (dInfo(dWin(')) return { id: 'window-1', ...rect };
    return undefined;
  };
}

test('les gestes de la souris sont calculés d’après la position réelle de la fenêtre', async () => {
  const rect = { x: 304, y: 77, w: 992, h: 640 };
  const { run, gestures, checks } = setup({ answer: pageWithWindow(rect, { w: 1600, h: 824 }) });
  await run();
  assert.deepEqual(failed(checks), []);

  const mouse = gestures.filter(([name]) => ['click', 'press', 'release', 'drag'].includes(name));
  const corner = { x: 304 + 992 - 2, y: 77 + 640 - 2 };
  const grip = { x: 304 + 260, y: 77 + 14 };
  assert.deepEqual(mouse.slice(0, 4), [
    // Redimensionnement par le coin inférieur droit : de 80 sur 60, puis deux fois jusqu'au coin opposé, puis de 240 sur 120.
    ['drag', corner, { x: corner.x - 80, y: corner.y - 60 }],
    ['drag', corner, { x: 306, y: 79 }],
    ['drag', corner, { x: 306, y: 79 }],
    ['drag', corner, { x: corner.x + 240, y: corner.y + 120 }],
  ]);
  assert.deepEqual(mouse.slice(4, 7), [
    // Déplacement par la barre de titre — ni sur l'icône, ni sur les boutons —, puis déplacement abandonné.
    ['drag', grip, { x: grip.x + 80, y: grip.y + 40 }],
    ['press', grip, { x: grip.x + 150, y: grip.y + 90 }],
    ['release', { x: grip.x + 150, y: grip.y + 90 }],
  ]);
  assert.deepEqual(mouse.slice(7, 9), [
    // Double-clic sur la barre de titre, puis sur celle de la fenêtre agrandie (en haut de la zone de travail).
    ['click', grip.x, grip.y, { count: 2 }],
    ['click', 260, 14, { count: 2 }],
  ]);
  assert.deepEqual(mouse.slice(9, 12), [
    // Glissée contre le bord gauche, relâchée là, puis glissée depuis la moitié gauche vers le milieu de l'écran.
    ['press', grip, { x: 3, y: grip.y + 120 }, { steps: 12 }],
    ['release', { x: 3, y: grip.y + 120 }],
    ['drag', { x: 260, y: 14 }, { x: 800, y: 160 }, { steps: 12 }],
  ]);
  // Clic dans la fenêtre qui n'est pas active : au milieu de sa barre de titre.
  assert.deepEqual(mouse.at(-1), ['click', 304 + 992 / 2, 77 + 14]);
  assert.equal(mouse.length, 13);
});

test('sur un petit écran, le déplacement se fait du côté où la fenêtre reste entière à l’écran', async () => {
  // Fenêtre de l'explorateur dans une zone de 960 × 589 : presque toute la place est prise.
  const rect = { x: 46, y: 14, w: 868, h: 560 };
  const { run, gestures } = setup({ answer: pageWithWindow(rect, { w: 960, h: 589 }) });
  await run();
  const grip = { x: 46 + 260, y: 28 };
  const drags = gestures.filter(([name]) => name === 'drag');
  // Vers la gauche (à droite, elle sortirait de l'écran), et sans descendre (elle passerait sous la barre des tâches).
  assert.deepEqual(drags[4], ['drag', grip, { x: grip.x - 80, y: grip.y }]);
  // Le pointeur qui ancre la fenêtre reste dans la zone de travail.
  const snap = gestures.find(([name, , , options]) => name === 'press' && options?.steps === 12);
  assert.deepEqual(snap[2], { x: 3, y: 148 });
  assert.ok(snap[2].y < 589);
});

test('un état attendu qui n’apparaît pas : le contrôle échoue, avec l’étape, ce qui était attendu et ce qui est observé', async () => {
  const observed = { fenetres: [{ id: 'window-1', ancree: null, x: 10, y: 20, w: 300, h: 200 }], clavier: 'fenêtre window-1', menu: null };
  const rect = { x: 304, y: 77, w: 992, h: 640 };
  const page = pageWithWindow(rect, { w: 1600, h: 824 });
  const { run, checks } = setup({
    // « Ancrer à droite » ne produit pas l'ancrage attendu (la moitié droite de la zone de travail).
    answer: (code) => (body(code).includes(`.dataset.snap === 'right' && sameRect(dRect(dWin("window-1")), {"x":800,"y":0,"w":800,"h":824}) && dMenu() === null`) ? observed : page(code)),
  });
  await run();

  assert.deepEqual(failed(checks), [CHECKS.menu]);
  assert.deepEqual(checks.find((check) => !check.ok).value, { etape: '« Ancrer à droite »', obtenu: observed });
  assert.equal(checks.length, 22, 'les autres contrôles ont lieu');
});

test('une fenêtre qui ne revient pas à sa place : la place attendue est consignée', async () => {
  const rect = { x: 304, y: 77, w: 992, h: 640 };
  const page = pageWithWindow(rect, { w: 1600, h: 824 });
  const elsewhere = { fenetres: [{ id: 'window-1', x: 304, y: 25, w: 992, h: 640 }] };
  const { run, checks } = setup({
    // Après « Ancrer à droite », la fenêtre restaurée n'est pas où elle était.
    answer: (code) => (body(code).startsWith(`const seen = (!dWin("window-1").dataset.snap && sameRect(dRect(dWin("window-1")), {"x":304,"y":77,"w":992,"h":640}));`) ? elsewhere : page(code)),
  });
  await run();
  assert.deepEqual(failed(checks), [CHECKS.menu]);
  const { value } = checks.find((check) => !check.ok);
  assert.equal(value.etape, 'restaurée');
  assert.deepEqual({ x: value.attendu.x, y: value.attendu.y, w: value.attendu.w, h: value.attendu.h }, rect);
  assert.deepEqual(value.obtenu, elsewhere);
});

test('un geste que la page refuse est consigné comme une erreur', async () => {
  const { run, report } = setup({
    answer: (code) => {
      if (body(code) === `document.querySelector('.tb-desktop').click();`) throw new Error('bouton introuvable');
      return undefined;
    },
  });
  await run();
  assert.deepEqual(report.errors, ['geste impossible sur le bureau : bouton introuvable', 'geste impossible sur le bureau : bouton introuvable']);
});

test('touche Tab : le clavier doit parcourir la fenêtre, revenir à son premier élément, et ne jamais en sortir', async () => {
  const tabCheck = async (focus) => {
    const { run, checks } = setup({ focus });
    await run();
    return checks.find((check) => check.name === CHECKS.tab);
  };
  const ring = (size) => ({ forward, backward }) => ({ lieu: 'dedans', rang: (((forward - backward) % size) + size) % size });

  // Parcours en boucle, dans la fenêtre : réussite.
  assert.deepEqual(await tabCheck(ring(5)), { name: CHECKS.tab, ok: true });
  assert.deepEqual(await tabCheck(ring(3)), { name: CHECKS.tab, ok: true });

  // Le clavier sort de la fenêtre (vers la barre des tâches) : échec, et l'endroit est dit.
  const escaped = await tabCheck(({ forward, backward }) => (forward - backward === 3 ? { lieu: 'barre des tâches', rang: -1 } : ring(5)({ forward, backward })));
  assert.equal(escaped.ok, false);
  assert.deepEqual(escaped.value['hors de la fenêtre'], ['barre des tâches']);

  // Tab ne déplace rien : échec.
  const stuck = await tabCheck(() => ({ lieu: 'dedans', rang: 2 }));
  assert.equal(stuck.ok, false);
  assert.equal(stuck.value.visites, 1);

  // Le parcours ne revient jamais au premier élément (pas de boucle observée) : échec.
  const endless = await tabCheck(({ forward, backward }) => ({ lieu: 'dedans', rang: forward - backward }));
  assert.equal(endless.ok, false);
  assert.equal(endless.value['retour au premier'], false);

  // Maj + Tab ne revient pas en arrière : échec.
  const oneWay = await tabCheck(({ forward }) => ({ lieu: 'dedans', rang: forward % 5 }));
  assert.equal(oneWay.ok, false);
  assert.equal(oneWay.value['retour en arrière'], false);

  // Maj + Tab avance au lieu de reculer : échec, même si le clavier reste dans la fenêtre.
  const sameWay = await tabCheck(({ forward, backward }) => ({ lieu: 'dedans', rang: (forward + backward) % 5 }));
  assert.equal(sameWay.ok, false);
  assert.equal(sameWay.value['retour en arrière'], false);

  // Fenêtre de six éléments : six pressions de Maj + Tab ramènent au point de départ — c'est bien un retour en arrière.
  assert.deepEqual(await tabCheck(ring(6)), { name: CHECKS.tab, ok: true });

  // Relevé illisible : jamais une réussite.
  const unreadable = await tabCheck(() => null);
  assert.equal(unreadable.ok, false);
  assert.deepEqual(unreadable.value['hors de la fenêtre'], ['illisible']);
});

test('nombre maximal de fenêtres : l’auto-test en ouvre jusqu’à la limite, puis tente une ouverture de trop', async () => {
  // Trois fenêtres ouvertes au moment du contrôle, limite fixée à cinq : deux ouvertures, puis une de trop.
  const count = (code) => (body(code) === 'return (dWins().length);' ? 3 : undefined);
  const limited = setup({ answer: count, context: { maxWindows: 5 } });
  await limited.run();
  const opened = limited.executed.map(body).filter((code) => code === 'dNewWindow();');
  assert.equal(opened.length, 3);
  const waited = limited.executed.map(body).filter((code) => /^const seen = \(dWins\(\)\.length === \d+\);/.test(code)).map((code) => Number(code.match(/=== (\d+)/)[1]));
  assert.deepEqual(waited.slice(-2), [4, 5]);
  assert.ok(limited.executed.map(body).some((code) => code.includes(`dWins().length === 5 && document.querySelectorAll('.window').length === 5 && dToasts().includes('Trop de fenêtres ouvertes')`)));

  // Par défaut : la limite de l'interface elle-même.
  const source = readFileSync(fromRoot('src', 'renderer', 'js', 'wm', 'window-manager.js'), 'utf8');
  assert.equal(MAX_WINDOWS, Number(source.match(/export const MAX_WINDOWS = (\d+);/)[1]));
  assert.match(CHECKS.limit, new RegExp(`^au-delà de ${MAX_WINDOWS} fenêtres`));
  const shell = readFileSync(fromRoot('src', 'renderer', 'js', 'shell', 'shell.js'), 'utf8');
  assert.ok(shell.includes(`title: 'Trop de fenêtres ouvertes'`), 'la notification attendue est celle que le bureau affiche');
});

test('le menu de la fenêtre attendu est celui que le gestionnaire de fenêtres construit', () => {
  const source = readFileSync(fromRoot('src', 'renderer', 'js', 'wm', 'window-manager.js'), 'utf8');
  const start = source.indexOf('windowMenuItems(win) {');
  const end = source.indexOf('showWindowMenu(win', start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  // Les deux commandes d'ancrage sont construites par une même fonction, appelée avec leur intitulé.
  const labels = [...block.slice(block.indexOf('return [')).matchAll(/label: '([^']+)'|snap\('(?:left|right)', '([^']+)'\)/g)].map((match) => match[1] ?? match[2]);
  assert.deepEqual(labels, [...WINDOW_MENU]);
});

test('les éléments de l’interface que l’auto-test désigne existent dans l’interface', () => {
  // Classes nommées par l'auto-test du bureau (sélecteurs et états)…
  const classes = new Set([...SOURCE.matchAll(/\.((?:window|tb|start|toast|menu|switcher|snap|desktop|ex)(?:(?:__|--|-)[a-z0-9]+)+)/g)].map((match) => match[1]));
  const states = new Set([...SOURCE.matchAll(/'(is-[a-z-]+)'|\.(is-[a-z-]+)/g)].map((match) => match[1] ?? match[2]));
  assert.ok(classes.size >= 15, [...classes].join(' '));
  assert.ok(states.size >= 12, [...states].join(' '));

  // … cherchées dans le code de l'interface (JavaScript et page).
  const rendererDir = fromRoot('src', 'renderer');
  const files = [path.join(rendererDir, 'index.html')];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (entry.name.endsWith('.js')) files.push(path.join(dir, entry.name));
    }
  };
  walk(path.join(rendererDir, 'js'));
  const renderer = files.map((file) => readFileSync(file, 'utf8')).join('\n');
  const known = (name) => new RegExp(`(^|[^a-z0-9_-])${name}($|[^a-z0-9_-])`).test(renderer);
  // Classes composées par l'interface à partir d'un nom (`window__control--${kind}`).
  const composed = { 'window__control--min': /window__control--\$\{kind\}/, 'window__control--close': /window__control--\$\{kind\}/ };
  for (const name of [...classes, ...states]) {
    assert.ok(known(name) || composed[name]?.test(renderer), `« ${name} » n'existe pas dans l'interface`);
  }
  // Attributs de données lus par l'auto-test.
  for (const attribute of ['data-window', 'data-app', 'data-snap', 'data-windows', 'data-id', 'data-place', 'data-page', 'data-path']) {
    const name = attribute.slice(5);
    assert.ok(new RegExp(`dataset\\.${name}\\b|dataset: \\{[^}]*\\b${name}\\b|${attribute}`).test(renderer), `« ${attribute} » n'existe pas dans l'interface`);
  }
});

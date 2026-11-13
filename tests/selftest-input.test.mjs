/**
 * Gestes de la souris et du clavier de l'auto-test (src/main/selftest-input.js).
 *
 * Ils sont injectés dans le moteur d'affichage par `webContents.sendInputEvent`.
 * On vérifie ici, contre une fausse fenêtre, la suite exacte des événements de
 * chaque geste — c'est d'elle que dépend ce que la page reçoit : un bouton tenu
 * pendant tout un glissement, un double-clic compté, des modificateurs enfoncés
 * avant la touche et relâchés après — et le constat préalable : des gestes que
 * la page ne reçoit pas ne sont jamais tenus pour reçus.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createInput, PROBE } = require('../src/main/selftest-input.js');

/**
 * Fausse fenêtre : consigne les événements injectés ; `page` décrit ce que la
 * page en reçoit (`moves`, `keys`) et si elle se tient pour active (`focused`).
 */
function fakeWindow({ moves = true, keys = true, focused = true, send = true, evaluateFails = false } = {}) {
  const events = [];
  const calls = [];
  const webContents = { focus: () => calls.push('webContents.focus') };
  if (send) webContents.sendInputEvent = (event) => events.push(event);
  const answer = (code) => {
    if (code.includes('__evolveInput.moves > 0')) return moves && events.some((event) => event.type === 'mouseMove');
    if (code.includes('__evolveInput.keys > 0')) return keys && events.some((event) => event.type === 'keyDown');
    if (code.includes('document.hasFocus()')) return focused;
    return true;
  };
  const evaluated = [];
  const evaluate = async (code) => {
    evaluated.push(code);
    if (evaluateFails) throw new Error('page injoignable');
    return answer(code);
  };
  const until = async (code) => answer(code);
  const win = { focus: () => calls.push('win.focus') };
  const input = createInput({ webContents, win, evaluate, until, pause: 0, probeTimeout: 20 });
  return { input, events, calls, evaluated };
}

/** Résumé d'un événement de souris : type, position, bouton tenu. */
const mouse = (event) => `${event.type}@${event.x},${event.y}${(event.modifiers ?? []).includes('leftButtonDown') ? ' tenu' : ''}`;
/** Résumé d'un événement de clavier : type, touche, modificateurs. */
const key = (event) => `${event.type} ${event.keyCode}${event.modifiers?.length ? ` [${event.modifiers.join('+')}]` : ''}`;

test('constat préalable : la page reçoit la souris et le clavier injectés', async () => {
  const { input, events, calls, evaluated } = fakeWindow();
  assert.deepEqual(input.available, { mouse: false, keyboard: false, focused: false }, 'rien n’est tenu pour reçu avant le constat');

  const available = await input.prepare();
  assert.deepEqual(available, { mouse: true, keyboard: true, focused: true });
  assert.equal(available, input.available);

  // La fenêtre est d'abord rendue active, pour que le moteur lui transmette le clavier.
  assert.deepEqual(calls, ['win.focus', 'webContents.focus']);
  // Le constat ne touche à rien : quelques mouvements sans bouton, puis la touche Maj, enfoncée et relâchée.
  const moves = events.filter((event) => event.type === 'mouseMove');
  assert.ok(moves.length >= 2);
  assert.ok(moves.every((event) => !event.modifiers && !event.button));
  assert.deepEqual(events.filter((event) => event.type !== 'mouseMove').map(key), ['keyDown Shift [shift]', 'keyUp Shift']);
  assert.equal(events.some((event) => event.type === 'mouseDown' || event.type === 'mouseUp'), false, 'aucun clic');

  // Le code de comptage posé dans la page est valide, et ne compte que les événements authentiques.
  assert.equal(evaluated[0], PROBE);
  assert.doesNotThrow(() => new vm.Script(`(async () => { ${PROBE} })()`));
  assert.equal(PROBE.match(/event\.isTrusted/g).length, 2);
});

test('constat préalable : des gestes que la page ne reçoit pas ne sont jamais tenus pour reçus', async () => {
  // Le clavier n'arrive pas (fenêtre restée en arrière-plan) : la souris seule est reçue.
  const noKeys = fakeWindow({ keys: false, focused: false });
  assert.deepEqual(await noKeys.input.prepare(), { mouse: true, keyboard: false, focused: false });

  // Rien n'arrive.
  const nothing = fakeWindow({ moves: false, keys: false });
  assert.deepEqual(await nothing.input.prepare(), { mouse: false, keyboard: false, focused: true });

  // La fenêtre ne sait pas recevoir de gestes injectés : rien n'est envoyé, rien n'est reçu, rien n'échoue.
  const unable = fakeWindow({ send: false });
  assert.deepEqual(await unable.input.prepare(), { mouse: false, keyboard: false, focused: false });
  assert.deepEqual(unable.evaluated, []);
  await unable.input.drag({ x: 1, y: 2 }, { x: 30, y: 40 });
  await unable.input.chord('Tab', ['control']);
  assert.deepEqual(unable.events, []);

  // La page ne répond pas : rien n'est tenu pour reçu.
  const silent = fakeWindow({ evaluateFails: true });
  assert.deepEqual(await silent.input.prepare(), { mouse: false, keyboard: false, focused: false });
  assert.deepEqual(silent.events, []);
});

test('glissement : bouton enfoncé au départ, tenu à chaque étape, relâché à l’arrivée', async () => {
  const { input, events } = fakeWindow();
  await input.drag({ x: 100, y: 50 }, { x: 180, y: 90 }, { steps: 4 });
  assert.deepEqual(events.map(mouse), [
    'mouseMove@100,50',
    'mouseDown@100,50 tenu',
    'mouseMove@120,60 tenu',
    'mouseMove@140,70 tenu',
    'mouseMove@160,80 tenu',
    'mouseMove@180,90 tenu',
    'mouseUp@180,90',
  ]);
  const [, down, ...rest] = events;
  assert.deepEqual({ button: down.button, clickCount: down.clickCount }, { button: 'left', clickCount: 1 });
  const up = rest.at(-1);
  assert.deepEqual({ button: up.button, clickCount: up.clickCount, modifiers: up.modifiers }, { button: 'left', clickCount: 1, modifiers: undefined });
  // Pendant le glissement, chaque mouvement porte le bouton gauche : sans lui, la page croirait le bouton relâché.
  assert.ok(rest.slice(0, -1).every((event) => event.button === 'left'));
});

test('glissement en deux temps : le bouton reste enfoncé tant qu’il n’est pas relâché', async () => {
  const { input, events } = fakeWindow();
  await input.press({ x: 10, y: 10 }, { x: 3, y: 130 }, { steps: 2 });
  assert.equal(events.some((event) => event.type === 'mouseUp'), false);
  assert.deepEqual(events.map(mouse), ['mouseMove@10,10', 'mouseDown@10,10 tenu', 'mouseMove@7,70 tenu', 'mouseMove@3,130 tenu']);
  await input.release({ x: 3, y: 130 });
  assert.equal(mouse(events.at(-1)), 'mouseUp@3,130');
});

test('positions : arrondies au point ; une position illisible vaut 0, jamais NaN', async () => {
  const { input, events } = fakeWindow();
  await input.move(12.4, 7.6);
  await input.click(Number.NaN, undefined);
  await input.drag({ x: 0.4, y: 0.6 }, { x: 9.5, y: 'x' }, { steps: 1 });
  await input.release(null);
  for (const event of events) {
    assert.ok(Number.isInteger(event.x) && Number.isInteger(event.y), JSON.stringify(event));
  }
  assert.deepEqual([events[0].x, events[0].y], [12, 8]);
  assert.deepEqual([events[1].x, events[1].y], [0, 0]);
  assert.deepEqual([events.at(-1).x, events.at(-1).y], [0, 0]);
});

test('clic et double-clic : le second appui est compté comme second', async () => {
  const single = fakeWindow();
  await single.input.click(40, 20);
  assert.deepEqual(single.events.map((event) => `${mouse(event)}${event.clickCount ? ` ×${event.clickCount}` : ''}`), ['mouseMove@40,20', 'mouseDown@40,20 tenu ×1', 'mouseUp@40,20 ×1']);

  const double = fakeWindow();
  await double.input.click(40, 20, { count: 2 });
  assert.deepEqual(double.events.map((event) => `${event.type}${event.clickCount ? ` ×${event.clickCount}` : ''}`), ['mouseMove', 'mouseDown ×1', 'mouseUp ×1', 'mouseDown ×2', 'mouseUp ×2']);

  // Autre bouton : il est nommé, et tenu pendant l'appui.
  const right = fakeWindow();
  await right.input.click(5, 5, { button: 'right' });
  assert.deepEqual(right.events[1].modifiers, ['rightButtonDown']);
  assert.equal(right.events[1].button, 'right');
  assert.equal(right.events[2].button, 'right');
});

test('touches : une pression est un appui suivi d’un relâchement', async () => {
  const { input, events } = fakeWindow();
  await input.key('Escape');
  await input.key('Tab', ['shift']);
  assert.deepEqual(events.map(key), ['keyDown Escape', 'keyUp Escape', 'keyDown Tab [shift]', 'keyUp Tab [shift]']);
});

test('accords : les modificateurs sont enfoncés avant la touche et relâchés après, dans l’ordre inverse', async () => {
  const one = fakeWindow();
  await one.input.chord('Tab', ['control']);
  assert.deepEqual(one.events.map(key), ['keyDown Control [control]', 'keyDown Tab [control]', 'keyUp Tab [control]', 'keyUp Control']);

  const two = fakeWindow();
  await two.input.chord('Down', ['alt', 'shift']);
  assert.deepEqual(two.events.map(key), [
    'keyDown Alt [alt]',
    'keyDown Shift [alt+shift]',
    'keyDown Down [alt+shift]',
    'keyUp Down [alt+shift]',
    'keyUp Shift [alt]',
    'keyUp Alt',
  ]);
});

test('bascule entre fenêtres : Ctrl peut rester enfoncé pendant que Tab est pressée, puis être relâché seul', async () => {
  const { input, events } = fakeWindow();
  await input.keyDown('Control', ['control']);
  await input.key('Tab', ['control']);
  await input.key('Tab', ['control']);
  await input.keyUp('Control');
  assert.deepEqual(events.map(key), ['keyDown Control [control]', 'keyDown Tab [control]', 'keyUp Tab [control]', 'keyDown Tab [control]', 'keyUp Tab [control]', 'keyUp Control']);
});

test('les noms de touches employés sont ceux qu’Electron reconnaît', async () => {
  // Noms des accélérateurs d'Electron : ce sont eux que `sendInputEvent` attend dans `keyCode`.
  const ELECTRON_KEYS = new Set(['Tab', 'Escape', 'Enter', 'Space', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'Control', 'Shift', 'Alt', 'F6', 'N', 'W']);
  const { readFileSync } = await import('node:fs');
  const { fromRoot } = await import('./helpers.mjs');
  const source = readFileSync(fromRoot('src', 'main', 'selftest-desktop.js'), 'utf8');
  const used = new Set([...source.matchAll(/input\.(?:key|keyDown|keyUp|chord)\('([^']+)'/g)].map((match) => match[1]));
  assert.ok(used.size >= 10, [...used].join(', '));
  for (const name of used) assert.ok(ELECTRON_KEYS.has(name), `touche inconnue d'Electron : ${name}`);
  // Les modificateurs sont nommés comme Electron les attend.
  const modifiers = new Set([...source.matchAll(/input\.(?:key|keyDown|keyUp|chord)\('[^']+', \[([^\]]*)\]/g)].flatMap((match) => match[1].split(',').map((item) => item.trim().replaceAll("'", '')).filter(Boolean)));
  for (const name of modifiers) assert.ok(['control', 'shift', 'alt'].includes(name), `modificateur inconnu : ${name}`);
});

/** Emplacement retenu d'une fenêtre : conversion, contrôle des valeurs relues, liaison avec les réglages. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { createStore } from '../src/renderer/js/core/events.js';
import { PERSISTED } from '../src/renderer/js/shell/settings-sync.js';
import { ui } from '../src/renderer/js/shell/ui-state.js';
import { createWindowPlacement, PLACEMENT_KEYS } from '../src/renderer/js/shell/window-placement.js';
import { decodePlacement, encodePlacement, PLACEMENT_LIMITS } from '../src/renderer/js/wm/placement.js';

const require = createRequire(import.meta.url);
const { SETTINGS, normalize } = require('../src/services/settings-schema.js');

test('un rectangle en pixels est conservé en centièmes de rem, puis retrouvé', () => {
  const rect = { x: 464, y: 153, w: 992, h: 640 };
  const values = encodePlacement(rect, 16);
  assert.deepEqual(values, { x: 2900, y: 956, w: 6200, h: 4000 });
  assert.deepEqual(decodePlacement(values, 16), { x: 464, y: 153, w: 992, h: 640 });
  // Position négative (fenêtre dépassant à gauche) : conservée.
  assert.deepEqual(decodePlacement(encodePlacement({ x: -320, y: 0, w: 800, h: 500 }, 16), 16), { x: -320, y: 0, w: 800, h: 500 });
  // Les valeurs conservées sont des entiers : le service des réglages n'admet rien d'autre.
  for (const value of Object.values(encodePlacement({ x: 10.4, y: 33.3, w: 801.7, h: 499.2 }, 16))) assert.ok(Number.isInteger(value));
});

test('sur un écran d’une autre définition, la fenêtre retrouve les mêmes proportions', () => {
  // Retenue sur un écran où le rem vaut 16 px, rouverte là où il en vaut 24 (4K) ou 12.
  const values = encodePlacement({ x: 160, y: 80, w: 992, h: 640 }, 16);
  assert.deepEqual(decodePlacement(values, 24), { x: 240, y: 120, w: 1488, h: 960 });
  assert.deepEqual(decodePlacement(values, 12), { x: 120, y: 60, w: 744, h: 480 });
});

test('un rectangle inutilisable n’est pas conservé', () => {
  for (const rect of [null, undefined, {}, { x: 0, y: 0, w: 0, h: 500 }, { x: 0, y: 0, w: 800, h: -5 }, { x: NaN, y: 0, w: 8, h: 8 }, { x: 0, y: Infinity, w: 8, h: 8 }, { x: '1', y: 0, w: 8, h: 8 }]) {
    assert.equal(encodePlacement(rect, 16), null, JSON.stringify(rect));
  }
  for (const unit of [0, -16, NaN, undefined, null]) assert.equal(encodePlacement({ x: 0, y: 0, w: 800, h: 500 }, unit), null, String(unit));
  // Valeurs démesurées : ramenées dans les bornes du service.
  const huge = encodePlacement({ x: -9e9, y: 9e9, w: 9e9, h: 9e9 }, 16);
  assert.deepEqual(huge, { x: PLACEMENT_LIMITS.minPosition, y: PLACEMENT_LIMITS.maxPosition, w: PLACEMENT_LIMITS.maxSize, h: PLACEMENT_LIMITS.maxSize });
  // Une fenêtre minuscule garde une taille : jamais « aucun emplacement retenu » par arrondi.
  assert.deepEqual(encodePlacement({ x: 0, y: 0, w: 0.01, h: 0.01 }, 16), { x: 0, y: 0, w: 1, h: 1 });
});

test('toute valeur relue est contrôlée : absente, non entière ou hors bornes, l’emplacement est abandonné', () => {
  const good = { x: 2900, y: 956, w: 6200, h: 4000 };
  assert.ok(decodePlacement(good, 16));
  // Valeurs par défaut des réglages : aucun emplacement retenu.
  assert.equal(decodePlacement({ x: 0, y: 0, w: 0, h: 0 }, 16), null);
  const bad = [
    { ...good, w: 0 },
    { ...good, h: 0 },
    { ...good, w: -100 },
    { ...good, w: 6200.5 },
    { ...good, x: '2900' },
    { ...good, y: null },
    { ...good, h: undefined },
    { ...good, x: NaN },
    { ...good, w: Infinity },
    { ...good, w: PLACEMENT_LIMITS.maxSize + 1 },
    { ...good, x: PLACEMENT_LIMITS.minPosition - 1 },
    { ...good, y: PLACEMENT_LIMITS.maxPosition + 1 },
    { x: 1, y: 2, w: 3 },
  ];
  for (const values of bad) assert.equal(decodePlacement(values, 16), null, JSON.stringify(values));
  for (const values of [null, undefined]) assert.equal(decodePlacement(values, 16), null);
  for (const unit of [0, -1, NaN, undefined]) assert.equal(decodePlacement(good, unit), null, String(unit));
});

test('les bornes de l’interface sont celles du service des réglages', () => {
  const keys = PLACEMENT_KEYS.explorer;
  const setting = (key) => SETTINGS[PERSISTED[keys[key]]];
  for (const key of ['x', 'y']) {
    assert.deepEqual([setting(key).type, setting(key).min, setting(key).max, setting(key).default], ['integer', PLACEMENT_LIMITS.minPosition, PLACEMENT_LIMITS.maxPosition, 0], key);
  }
  for (const key of ['w', 'h']) {
    assert.deepEqual([setting(key).type, setting(key).min, setting(key).max, setting(key).default], ['integer', 0, PLACEMENT_LIMITS.maxSize, 0], key);
  }
  assert.deepEqual([setting('maximized').type, setting('maximized').default], ['boolean', false]);
  // Chaque clé retenue est un réglage conservé, et l'état de l'interface part de « rien n'est retenu ».
  for (const key of Object.values(keys)) {
    assert.ok(Object.hasOwn(PERSISTED, key), key);
    assert.equal(ui.get(key), SETTINGS[PERSISTED[key]].default, key);
  }
  // Ce que l'interface conserve est admis tel quel par le service.
  const values = encodePlacement({ x: -9e9, y: 9e9, w: 9e9, h: 9e9 }, 16);
  for (const key of ['x', 'y', 'w', 'h']) assert.deepEqual(normalize(setting(key), values[key]), { ok: true, value: values[key] }, key);
});

test('emplacement retenu : rien au départ, puis la dernière disposition donnée à la fenêtre', () => {
  const store = createStore(ui.snapshot());
  const changes = [];
  store.subscribe('*', ({ key }) => changes.push(key));
  const placement = createWindowPlacement(store, () => 16);

  // Rien n'est retenu tant que l'utilisateur n'a rien déplacé.
  assert.equal(placement.load('explorer'), null);
  assert.deepEqual(changes, []);

  placement.save('explorer', { rect: { x: 464, y: 153, w: 992, h: 640 }, maximized: false });
  assert.deepEqual(placement.load('explorer'), { rect: { x: 464, y: 153, w: 992, h: 640 }, maximized: false });
  assert.deepEqual(changes.sort(), ['explorerWindowHeight', 'explorerWindowWidth', 'explorerWindowX', 'explorerWindowY']);

  // Même disposition : aucun réglage n'est réécrit.
  changes.length = 0;
  placement.save('explorer', { rect: { x: 464, y: 153, w: 992, h: 640 }, maximized: false });
  assert.deepEqual(changes, []);

  // Agrandie : la disposition libre est gardée, l'agrandissement s'y ajoute.
  placement.save('explorer', { rect: { x: 464, y: 153, w: 992, h: 640 }, maximized: true });
  assert.deepEqual(changes, ['explorerWindowMaximized']);
  assert.deepEqual(placement.load('explorer'), { rect: { x: 464, y: 153, w: 992, h: 640 }, maximized: true });

  // Rectangle inutilisable : rien n'est modifié.
  changes.length = 0;
  placement.save('explorer', { rect: { x: 0, y: 0, w: NaN, h: 0 }, maximized: false });
  assert.deepEqual(changes, []);
  assert.equal(placement.load('explorer').maximized, true);

  // Une application sans emplacement retenu : ni lecture, ni écriture.
  assert.equal(placement.load('browser'), null);
  placement.save('browser', { rect: { x: 1, y: 1, w: 10, h: 10 }, maximized: false });
  assert.deepEqual(changes, []);
});

test('emplacement retenu : une valeur altérée dans les réglages fait rouvrir la fenêtre à sa place habituelle', () => {
  const store = createStore({ ...ui.snapshot(), explorerWindowX: 100, explorerWindowY: 100, explorerWindowWidth: 6200, explorerWindowHeight: 0 });
  assert.equal(createWindowPlacement(store, () => 16).load('explorer'), null);
  store.set('explorerWindowHeight', 4000);
  assert.deepEqual(createWindowPlacement(store, () => 16).load('explorer'), { rect: { x: 16, y: 16, w: 992, h: 640 }, maximized: false });
  // Taille d'un rem indisponible (page non affichée) : l'emplacement est ignoré plutôt que mal converti.
  assert.equal(createWindowPlacement(store, () => 0).load('explorer'), null);
});

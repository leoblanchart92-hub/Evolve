/** Registre des applications : ce qui est disponible, ce qui est seulement annoncé, et ce qui y mène. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mounterFor } from '../src/renderer/js/apps/index.js';
import { LOCATION_IDS, PLACES } from '../src/renderer/js/apps/explorer-nav.js';
import { appLabel, APPS, AVAILABLE_APPS, DESKTOP_ICONS, getApp, isAvailable, TASKBAR_PINNED, UPCOMING_APPS } from '../src/renderer/js/data/apps.js';
import { createDemoNotifications } from '../src/renderer/js/data/demo-content.js';
import { readText } from './helpers.mjs';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

test('chaque application est complètement décrite', () => {
  assert.ok(APPS.length >= 12);
  assert.equal(new Set(APPS.map((app) => app.id)).size, APPS.length, 'identifiants uniques');
  assert.equal(new Set(APPS.map((app) => app.name)).size, APPS.length, 'noms uniques');
  for (const app of APPS) {
    assert.match(app.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(app.name.length > 0);
    assert.ok(typeof app.glyph === 'string' && app.glyph.length > 0);
    assert.equal(app.colors.length, 2);
    for (const color of app.colors) assert.match(color, HEX_COLOR);
    assert.equal(getApp(app.id), app);
    assert.ok(appLabel(app).length > 0 && appLabel(app).length <= 14, `nom court trop long : ${appLabel(app)}`);
  }
  assert.equal(getApp('inconnue'), undefined);
});

test('une application est disponible si, et seulement si, son interface existe', () => {
  // Disponible : un type est déclaré, et une interface porte ce nom.
  for (const app of AVAILABLE_APPS) {
    assert.equal(isAvailable(app), true);
    assert.equal(typeof mounterFor(app.kind), 'function', `aucune interface pour ${app.id}`);
  }
  // Seulement annoncée : aucun type, donc rien à ouvrir.
  for (const app of UPCOMING_APPS) {
    assert.equal(isAvailable(app), false);
    assert.equal(app.kind, undefined, `${app.id} déclare un type sans être disponible`);
    assert.equal(app.multiWindow, undefined);
  }
  assert.deepEqual([...AVAILABLE_APPS, ...UPCOMING_APPS].map((app) => app.id).sort(), APPS.map((app) => app.id).sort());
  // Dans cette version : l'explorateur de fichiers, qui admet plusieurs fenêtres.
  assert.deepEqual(AVAILABLE_APPS.map((app) => app.id), ['explorer']);
  assert.equal(getApp('explorer').multiWindow, true);
  // Un type inconnu, ou hérité d'un objet, ne désigne aucune interface.
  for (const kind of ['placeholder', 'constructor', 'toString', '', undefined]) assert.equal(mounterFor(kind), null, String(kind));
  for (const value of [null, undefined, {}, { kind: '' }, { kind: 42 }]) assert.equal(isAvailable(value), false);
});

test('aucune fenêtre factice : la fenêtre d’attente des applications à venir n’existe plus', () => {
  assert.doesNotMatch(readText('src/renderer/js/apps/index.js'), /placeholder/i);
  assert.doesNotMatch(readText('src/renderer/index.html'), /placeholder\.css/);
  // Lancer une application seulement annoncée ne monte rien : le bureau le dit, et n'ouvre aucune fenêtre.
  const shell = readText('src/renderer/js/shell/shell.js');
  assert.match(shell, /const mount = isAvailable\(app\) \? mounterFor\(app\.kind\) : null;\s+if \(!mount\) \{\s+this\.announceUpcoming\(app\);\s+return null;\s+\}/);
});

test('la barre des tâches n’épingle que des applications disponibles', () => {
  assert.equal(new Set(TASKBAR_PINNED).size, TASKBAR_PINNED.length);
  assert.ok(TASKBAR_PINNED.length >= 1);
  for (const id of TASKBAR_PINNED) assert.equal(isAvailable(getApp(id)), true, `application épinglée indisponible : ${id}`);
  assert.equal(TASKBAR_PINNED[0], 'explorer');
});

test('chaque icône du bureau ouvre une application disponible, à un emplacement qui existe', () => {
  assert.ok(DESKTOP_ICONS.length >= 2);
  assert.equal(new Set(DESKTOP_ICONS.map((item) => item.id)).size, DESKTOP_ICONS.length);
  assert.equal(new Set(DESKTOP_ICONS.map((item) => item.name)).size, DESKTOP_ICONS.length);
  const personal = new Set(PLACES.map((place) => place.id));
  for (const item of DESKTOP_ICONS) {
    assert.ok(item.name.length > 0);
    assert.equal(isAvailable(getApp(item.open.app)), true, `l'icône ${item.id} mène à une application indisponible`);
    assert.equal(item.open.app, 'explorer');
    assert.ok(LOCATION_IDS.includes(item.open.location), `emplacement inconnu : ${item.open.location}`);
    // Ni Corbeille ni Réseau : l'explorateur ne sait que dire qu'ils ne sont pas disponibles.
    assert.ok(item.open.location === 'pc' || item.open.location === 'home' || personal.has(item.open.location), `l'icône ${item.id} mène à un emplacement sans contenu`);
    // Une icône qui ouvre un dossier personnel en porte le nom.
    if (personal.has(item.open.location)) assert.equal(item.name, PLACES.find((place) => place.id === item.open.location).name);
    for (const color of item.colors) assert.match(color, HEX_COLOR);
  }
  assert.deepEqual(DESKTOP_ICONS.map((item) => item.id), ['this-pc', 'documents', 'downloads', 'pictures']);
});

test("les notifications d'exemple sont datées dans le passé et ne viennent que d'applications disponibles", () => {
  const now = new Date(2026, 10, 10, 9, 0, 0);
  const notifications = createDemoNotifications(now);
  assert.ok(notifications.length >= 3);
  assert.equal(new Set(notifications.map((item) => item.id)).size, notifications.length);
  for (const item of notifications) {
    assert.ok(item.title.length > 0 && item.body.length > 0);
    assert.ok(item.time.getTime() < now.getTime());
    if (item.app) assert.equal(isAvailable(getApp(item.app)), true, `notification d'une application indisponible : ${item.app}`);
    else assert.ok(item.source && item.glyph && item.colors?.length === 2);
  }
  const times = notifications.map((item) => item.time.getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'de la plus récente à la plus ancienne');
});

test('les notifications disent ce qui est simulé, et ce qui ne l’est pas', () => {
  const text = createDemoNotifications().map((item) => `${item.title} ${item.body}`).join(' ');
  assert.match(text, /simulées/);
  assert.match(text, /pas encore disponibles/);
  assert.match(text, /Aucun paramètre Windows n'est modifié/);
  // Plus aucun fichier fictif n'est présenté nulle part.
  assert.doesNotMatch(text, /fictif/);
});

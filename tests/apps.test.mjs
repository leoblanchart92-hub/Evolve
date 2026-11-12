/** Registre des applications affichées dans l'interface. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appLabel, APPS, DESKTOP_ICONS, getApp, START_PINNED, TASKBAR_PINNED } from '../src/renderer/js/data/apps.js';
import { createDemoNotifications } from '../src/renderer/js/data/demo-content.js';
import { LOCATION_IDS } from '../src/renderer/js/apps/explorer-nav.js';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

test('chaque application est complètement décrite', () => {
  assert.ok(APPS.length >= 12);
  assert.equal(new Set(APPS.map((app) => app.id)).size, APPS.length, 'identifiants uniques');
  assert.equal(new Set(APPS.map((app) => app.name)).size, APPS.length, 'noms uniques');
  for (const app of APPS) {
    assert.match(app.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(app.name.length > 0);
    assert.ok(['explorer', 'placeholder'].includes(app.kind), `type inconnu pour ${app.id}`);
    assert.ok(typeof app.glyph === 'string' && app.glyph.length > 0);
    assert.equal(app.colors.length, 2);
    for (const color of app.colors) assert.match(color, HEX_COLOR);
    assert.equal(getApp(app.id), app);
    assert.ok(appLabel(app).length > 0 && appLabel(app).length <= 14, `nom court trop long : ${appLabel(app)}`);
  }
  assert.equal(getApp('inconnue'), undefined);
});

test("seul l'explorateur de fichiers possède une interface complète", () => {
  assert.deepEqual(APPS.filter((app) => app.kind === 'explorer').map((app) => app.id), ['explorer']);
});

test('les applications épinglées existent et ne sont pas en double', () => {
  for (const list of [TASKBAR_PINNED, START_PINNED]) {
    assert.equal(new Set(list).size, list.length);
    for (const id of list) assert.ok(getApp(id), `application épinglée inconnue : ${id}`);
  }
  assert.equal(TASKBAR_PINNED[0], 'explorer');
});

test('chaque icône du bureau ouvre une application et un emplacement existants', () => {
  assert.equal(new Set(DESKTOP_ICONS.map((item) => item.id)).size, DESKTOP_ICONS.length);
  for (const item of DESKTOP_ICONS) {
    assert.ok(item.name.length > 0);
    assert.ok(getApp(item.open.app), `application inconnue pour l'icône ${item.id}`);
    if (item.open.location) {
      assert.equal(item.open.app, 'explorer');
      assert.ok(LOCATION_IDS.includes(item.open.location), `emplacement inconnu : ${item.open.location}`);
    }
    for (const color of item.colors) assert.match(color, HEX_COLOR);
  }
});

test("les notifications d'exemple sont datées dans le passé et renvoient à des applications connues", () => {
  const now = new Date(2026, 10, 10, 9, 0, 0);
  const notifications = createDemoNotifications(now);
  assert.ok(notifications.length >= 3);
  assert.equal(new Set(notifications.map((item) => item.id)).size, notifications.length);
  for (const item of notifications) {
    assert.ok(item.title.length > 0 && item.body.length > 0);
    assert.ok(item.time.getTime() < now.getTime());
    if (item.app) assert.ok(getApp(item.app), `application inconnue : ${item.app}`);
    else assert.ok(item.source && item.glyph && item.colors?.length === 2);
  }
  const times = notifications.map((item) => item.time.getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'de la plus récente à la plus ancienne');
});

test("les notifications annoncent clairement le caractère de démonstration", () => {
  const text = createDemoNotifications().map((item) => `${item.title} ${item.body}`).join(' ');
  assert.match(text, /simulées/);
  assert.match(text, /fictifs/);
  assert.match(text, /Aucun paramètre Windows n'est modifié/);
});

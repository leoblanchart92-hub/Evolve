/**
 * Réglages côté interface : accès aux services (core/services.js) et
 * synchronisation de l'état de l'interface avec le service des réglages
 * (shell/settings-sync.js) — jusqu'au fichier, et après un redémarrage.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { createStore } from '../src/renderer/js/core/events.js';
import { createServiceClient, ServiceError, services } from '../src/renderer/js/core/services.js';
import { PERSISTED, RESET_NOTICE, startSettingsSync, UNSAVED_NOTICE } from '../src/renderer/js/shell/settings-sync.js';
import { ui } from '../src/renderer/js/shell/ui-state.js';
import { ICON_NAMES } from '../src/renderer/js/core/icons.data.js';
import { readText } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { SETTINGS, defaultsOf } = require('../src/services/settings-schema.js');
const { createServices } = require('../src/services/index.js');

const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-sync-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

/** Laisse s'exécuter les suites de promesses en attente. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** État de l'interface neuf, aux valeurs par défaut. */
const freshStore = () => createStore(ui.snapshot());

/**
 * Faux accès aux services : consigne les appels et permet de décider des
 * réponses et d'émettre des événements.
 */
function fakeClient({ values = {}, state = { storage: 'file', durable: true, problem: null, recovered: null }, getAll } = {}) {
  const calls = [];
  const listeners = new Map();
  return {
    calls,
    available: true,
    call(service, method, ...args) {
      calls.push([service, method, ...args]);
      if (method === 'getAll') return getAll ? getAll() : Promise.resolve({ ...defaultsOf(SETTINGS), ...values });
      if (method === 'state') return Promise.resolve(state);
      if (method === 'set') return Promise.resolve(args[1]);
      return Promise.reject(new ServiceError('unknown-method', 'Méthode inconnue.'));
    },
    on(service, event, listener) {
      listeners.set(`${service}.${event}`, listener);
      return () => listeners.delete(`${service}.${event}`);
    },
    emit(service, event, payload) {
      listeners.get(`${service}.${event}`)?.(payload);
    },
    /** Appels « set » reçus : [réglage, valeur]. */
    sets: () => calls.filter((call) => call[1] === 'set').map((call) => call.slice(2)),
  };
}

// ---------------------------------------------------------------------------------
// Correspondance entre l'interface et les réglages
// ---------------------------------------------------------------------------------

test('chaque valeur de l’état de l’interface est conservée, sauf le compteur de notifications', () => {
  const uiKeys = Object.keys(ui.snapshot());
  assert.deepEqual(Object.keys(PERSISTED).sort(), uiKeys.filter((key) => key !== 'notificationCount').sort());
  // Chaque réglage défini est relié à l'interface, une seule fois.
  assert.deepEqual(Object.values(PERSISTED).sort(), Object.keys(SETTINGS).sort());
  assert.equal(new Set(Object.values(PERSISTED)).size, Object.values(PERSISTED).length);
});

test('les valeurs par défaut de l’interface et du service sont identiques', () => {
  const state = ui.snapshot();
  for (const [key, setting] of Object.entries(PERSISTED)) {
    assert.equal(state[key], SETTINGS[setting].default, `${key} / ${setting}`);
    assert.equal(typeof state[key], SETTINGS[setting].type === 'integer' ? 'number' : 'boolean', key);
  }
  // Mêmes bornes que les curseurs du panneau des paramètres rapides.
  const panel = readText('src/renderer/js/shell/quick-settings.js');
  assert.equal(Number(panel.match(/const BRIGHTNESS_MIN = (\d+);/)[1]), SETTINGS['quick.brightness'].min);
  assert.match(panel, /id: 'volume',\s+label: 'Volume',\s+min: 0,/);
  assert.match(panel, /max: '100',/);
  assert.equal(SETTINGS['quick.volume'].min, 0);
  assert.equal(SETTINGS['quick.volume'].max, 100);
  assert.equal(SETTINGS['quick.brightness'].max, 100);
});

test('les messages d’incident utilisent un pictogramme embarqué', () => {
  for (const notice of [UNSAVED_NOTICE, RESET_NOTICE]) {
    assert.ok(ICON_NAMES.includes(notice.glyph), notice.glyph);
    assert.ok(notice.title && notice.message && notice.key);
  }
  assert.notEqual(UNSAVED_NOTICE.key, RESET_NOTICE.key);
});

// ---------------------------------------------------------------------------------
// Accès aux services
// ---------------------------------------------------------------------------------

test('accès aux services : dans un navigateur, aucun service — chaque appel échoue proprement', async () => {
  const client = createServiceClient(null);
  assert.equal(client.available, false);
  await assert.rejects(client.call('settings', 'getAll'), (error) => error instanceof ServiceError && error.code === 'unavailable');
  assert.equal(typeof client.on('settings', 'changed', () => {}), 'function');
  // Hors de l'application de bureau (ces tests), l'accès par défaut est dans ce cas.
  assert.equal(services.available, false);
});

test('accès aux services : le résultat est rendu tel quel, un refus devient une erreur identifiable', async () => {
  const seen = [];
  const replies = {
    ok: { ok: true, value: { a: 1 } },
    refuse: { ok: false, code: 'unknown-key', message: 'Réglage inconnu.' },
    vide: undefined,
    etrange: { ok: 'oui' },
  };
  const host = {
    call: async (service, method, ...args) => {
      seen.push([service, method, ...args]);
      return replies[method];
    },
    on: (service, event, listener) => {
      seen.push(['on', service, event, listener]);
      return () => 'désabonné';
    },
  };
  const client = createServiceClient(host);
  assert.equal(client.available, true);
  assert.deepEqual(await client.call('essai', 'ok', 1, 'deux'), { a: 1 });
  assert.deepEqual(seen[0], ['essai', 'ok', 1, 'deux']);
  await assert.rejects(client.call('essai', 'refuse'), (error) => error instanceof ServiceError && error.code === 'unknown-key' && error.message === 'Réglage inconnu.');
  await assert.rejects(client.call('essai', 'vide'), (error) => error.code === 'failed');
  await assert.rejects(client.call('essai', 'etrange'), (error) => error.code === 'failed');

  const listener = () => {};
  assert.equal(client.on('essai', 'changed', listener)(), 'désabonné');
  assert.deepEqual(seen.at(-1), ['on', 'essai', 'changed', listener]);
});

// ---------------------------------------------------------------------------------
// Synchronisation
// ---------------------------------------------------------------------------------

test('aperçu navigateur (aucun service) : démarrage immédiat, rien n’est transmis', async () => {
  const store = freshStore();
  const sync = startSettingsSync({ store, client: createServiceClient(null) });
  assert.equal(await sync.ready, false);
  store.set('volume', 10);
  sync.onNotice(() => assert.fail('aucun message attendu'));
  await settle();
  assert.equal(store.get('volume'), 10);
});

test('démarrage : les réglages enregistrés sont appliqués avant l’ouverture du bureau, sans être renvoyés au service', async () => {
  const store = freshStore();
  const client = fakeClient({ values: { 'quick.nightLight': true, 'quick.brightness': 60, 'desktop.widgetsVisible': false, 'futur.inconnu': 1 } });
  const seen = [];
  store.subscribe('*', (change) => seen.push(change));

  const sync = startSettingsSync({ store, client });
  assert.equal(await sync.ready, true);
  assert.equal(store.get('nightLight'), true);
  assert.equal(store.get('brightness'), 60);
  assert.equal(store.get('widgetsVisible'), false);
  assert.equal(store.get('volume'), 64);
  assert.equal(seen.length, 3, 'seules les valeurs différentes changent');
  assert.equal('futur.inconnu' in store.snapshot(), false);
  await settle();
  assert.deepEqual(client.sets(), [], 'aucun écho vers le service');
  assert.deepEqual(client.calls.map((call) => call[1]).sort(), ['getAll', 'state']);
});

test('chaque changement fait dans l’interface est transmis au service, dans l’ordre', async () => {
  const store = freshStore();
  const client = fakeClient();
  await startSettingsSync({ store, client }).ready;

  store.toggle('nightLight');
  for (const value of [63, 62, 61]) store.set('volume', value);
  store.set('volume', 61); // inchangé : rien à transmettre
  store.set('notificationCount', 4); // non conservé
  // Mode avion : trois valeurs changent d'un coup.
  store.set('airplane', true);
  store.set('wifi', false);
  store.set('bluetooth', false);
  store.toggle('desktopIconsVisible');

  assert.deepEqual(client.sets(), [
    ['quick.nightLight', true],
    ['quick.volume', 63],
    ['quick.volume', 62],
    ['quick.volume', 61],
    ['quick.airplane', true],
    ['quick.wifi', false],
    ['quick.bluetooth', false],
    ['desktop.iconsVisible', false],
  ]);
});

test('un changement venu d’ailleurs est appliqué à l’interface sans être renvoyé au service', async () => {
  const store = freshStore();
  const client = fakeClient();
  await startSettingsSync({ store, client }).ready;

  store.set('volume', 30);
  client.emit('settings', 'changed', { key: 'quick.volume', value: 80 });
  client.emit('settings', 'changed', { key: 'quick.muted', value: true });
  client.emit('settings', 'changed', { key: 'futur.inconnu', value: true });
  client.emit('settings', 'changed', undefined);
  assert.equal(store.get('volume'), 80, 'même pour un réglage déjà modifié ici');
  assert.equal(store.get('muted'), true);
  assert.deepEqual(client.sets(), [['quick.volume', 30]]);
});

test('une valeur d’une autre nature que celle attendue n’entre jamais dans l’interface', async () => {
  const store = freshStore();
  const client = fakeClient({ values: { 'quick.volume': '80', 'quick.brightness': NaN, 'quick.nightLight': 1, 'quick.muted': null, 'quick.wifi': false } });
  assert.equal(await startSettingsSync({ store, client }).ready, true);
  assert.deepEqual(store.snapshot(), { ...ui.snapshot(), wifi: false }, 'seule la valeur bien formée est appliquée');

  client.emit('settings', 'changed', { key: 'quick.volume', value: undefined });
  client.emit('settings', 'changed', { key: 'quick.volume', value: { niveau: 3 } });
  client.emit('settings', 'changed', { key: 'quick.muted', value: 'oui' });
  assert.equal(store.get('volume'), 64);
  assert.equal(store.get('muted'), false);
  assert.deepEqual(client.sets(), []);
});

test('événements du service indisponibles : le chargement et l’enregistrement fonctionnent tout de même', async () => {
  const store = freshStore();
  const reports = [];
  const client = fakeClient({ values: { 'quick.volume': 20 } });
  client.on = () => {
    throw new Error('canal fermé');
  };
  const sync = startSettingsSync({ store, client, report: (message) => reports.push(message) });
  assert.equal(await sync.ready, true);
  assert.equal(store.get('volume'), 20);
  store.set('volume', 21);
  assert.deepEqual(client.sets(), [['quick.volume', 21]]);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /événements du service indisponibles : canal fermé/);
});

test('service lent : le bureau s’ouvre sans attendre ; les réglages arrivés ensuite n’écrasent pas un choix déjà fait', async () => {
  const store = freshStore();
  let answer;
  const client = fakeClient({ getAll: () => new Promise((resolve) => (answer = resolve)) });
  const sync = startSettingsSync({ store, client, timeout: 20 });

  assert.equal(await sync.ready, false, 'délai écoulé : démarrage avec les valeurs par défaut');
  store.set('volume', 5); // l'utilisateur agit avant l'arrivée des réglages
  answer({ ...defaultsOf(SETTINGS), 'quick.volume': 90, 'quick.nightLight': true });
  await settle();
  assert.equal(store.get('volume'), 5, 'le choix de l’utilisateur prime');
  assert.equal(store.get('nightLight'), true, 'les autres réglages sont appliqués');
  assert.deepEqual(client.sets(), [['quick.volume', 5]]);
});

test('service en échec : le bureau s’ouvre avec les valeurs par défaut, l’incident est consigné, rien ne lève d’exception', async () => {
  const store = freshStore();
  const reports = [];
  const client = fakeClient({ getAll: () => Promise.reject(new ServiceError('failed', 'Le service a rencontré une erreur.')) });
  client.call = ((original) => (service, method, ...args) => {
    if (method === 'set') {
      client.calls.push([service, method, ...args]);
      return Promise.reject(new ServiceError('invalid-value', 'Valeur refusée.'));
    }
    return original.call(client, service, method, ...args);
  })(client.call);

  const sync = startSettingsSync({ store, client, report: (message) => reports.push(message) });
  assert.equal(await sync.ready, false);
  assert.deepEqual(store.snapshot(), ui.snapshot());
  assert.equal(reports.length, 1);
  assert.match(reports[0], /Réglages non chargés/);

  store.set('volume', 12);
  await settle();
  assert.deepEqual(client.sets(), [['quick.volume', 12]], 'les changements sont toujours transmis');
  assert.equal(reports.length, 2);
  assert.match(reports[1], /volume.*non transmis.*Valeur refusée/);
});

test('incidents d’enregistrement : l’utilisateur est prévenu, une fois par incident', async () => {
  const failing = { storage: 'file', durable: false, problem: 'unwritable', recovered: null };
  const healthy = { storage: 'file', durable: true, problem: null, recovered: null };

  // Fichier inutilisable au démarrage : message conservé jusqu'à ce que le bureau puisse l'afficher.
  const client = fakeClient({ state: { ...healthy, recovered: 'corrupt' } });
  const sync = startSettingsSync({ store: freshStore(), client });
  await sync.ready;
  await settle();
  const shown = [];
  sync.onNotice((notice) => shown.push(notice));
  assert.deepEqual(shown, [RESET_NOTICE]);

  // L'enregistrement se met à échouer, se rétablit, échoue de nouveau.
  client.emit('settings', 'state', { ...failing, recovered: 'corrupt' });
  client.emit('settings', 'state', { ...failing, recovered: 'corrupt' });
  assert.deepEqual(shown, [RESET_NOTICE, UNSAVED_NOTICE]);
  client.emit('settings', 'state', { ...healthy, recovered: 'corrupt' });
  assert.equal(shown.length, 2, 'retour à la normale : aucun message');
  client.emit('settings', 'state', { ...failing, problem: 'unreadable' });
  assert.deepEqual(shown, [RESET_NOTICE, UNSAVED_NOTICE, UNSAVED_NOTICE]);

  // Tout va bien, ou réglages volontairement en mémoire (auto-test) : aucun message.
  for (const state of [healthy, { storage: 'memory', durable: false, problem: null, recovered: null }, undefined]) {
    const quiet = startSettingsSync({ store: freshStore(), client: fakeClient({ state }) });
    await quiet.ready;
    await settle();
    quiet.onNotice(() => assert.fail('aucun message attendu'));
  }
});

// ---------------------------------------------------------------------------------
// De l'interface au fichier, puis après un redémarrage
// ---------------------------------------------------------------------------------

/** Accès aux services branché sur la vraie couche de services, comme le fait l'application de bureau. */
function realClient(file) {
  const layer = createServices({ settingsFile: file, appVersion: 'test' });
  const host = {
    call: (service, method, ...args) => layer.hub.call(service, method, structuredClone(args), { origin: 'window' }),
    on: (service, event, listener) =>
      layer.hub.subscribe((message) => {
        if (message.origin !== 'window' && message.service === service && message.event === event) listener(message.payload);
      }),
  };
  return { layer, client: createServiceClient(host) };
}

test('de bout en bout : un réglage changé dans l’interface est sur le disque, puis retrouvé après un redémarrage', async () => {
  const file = path.join(workDir, 'Evolve', 'settings.json');

  // Première session : l'utilisateur change des réglages, puis ferme Evolve.
  const first = realClient(file);
  const store = freshStore();
  assert.equal(await startSettingsSync({ store, client: first.client }).ready, true);
  store.toggle('nightLight');
  store.toggle('widgetsVisible');
  for (const value of [90, 75, 60]) store.set('brightness', value);
  store.set('volume', 35);
  await settle();
  first.layer.flushSync();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).values, {
    'desktop.widgetsVisible': false,
    'quick.brightness': 60,
    'quick.nightLight': true,
    'quick.volume': 35,
  });

  // Seconde session : nouvelle couche de services, nouvelle interface.
  const second = realClient(file);
  const restored = freshStore();
  assert.equal(restored.get('nightLight'), false, 'avant le chargement : valeurs par défaut');
  assert.equal(await startSettingsSync({ store: restored, client: second.client }).ready, true);
  assert.deepEqual(restored.snapshot(), { ...ui.snapshot(), nightLight: true, widgetsVisible: false, brightness: 60, volume: 35 });

  // Le relire n'a rien réécrit, et l'interface n'a rien renvoyé au service.
  await settle();
  assert.equal(second.layer.settings.status().pending, false);
});

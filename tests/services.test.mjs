/**
 * Couche de services (src/services/) : point d'accès unique, emplacements
 * propres à chaque système, définition des réglages — et indépendance de la
 * couche vis-à-vis de l'interface et d'Electron.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

import { fromRoot, listFiles, relative, stripComments } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createHub, ServiceError, isPlainData, LIMITS } = require('../src/services/hub.js');
const { settingsDir, settingsFile, userConfigRoot, SETTINGS_FILE } = require('../src/services/platform.js');
const { SETTINGS, SCHEMA_VERSION, MIGRATIONS, normalize, defaultsOf } = require('../src/services/settings-schema.js');
const { createServices } = require('../src/services/index.js');

// ---------------------------------------------------------------------------------
// Indépendance de la couche
// ---------------------------------------------------------------------------------

const serviceFiles = listFiles(fromRoot('src', 'services'), ['.js']);

test('la couche de services ne dépend ni d’Electron, ni de l’interface, ni d’aucun paquet externe', () => {
  assert.ok(serviceFiles.length >= 5, `fichiers analysés : ${serviceFiles.length}`);
  for (const file of serviceFiles) {
    const code = stripComments(readFileSync(file, 'utf8'));
    const required = [...code.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]);
    assert.equal(required.length, [...code.matchAll(/\brequire\s*\(/g)].length, `${relative(file)} : forme de require non reconnue`);
    for (const name of required) {
      if (name.startsWith('node:')) continue;
      assert.match(name, /^\.\/[\w-]+$/, `${relative(file)} : dépendance hors de la couche « ${name} »`);
      assert.ok(serviceFiles.includes(path.join(path.dirname(file), `${name.slice(2)}.js`)), `${relative(file)} : module introuvable « ${name} »`);
    }
    assert.doesNotMatch(code, /\bimport\b/, `${relative(file)} : modules CommonJS uniquement`);
    // Ni fenêtre, ni page web, ni communication avec une page.
    assert.doesNotMatch(code, /\b(?:electron|BrowserWindow|webContents|ipcMain|ipcRenderer|contextBridge|document|window|navigator|localStorage)\b/, relative(file));
    // Ni réseau, ni lancement de programme, ni base de registre : rien de tout cela à cette étape.
    assert.doesNotMatch(code, /\b(?:child_process|node:https?|node:net|node:dgram|fetch|registry|regedit|powerShell|exec\(|spawn\()/i, relative(file));
  }
});

test('la couche de services se charge avec Node seul', () => {
  const services = createServices();
  assert.deepEqual(Object.keys(services.describe()), ['settings', 'files']);
  // Le service de fichiers ne sait que consulter : deux méthodes, aucun événement.
  assert.deepEqual(services.describe().files, { state: 'available', access: 'read-only', places: null, drives: null, methods: ['places', 'list'], events: [] });
  assert.equal(services.flushSync(), true);
});

// ---------------------------------------------------------------------------------
// Point d'accès
// ---------------------------------------------------------------------------------

/** Point d'accès avec un service d'essai. */
function demoHub() {
  const logs = [];
  const hub = createHub({ log: (message) => logs.push(message) });
  const calls = [];
  const emit = hub.register('essai', {
    methods: {
      echo: (context, ...args) => {
        calls.push({ context, args });
        return args;
      },
      later: async (_context, value) => {
        await new Promise((resolve) => setImmediate(resolve));
        return { value };
      },
      nothing: () => undefined,
      refuse: () => {
        throw new ServiceError('pas-possible', 'Refus expliqué.');
      },
      crash: () => {
        throw new Error('détail interne C:\\Users\\moi\\secret.txt');
      },
    },
    events: ['changed'],
    status: () => ({ state: 'limited', note: 'essai' }),
  });
  return { hub, emit, calls, logs };
}

test('point d’accès : appel d’une méthode déclarée, réponse toujours de la même forme', async () => {
  const { hub, calls } = demoHub();
  assert.deepEqual(await hub.call('essai', 'echo', [1, 'deux', { trois: [3] }, null, true], { origin: 'window' }), {
    ok: true,
    value: [1, 'deux', { trois: [3] }, null, true],
  });
  assert.deepEqual(calls[0].context, { origin: 'window' });
  assert.deepEqual(await hub.call('essai', 'echo'), { ok: true, value: [] });
  assert.deepEqual(calls[1].context, { origin: null });
  assert.deepEqual(await hub.call('essai', 'later', [7]), { ok: true, value: { value: 7 } }, 'méthode asynchrone attendue');
  assert.deepEqual(await hub.call('essai', 'nothing'), { ok: true, value: null });
});

test('point d’accès : seuls les services et les méthodes déclarés sont appelables', async () => {
  const { hub, calls } = demoHub();
  for (const name of ['inconnu', '__proto__', 'constructor', 'toString', '', 42, null, undefined, {}, ['essai']]) {
    assert.equal((await hub.call(name, 'echo')).code, 'unknown-service', String(name));
  }
  for (const method of ['inconnue', '__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf', '', 42, null, undefined, ['echo']]) {
    assert.equal((await hub.call('essai', method)).code, 'unknown-method', String(method));
  }
  assert.equal(calls.length, 0);
});

test('point d’accès : les arguments ne sont que de simples données, de taille bornée', async () => {
  const { hub, calls } = demoHub();
  const cyclic = {};
  cyclic.self = cyclic;
  const deep = [[[[[[[['trop profond']]]]]]]];
  class Custom {}
  const refused = [
    'pas une liste',
    { 0: 'pas une liste', length: 1 },
    new Array(LIMITS.args + 1).fill(0),
    [() => {}],
    [undefined],
    [Symbol('s')],
    [10n],
    [NaN],
    [Infinity],
    [new Date()],
    [new Map()],
    [new Custom()],
    [Buffer.from('abc')],
    [cyclic],
    [deep],
    ['x'.repeat(LIMITS.text + 1)],
    [{ ['k'.repeat(LIMITS.text + 1)]: 1 }],
    [new Array(LIMITS.nodes + 1).fill(0)],
    [new Array(1e9)],
  ];
  for (const [index, args] of refused.entries()) {
    const reply = await hub.call('essai', 'echo', args);
    assert.equal(reply.ok, false, `cas n° ${index}`);
    assert.equal(reply.code, 'bad-arguments', `cas n° ${index}`);
  }
  assert.equal(calls.length, 0, 'aucune méthode appelée avec des arguments refusés');

  assert.equal(isPlainData({ a: [1, 'b', null, { c: false }] }), true);
  assert.equal(isPlainData(Object.create(null)), true);
  assert.equal(isPlainData(-0.5), true);
});

test('point d’accès : une erreur prévue est expliquée, une erreur imprévue ne divulgue rien', async () => {
  const { hub, logs } = demoHub();
  assert.deepEqual(await hub.call('essai', 'refuse'), { ok: false, code: 'pas-possible', message: 'Refus expliqué.' });
  assert.deepEqual(logs, []);

  const reply = await hub.call('essai', 'crash');
  assert.deepEqual(reply, { ok: false, code: 'failed', message: 'Le service a rencontré une erreur.' });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /essai\.crash[\s\S]*secret\.txt/, 'le détail va au journal, pas à l’appelant');
});

test('point d’accès : événements déclarés, transmis avec leur origine à tous les abonnés', () => {
  const { hub, emit, logs } = demoHub();
  const seen = [];
  hub.subscribe(() => {
    throw new Error('abonné défaillant');
  });
  const unsubscribe = hub.subscribe((event) => seen.push(event));

  emit('changed', { key: 'a', value: 1 }, { origin: 'window' });
  emit('changed', { key: 'b', value: 2 });
  assert.deepEqual(seen, [
    { service: 'essai', event: 'changed', payload: { key: 'a', value: 1 }, origin: 'window' },
    { service: 'essai', event: 'changed', payload: { key: 'b', value: 2 }, origin: null },
  ]);
  assert.equal(logs.length, 2, 'un abonné en erreur est consigné sans gêner les autres');
  assert.throws(() => emit('autre', {}), /non déclaré/);

  unsubscribe();
  emit('changed', {});
  assert.equal(seen.length, 2);
});

test('point d’accès : déclaration contrôlée et inventaire des services', () => {
  const { hub } = demoHub();
  assert.throws(() => hub.register('essai', { methods: {} }), /déjà déclaré/);
  for (const name of ['', 'Majuscule', '9chiffre', 'avec espace', '__proto__', null]) {
    assert.throws(() => hub.register(name, { methods: {} }), TypeError, String(name));
  }
  assert.throws(() => hub.register('autre', { methods: { a: 'pas une fonction' } }), TypeError);

  hub.register('sans-etat', { methods: { ping: () => 'pong' } });
  hub.register('en-panne', {
    methods: {},
    status: () => {
      throw new Error('hors service');
    },
  });
  assert.deepEqual(hub.describe(), {
    essai: { state: 'limited', note: 'essai', methods: ['echo', 'later', 'nothing', 'refuse', 'crash'], events: ['changed'] },
    'sans-etat': { state: 'available', methods: ['ping'], events: [] },
    'en-panne': { state: 'unavailable', error: 'hors service', methods: [], events: [] },
  });
});

// ---------------------------------------------------------------------------------
// Emplacements propres à chaque système
// ---------------------------------------------------------------------------------

test('emplacement des réglages : %APPDATA%\\Evolve sous Windows', () => {
  const appData = 'C:\\Users\\Léo\\AppData\\Roaming';
  const dir = settingsDir({ platform: 'win32', appData });
  assert.equal(dir, 'C:\\Users\\Léo\\AppData\\Roaming\\Evolve');
  assert.equal(settingsFile(dir, { platform: 'win32' }), 'C:\\Users\\Léo\\AppData\\Roaming\\Evolve\\settings.json');
  assert.equal(SETTINGS_FILE, 'settings.json');

  // Sans indication de l'hôte : variable %APPDATA%, à défaut le dossier personnel.
  assert.equal(settingsDir({ platform: 'win32', env: { APPDATA: 'D:\\Profils\\Léo\\Roaming' }, home: 'C:\\Users\\Léo' }), 'D:\\Profils\\Léo\\Roaming\\Evolve');
  assert.equal(settingsDir({ platform: 'win32', env: {}, home: 'C:\\Users\\Léo' }), 'C:\\Users\\Léo\\AppData\\Roaming\\Evolve');
  assert.equal(settingsDir({ platform: 'win32', env: { APPDATA: 'relatif' }, home: 'C:\\Users\\Léo' }), 'C:\\Users\\Léo\\AppData\\Roaming\\Evolve');
  // Jamais le dossier local, ni le dossier temporaire.
  assert.doesNotMatch(dir, /\\Local\\|\\Temp\\/i);
});

test('emplacement des réglages : dossier de configuration de l’utilisateur sous Linux et macOS', () => {
  assert.equal(settingsDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/home/leo/.configuration' }, home: '/home/leo' }), '/home/leo/.configuration/evolve');
  assert.equal(settingsDir({ platform: 'linux', env: {}, home: '/home/leo' }), '/home/leo/.config/evolve');
  assert.equal(settingsDir({ platform: 'linux', env: { XDG_CONFIG_HOME: 'relatif' }, home: '/home/leo' }), '/home/leo/.config/evolve', 'valeur relative ignorée (norme XDG)');
  assert.equal(settingsFile('/home/leo/.config/evolve', { platform: 'linux' }), '/home/leo/.config/evolve/settings.json');
  assert.equal(settingsDir({ platform: 'darwin', env: {}, home: '/Users/leo' }), '/Users/leo/Library/Application Support/Evolve');
  // L'hôte (Electron) indique déjà le bon dossier sur chaque système.
  assert.equal(settingsDir({ platform: 'linux', appData: '/home/leo/.config' }), '/home/leo/.config/evolve');
  assert.equal(userConfigRoot({ platform: 'linux', env: {}, home: '/home/leo' }), '/home/leo/.config');
});

// ---------------------------------------------------------------------------------
// Définition des réglages
// ---------------------------------------------------------------------------------

test('réglages : chaque définition est complète et sa valeur par défaut est valide', () => {
  const keys = Object.keys(SETTINGS);
  assert.ok(keys.length >= 11);
  for (const [key, definition] of Object.entries(SETTINGS)) {
    assert.match(key, /^[a-z][A-Za-z]*\.[a-z][A-Za-z]*$/, `nom de réglage : ${key}`);
    assert.ok(['boolean', 'integer'].includes(definition.type), `${key} : type ${definition.type}`);
    if (definition.type === 'integer') {
      assert.ok(Number.isInteger(definition.min) && Number.isInteger(definition.max) && definition.min < definition.max, `${key} : bornes`);
    }
    assert.deepEqual(normalize(definition, definition.default), { ok: true, value: definition.default }, `${key} : valeur par défaut`);
  }
  assert.deepEqual(Object.keys(defaultsOf()), keys);
  assert.ok(Object.isFrozen(SETTINGS));
});

test('réglages : contrôle des valeurs — type strict, nombres ramenés dans les bornes', () => {
  const flag = { type: 'boolean', default: false };
  const level = { type: 'integer', default: 50, min: 20, max: 100 };
  assert.deepEqual(normalize(flag, true), { ok: true, value: true });
  for (const value of [1, 0, 'true', null, undefined, [], {}]) assert.deepEqual(normalize(flag, value), { ok: false }, String(value));

  assert.deepEqual(normalize(level, 60), { ok: true, value: 60 });
  assert.deepEqual(normalize(level, 59.6), { ok: true, value: 60 });
  assert.deepEqual(normalize(level, 5), { ok: true, value: 20 });
  assert.deepEqual(normalize(level, 1e9), { ok: true, value: 100 });
  assert.deepEqual(normalize(level, -Infinity), { ok: false });
  for (const value of ['60', NaN, true, null, undefined, [60]]) assert.deepEqual(normalize(level, value), { ok: false }, String(value));

  assert.deepEqual(normalize(undefined, true), { ok: false });
  assert.deepEqual(normalize({ type: 'inconnu', default: 1 }, 1), { ok: false });
});

test('réglages : chaque ancien format a sa conversion vers le suivant', () => {
  assert.ok(Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION >= 1);
  const expected = Array.from({ length: SCHEMA_VERSION - 1 }, (_unused, index) => String(index + 1));
  assert.deepEqual(Object.keys(MIGRATIONS).sort(), expected);
  for (const migrate of Object.values(MIGRATIONS)) assert.equal(typeof migrate, 'function');
});

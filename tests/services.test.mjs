/**
 * Couche de services (src/services/) : point d'accès unique, emplacements
 * propres à chaque système, définition des réglages — et indépendance de la
 * couche vis-à-vis de l'interface et d'Electron.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { fromRoot, listFiles, relative, stripComments } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createHub, ServiceError, isPlainData, LIMITS } = require('../src/services/hub.js');
const { settingsDir, settingsFile, userConfigRoot, SETTINGS_FILE } = require('../src/services/platform.js');
const { SETTINGS, SCHEMA_VERSION, MIGRATIONS, normalize, defaultsOf } = require('../src/services/settings-schema.js');
const { createServices, FILE_OPERATIONS } = require('../src/services/index.js');

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
  assert.deepEqual(Object.keys(services.describe()), ['settings', 'files', 'file-operations']);
  // Le service de fichiers ne sait que consulter : deux méthodes, aucun événement.
  assert.deepEqual(services.describe().files, { state: 'available', access: 'read-only', places: null, drives: null, methods: ['places', 'list'], events: [] });
  // Les opérations sur les fichiers ne sont pas un service : six fonctions distinctes. Sans hôte pour fournir la
  // Corbeille et l'ouverture, ni l'une ni l'autre n'est disponible — et rien ne les remplace.
  assert.deepEqual(services.describe()['file-operations'], {
    state: 'available',
    access: 'dedicated-functions',
    busy: false,
    trash: false,
    open: false,
    deletion: 'recycle-bin-only',
    replace: 'never',
    methods: ['createFolder', 'rename', 'copy', 'move', 'trash', 'open'],
    events: ['progress'],
  });
  assert.deepEqual(FILE_OPERATIONS, ['createFolder', 'rename', 'copy', 'move', 'trash', 'open']);
  assert.ok(Object.isFrozen(FILE_OPERATIONS) && Object.isFrozen(services.fileOperations));
  assert.equal(services.flushSync(), true);
});

test('opérations sur les fichiers : hors du point d’accès, une fonction par opération, des réponses toujours de la même forme', async () => {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'evolve-services-')));
  try {
    const documents = path.join(base, 'Documents');
    mkdirSync(documents);
    writeFileSync(path.join(documents, 'Lettre.txt'), 'bonjour');
    const sent = [];
    const opened = [];
    const logs = [];
    const services = createServices({
      files: { places: { documents }, drives: [], env: {} },
      operations: {
        trash: async (location) => {
          sent.push(location);
          throw new Error(`détail interne ${location}`);
        },
        openPath: async (location) => (opened.push(location), ''),
      },
      log: (message) => logs.push(message),
    });
    const { fileOperations } = services;

    // Huit fonctions, et pas une de plus : six opérations, l'arrêt et l'avancement.
    assert.deepEqual(Object.keys(fileOperations), ['createFolder', 'rename', 'copy', 'move', 'trash', 'open', 'cancel', 'onProgress']);
    assert.deepEqual(services.describe()['file-operations'].trash, true);
    assert.deepEqual(services.describe()['file-operations'].open, true);
    // Le point d'accès aux services ne les connaît pas, sous aucun nom.
    assert.deepEqual(Object.keys(services.hub.describe()), ['settings', 'files']);
    for (const method of ['createFolder', 'rename', 'copy', 'move', 'trash', 'open', 'cancel']) {
      assert.equal((await services.hub.call('files', method, [documents, 'x'])).code, 'unknown-method', method);
      assert.equal((await services.hub.call('file-operations', method, [documents, 'x'])).code, 'unknown-service', method);
    }

    // Réussite : { ok: true, value }.
    const created = await fileOperations.createFolder(documents, 'Factures');
    assert.deepEqual(created, { ok: true, value: { path: path.join(documents, 'Factures'), name: 'Factures' } });
    const renamed = await fileOperations.rename(path.join(documents, 'Lettre.txt'), 'Courrier.txt');
    assert.deepEqual(renamed, { ok: true, value: { path: path.join(documents, 'Courrier.txt'), name: 'Courrier.txt' } });
    const copied = await fileOperations.copy([renamed.value.path], created.value.path);
    assert.deepEqual([copied.ok, copied.value.done.length], [true, 1]);
    const moved = await fileOperations.move([path.join(created.value.path, 'Courrier.txt')], documents, { confirmed: true, onCollision: 'keep-both' });
    assert.deepEqual([moved.ok, moved.value.done[0].name], [true, 'Courrier - Copie.txt']);
    assert.deepEqual(await fileOperations.open(renamed.value.path), { ok: true, value: { opened: true, path: renamed.value.path, name: 'Courrier.txt' } });
    assert.deepEqual(opened, [renamed.value.path]);

    // Refus : { ok: false, code, message } — jamais d'exception, jamais de détail interne.
    const refusal = await fileOperations.createFolder(documents, 'Factures');
    assert.deepEqual(refusal, { ok: false, code: 'collision', message: 'Un élément porte déjà ce nom à cet endroit. Rien n’a été remplacé.' });
    assert.equal((await fileOperations.rename(documents, 'Autre')).code, 'protected');
    assert.equal((await fileOperations.move([renamed.value.path], created.value.path)).code, 'needs-confirmation');
    assert.equal((await fileOperations.trash([renamed.value.path])).code, 'needs-confirmation');
    assert.equal((await fileOperations.copy([path.join(base, 'ailleurs.txt')], documents)).code, 'outside-allowed');
    for (const call of [
      () => fileOperations.createFolder(),
      () => fileOperations.rename(null, null),
      () => fileOperations.copy('pas une liste', documents),
      () => fileOperations.move([renamed.value.path], documents, 'oui'),
      () => fileOperations.trash([renamed.value.path], { confirmed: true, force: true }),
      () => fileOperations.open({ path: renamed.value.path }),
      () => fileOperations.copy([renamed.value.path], documents, { onCollision: 'replace' }),
      // Données qui ne sont pas de simples données, ou démesurées.
      () => fileOperations.createFolder(documents, () => 'nom'),
      () => fileOperations.copy([renamed.value.path], documents, new Date()),
      () => fileOperations.copy(new Array(2000).fill(renamed.value.path), documents),
      () => fileOperations.createFolder(documents, 'x'.repeat(1_000_001)),
    ]) {
      const reply = await call();
      assert.deepEqual([reply.ok, reply.code, typeof reply.message], [false, 'bad-arguments', 'string'], String(call));
    }

    // La Corbeille de l'hôte échoue : l'élément reste, l'échec est signalé sans le détail (qui va au journal).
    const trashed = await fileOperations.trash([renamed.value.path], { confirmed: true });
    assert.equal(trashed.ok, true);
    assert.deepEqual(trashed.value.failed.map((item) => [item.name, item.code]), [['Courrier.txt', 'trash-failed']]);
    assert.deepEqual(sent, [renamed.value.path]);
    assert.equal(readFileSync(renamed.value.path, 'utf8'), 'bonjour');
    assert.doesNotMatch(JSON.stringify(trashed), /détail interne/);
    assert.ok(logs.some((line) => line.includes('détail interne')));

    // Arrêt : rien n'est en cours. Avancement : chaque opération annonce au moins sa fin.
    assert.deepEqual(await fileOperations.cancel('operation-1'), { ok: true, value: false });
    assert.deepEqual(await fileOperations.cancel({ id: 1 }), { ok: true, value: false });
    const seen = [];
    const unsubscribe = fileOperations.onProgress((progress) => seen.push(progress));
    await fileOperations.createFolder(documents, 'Suivi');
    assert.deepEqual(seen.map((progress) => [progress.kind, progress.state]), [['create-folder', 'finished']]);
    unsubscribe();
    await fileOperations.createFolder(documents, 'Sans suivi');
    assert.equal(seen.length, 1);

    assert.deepEqual(readdirSync(documents).sort(), ['Courrier - Copie.txt', 'Courrier.txt', 'Factures', 'Sans suivi', 'Suivi']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('opérations sur les fichiers : sans Corbeille ni ouverture fournies par l’hôte, rien n’est supprimé ni ouvert', async () => {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'evolve-services-')));
  try {
    const documents = path.join(base, 'Documents');
    mkdirSync(documents);
    writeFileSync(path.join(documents, 'Lettre.txt'), 'bonjour');
    const { fileOperations } = createServices({ files: { places: { documents }, drives: [], env: {} }, operations: { trash: 'rm -rf', openPath: null } });
    assert.equal((await fileOperations.trash([path.join(documents, 'Lettre.txt')], { confirmed: true })).code, 'trash-unavailable');
    assert.equal((await fileOperations.open(path.join(documents, 'Lettre.txt'))).code, 'open-unavailable');
    assert.deepEqual(readdirSync(documents), ['Lettre.txt']);
    // Aucun emplacement autorisé : aucune opération n'est possible, nulle part.
    const closed = createServices().fileOperations;
    assert.equal((await closed.createFolder(documents, 'Dossier')).code, 'outside-allowed');
    assert.equal((await closed.rename(path.join(documents, 'Lettre.txt'), 'x.txt')).code, 'outside-allowed');
    assert.deepEqual(readdirSync(documents), ['Lettre.txt']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
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

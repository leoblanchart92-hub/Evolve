/**
 * Service des réglages (src/services/settings.js) et écriture sûre des
 * fichiers (src/services/json-file.js) : enregistrement durable, relecture
 * après redémarrage, fichier abîmé, disque inaccessible, arrêt brutal.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { fromRoot } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createSettingsService, corruptFileFor, DEFAULT_DELAYS } = require('../src/services/settings.js');
const { readJson, writeJsonAtomic, RETRY_DELAYS } = require('../src/services/json-file.js');
const { SETTINGS, defaultsOf } = require('../src/services/settings-schema.js');
const { ServiceError } = require('../src/services/hub.js');

const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-reglages-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

let sequence = 0;
/** Fichier de réglages dans un dossier neuf, qui n'existe pas encore. */
const freshFile = () => path.join(workDir, `cas-${(sequence += 1)}`, 'Evolve', 'settings.json');

/** Service de test : journal consigné, pauses entre deux essais supprimées. */
function create(file, options = {}) {
  const logs = [];
  const sleeps = [];
  const service = createSettingsService({
    file,
    appVersion: '1.2.3',
    log: (message) => logs.push(message),
    retry: { sleep: (ms) => sleeps.push(ms) },
    ...options,
  });
  const events = [];
  service.on((event, payload, origin) => events.push({ event, payload, origin }));
  return { service, logs, sleeps, events };
}

const readFile = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeRaw = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const fault = (code) => Object.assign(new Error(`${code} : panne simulée`), { code });
/** Module de fichiers dont certaines opérations sont remplacées. */
const faultyFs = (overrides) => ({ ...fs, ...overrides });

const DURABLE = { storage: 'file', durable: true, problem: null, recovered: null };

// ---------------------------------------------------------------------------------
// Enregistrement et relecture
// ---------------------------------------------------------------------------------

test('premier lancement : valeurs par défaut, rien n’est créé sur le disque', () => {
  const file = freshFile();
  const { service } = create(file);
  assert.deepEqual(service.getAll(), defaultsOf(SETTINGS));
  assert.deepEqual(service.state(), DURABLE);
  assert.equal(service.flushSync(), true);
  assert.equal(existsSync(path.dirname(path.dirname(file))), false, 'ni fichier, ni dossier');
});

test('un changement est enregistré dans un fichier lisible, limité aux réglages modifiés', () => {
  const file = freshFile();
  const { service } = create(file, { now: () => Date.parse('2026-11-10T08:30:00.000Z') });
  assert.equal(service.set('quick.volume', 35), 35);
  assert.equal(service.set('quick.nightLight', true), true);
  assert.equal(existsSync(file), false, 'enregistrement différé');
  assert.equal(service.status().pending, true);

  assert.equal(service.flushSync(), true);
  assert.equal(
    readFileSync(file, 'utf8'),
    [
      '{',
      '  "schema": 1,',
      '  "app": "1.2.3",',
      '  "savedAt": "2026-11-10T08:30:00.000Z",',
      '  "values": {',
      '    "quick.nightLight": true,',
      '    "quick.volume": 35',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  assert.deepEqual(readdirSync(path.dirname(file)), ['settings.json'], 'aucun fichier provisoire ne reste');
  const status = service.status();
  assert.deepEqual(
    { state: status.state, file: status.file, exists: status.exists, stored: status.stored, pending: status.pending, savedAt: status.savedAt },
    { state: 'available', file, exists: true, stored: 2, pending: false, savedAt: '2026-11-10T08:30:00.000Z' },
  );
});

test('redémarrage : un nouveau service retrouve les réglages enregistrés', () => {
  const file = freshFile();
  const first = create(file).service;
  first.set('desktop.widgetsVisible', false);
  first.set('quick.brightness', 60);
  first.flushSync();

  const { service, logs } = create(file);
  assert.deepEqual(service.getAll(), { ...defaultsOf(SETTINGS), 'desktop.widgetsVisible': false, 'quick.brightness': 60 });
  assert.equal(service.get('quick.brightness'), 60);
  assert.deepEqual(service.state(), DURABLE);
  assert.equal(service.status().stored, 2);
  assert.deepEqual(logs, []);
  // Relire ne réécrit rien.
  const before = readFileSync(file, 'utf8');
  assert.equal(service.flushSync(), true);
  assert.equal(readFileSync(file, 'utf8'), before);
});

/** Programme exécuté par un processus Node distinct : `node -e CODE FICHIER ACTION`. */
const CHILD = `
  const { createServices } = require(${JSON.stringify(fromRoot('src', 'services', 'index.js'))});
  const [file, action] = process.argv.slice(1);
  const services = createServices({ settingsFile: file, appVersion: 'enfant' });
  const call = (method, ...args) => services.hub.call('settings', method, args);
  (async () => {
    if (action === 'modifier') {
      await call('set', 'quick.volume', 12);
      await call('set', 'quick.nightLight', true);
      // Aucun enregistrement explicite : le service écrit de lui-même peu après.
    } else if (action === 'arret-brutal') {
      await call('set', 'quick.volume', 77);
      services.flushSync();
      await call('set', 'quick.volume', 88);
      process.kill(process.pid, 'SIGKILL');
    } else {
      process.stdout.write(JSON.stringify(await call('getAll')));
    }
  })();
`;
const child = (file, action) => spawnSync(process.execPath, ['-e', CHILD, file, action], { encoding: 'utf8', timeout: 30_000 });

test('redémarrage réel : les réglages passent d’un processus à un autre', () => {
  const file = freshFile();
  const writer = child(file, 'modifier');
  assert.equal(writer.status, 0, writer.stderr);
  assert.deepEqual(readFile(file).values, { 'quick.nightLight': true, 'quick.volume': 12 });

  const reader = child(file, 'lire');
  assert.equal(reader.status, 0, reader.stderr);
  const reply = JSON.parse(reader.stdout);
  assert.equal(reply.ok, true);
  assert.equal(reply.value['quick.volume'], 12);
  assert.equal(reply.value['quick.nightLight'], true);
  assert.equal(reply.value['quick.brightness'], 100);
});

test('arrêt brutal du processus : le fichier reste complet, avec le dernier état enregistré', () => {
  const file = freshFile();
  const killed = child(file, 'arret-brutal');
  assert.notEqual(killed.status, 0, 'le processus a bien été interrompu');

  // Le changement fait à l'instant de l'arrêt est perdu, pas les précédents.
  assert.deepEqual(readFile(file).values, { 'quick.volume': 77 });
  const reply = JSON.parse(child(file, 'lire').stdout);
  assert.equal(reply.value['quick.volume'], 77);
  assert.deepEqual(readdirSync(path.dirname(file)), ['settings.json']);
});

// ---------------------------------------------------------------------------------
// Enregistrement différé
// ---------------------------------------------------------------------------------

/** Module de fichiers qui compte les écritures abouties. */
function countingFs() {
  const counter = { writes: 0 };
  counter.fs = faultyFs({
    renameSync: (...args) => {
      fs.renameSync(...args);
      counter.writes += 1;
    },
  });
  return counter;
}

test('enregistrement différé : une série rapprochée de changements ne fait qu’une écriture', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const file = freshFile();
  const counter = countingFs();
  const { service } = create(file, { fs: counter.fs });

  // Un curseur déplacé : une valeur toutes les 20 ms.
  for (let value = 40; value <= 60; value += 1) {
    service.set('quick.brightness', value);
    t.mock.timers.tick(20);
  }
  assert.equal(counter.writes, 0);
  t.mock.timers.tick(DEFAULT_DELAYS.debounce - 21);
  assert.equal(counter.writes, 0, 'pas avant un quart de seconde de calme');
  t.mock.timers.tick(1);
  assert.equal(counter.writes, 1);
  assert.deepEqual(readFile(file).values, { 'quick.brightness': 60 });

  t.mock.timers.tick(10_000);
  assert.equal(counter.writes, 1, 'rien d’autre sans nouveau changement');
});

test('enregistrement différé : jamais plus d’une seconde d’attente, même sans interruption des changements', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const file = freshFile();
  const counter = countingFs();
  const { service } = create(file, { fs: counter.fs });

  // Un changement toutes les 100 ms pendant 2,5 s : le délai de calme n'est jamais atteint.
  for (let step = 0; step < 25; step += 1) {
    service.set('quick.volume', step);
    if (step === 9) assert.equal(counter.writes, 0, 'à 0,9 s : pas encore');
    t.mock.timers.tick(100);
    if (step === 9) {
      assert.equal(counter.writes, 1, 'à 1 s : enregistré');
      assert.deepEqual(readFile(file).values, { 'quick.volume': 9 });
    }
  }
  assert.equal(counter.writes, 2, 'puis une écriture par seconde');
  t.mock.timers.tick(DEFAULT_DELAYS.debounce);
  assert.equal(counter.writes, 3);
  assert.deepEqual(readFile(file).values, { 'quick.volume': 24 });
  assert.deepEqual(DEFAULT_DELAYS, { debounce: 250, maxWait: 1000 });
});

test('enregistrement immédiat à la demande : une seule écriture, puis plus rien à faire', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const file = freshFile();
  const counter = countingFs();
  const { service } = create(file, { fs: counter.fs });

  service.set('quick.muted', true);
  assert.equal(service.flushSync(), true);
  assert.equal(counter.writes, 1);
  assert.equal(service.flushSync(), true);
  t.mock.timers.tick(10_000);
  assert.equal(counter.writes, 1, 'l’enregistrement différé a été annulé');

  // Redonner la même valeur ne réécrit rien.
  service.set('quick.muted', true);
  t.mock.timers.tick(10_000);
  assert.equal(counter.writes, 1);

  // `dispose` abandonne l'enregistrement programmé, sans rien écrire.
  service.set('quick.muted', false);
  service.dispose();
  t.mock.timers.tick(10_000);
  assert.equal(counter.writes, 1);
  assert.equal(service.status().pending, true);
});

// ---------------------------------------------------------------------------------
// Valeurs et événements
// ---------------------------------------------------------------------------------

test('valeurs : contrôlées avant d’être retenues ; réglage inconnu refusé', () => {
  const { service, events } = create(freshFile());
  assert.equal(service.set('quick.brightness', 150), 100, 'ramenée dans les bornes');
  assert.equal(service.set('quick.brightness', 5), 20);
  assert.equal(service.set('quick.volume', 41.7), 42);

  const refusal = (action) => {
    try {
      action();
    } catch (error) {
      assert.ok(error instanceof ServiceError);
      return error.code;
    }
    return 'accepté';
  };
  assert.equal(refusal(() => service.set('quick.volume', '42')), 'invalid-value');
  assert.equal(refusal(() => service.set('quick.muted', 1)), 'invalid-value');
  assert.equal(refusal(() => service.set('quick.muted', null)), 'invalid-value');
  for (const key of ['inconnu', '__proto__', 'constructor', 'toString', '', null, undefined, 42, {}]) {
    assert.equal(refusal(() => service.set(key, true)), 'unknown-key', String(key));
    assert.equal(refusal(() => service.get(key)), 'unknown-key', String(key));
    if (key !== null && key !== undefined) assert.equal(refusal(() => service.reset(key)), 'unknown-key', String(key));
  }
  assert.equal(service.get('quick.volume'), 42);
  assert.equal(service.get('quick.muted'), false, 'une valeur refusée ne change rien');
  assert.deepEqual(events.map((item) => item.payload), [
    { key: 'quick.brightness', value: 20 },
    { key: 'quick.volume', value: 42 },
  ]);
  service.dispose();
});

test('événements : « changed » porte l’origine et n’est émis que si la valeur change', () => {
  const file = freshFile();
  const { service, events } = create(file);
  service.set('quick.nightLight', true, { origin: 'window' });
  service.set('quick.nightLight', true, { origin: 'window' });
  service.set('quick.volume', 64); // valeur par défaut, choisie explicitement
  service.set('quick.nightLight', false);
  assert.deepEqual(events, [
    { event: 'changed', payload: { key: 'quick.nightLight', value: true }, origin: 'window' },
    { event: 'changed', payload: { key: 'quick.nightLight', value: false }, origin: null },
  ]);
  // Un choix explicite est enregistré, même s'il égale la valeur par défaut.
  service.flushSync();
  assert.deepEqual(readFile(file).values, { 'quick.nightLight': false, 'quick.volume': 64 });

  // Un abonné défaillant ne gêne ni le service ni les autres abonnés.
  const { service: other, events: seen, logs } = create(freshFile());
  const off = other.on(() => {
    throw new Error('abonné défaillant');
  });
  assert.equal(other.set('quick.muted', true), true);
  assert.equal(seen.length, 1);
  assert.equal(logs.length, 1);
  off();
  other.set('quick.muted', false);
  assert.equal(logs.length, 1);
  other.dispose();
});

test('réinitialisation : un réglage, ou tous, reprennent leur valeur par défaut', () => {
  const file = freshFile();
  const { service, events } = create(file);
  service.set('quick.volume', 10);
  service.set('quick.muted', true);
  service.set('quick.wifi', true); // égal à la valeur par défaut
  service.flushSync();
  events.length = 0;

  assert.equal(service.reset('quick.volume', { origin: 'window' })['quick.volume'], 64);
  assert.deepEqual(events, [{ event: 'changed', payload: { key: 'quick.volume', value: 64 }, origin: 'window' }]);
  service.flushSync();
  assert.deepEqual(readFile(file).values, { 'quick.muted': true, 'quick.wifi': true });

  assert.deepEqual(service.reset(), defaultsOf(SETTINGS));
  assert.deepEqual(events.map((item) => item.payload), [
    { key: 'quick.volume', value: 64 },
    { key: 'quick.muted', value: false },
  ]);
  service.flushSync();
  assert.deepEqual(readFile(file).values, {});

  // Rien à réinitialiser : aucune écriture, aucun événement.
  const before = readFileSync(file, 'utf8');
  events.length = 0;
  service.reset();
  service.reset('quick.volume');
  assert.equal(service.status().pending, false);
  assert.deepEqual(events, []);
  assert.equal(readFileSync(file, 'utf8'), before);
});

// ---------------------------------------------------------------------------------
// Fichier abîmé, ancien ou plus récent
// ---------------------------------------------------------------------------------

test('fichier au contenu inutilisable : mis de côté, valeurs par défaut, puis nouveau fichier sain', () => {
  const contents = ['', '{ "values": { "quick.volume": 1', 'bonjour', '[]', '"texte"', 'null', '{}', '{ "values": [] }', '{ "values": null }',
    '{ "schema": 0, "values": {} }', '{ "schema": "1", "values": {} }', '{ "schema": 1.5, "values": {} }', '\u0000\u0000\u0000\u0000'];
  for (const content of contents) {
    const file = freshFile();
    writeRaw(file, content);
    const { service, logs } = create(file);

    assert.deepEqual(service.getAll(), defaultsOf(SETTINGS), content);
    assert.deepEqual(service.state(), { ...DURABLE, recovered: 'corrupt' }, content);
    assert.deepEqual(readdirSync(path.dirname(file)), ['settings.corrupt.json'], content);
    assert.equal(readFileSync(corruptFileFor(file), 'utf8'), content, 'le contenu d’origine est conservé');
    assert.equal(logs.length, 1);

    service.set('quick.volume', 20);
    service.flushSync();
    assert.deepEqual(readFile(file).values, { 'quick.volume': 20 });
    assert.deepEqual(create(file).service.state(), DURABLE, 'au lancement suivant, plus rien à signaler');
  }
  assert.equal(corruptFileFor(path.join('a', 'settings.json')), path.join('a', 'settings.corrupt.json'));
});

test('fichier au contenu inutilisable et impossible à mettre de côté : il n’est pas écrasé pour autant', () => {
  const file = freshFile();
  const content = '{ "values": { "quick.volume": 12 }'; // accolade oubliée par l'utilisateur
  writeRaw(file, content);
  // Un dossier occupe la place de la copie de secours.
  mkdirSync(path.join(corruptFileFor(file), 'occupé'), { recursive: true });

  const { service, logs } = create(file);
  assert.deepEqual(service.getAll(), defaultsOf(SETTINGS));
  assert.deepEqual(service.state(), { storage: 'file', durable: false, problem: 'unreadable', recovered: null });
  assert.equal(logs.length, 1);

  service.set('quick.volume', 50);
  assert.equal(service.flushSync(), false);
  assert.equal(readFileSync(file, 'utf8'), content, 'le fichier de l’utilisateur est intact');
  assert.deepEqual(readdirSync(path.dirname(file)).sort(), ['settings.corrupt.json', 'settings.json']);
});

test('valeur invalide pour un réglage connu : valeur par défaut pour ce réglage seulement', () => {
  const file = freshFile();
  writeRaw(file, JSON.stringify({ schema: 1, values: { 'quick.volume': 'fort', 'quick.muted': 1, 'quick.brightness': 500, 'quick.nightLight': true } }));
  const { service, logs } = create(file);

  assert.equal(service.get('quick.volume'), 64);
  assert.equal(service.get('quick.muted'), false);
  assert.equal(service.get('quick.brightness'), 100, 'nombre ramené dans les bornes');
  assert.equal(service.get('quick.nightLight'), true);
  assert.deepEqual(service.state(), DURABLE, 'le fichier reste utilisable');
  assert.equal(logs.length, 2);
  assert.deepEqual(readdirSync(path.dirname(file)), ['settings.json']);

  // Au prochain enregistrement, les valeurs invalides disparaissent du fichier.
  service.set('quick.wifi', false);
  service.flushSync();
  assert.deepEqual(readFile(file).values, { 'quick.brightness': 100, 'quick.nightLight': true, 'quick.wifi': false });
});

test('fichier d’une version plus récente : réglages inconnus et numéro de format conservés', () => {
  const file = freshFile();
  const future = { 'quick.volume': 30, 'futur.theme': { nom: 'aurore', teintes: [1, 2, 3] }, 'futur.actif': true, __proto__: null };
  writeRaw(file, `{ "schema": 7, "app": "9.0.0", "values": ${JSON.stringify(future)}, "ajout": "ignoré" }`);
  // Un nom piégé ne doit ni disparaître ni altérer le service.
  writeRaw(file, readFileSync(file, 'utf8').replace('"futur.actif"', '"__proto__": { "pollution": true }, "futur.actif"'));

  const { service } = create(file);
  assert.equal(service.get('quick.volume'), 30);
  assert.deepEqual(Object.keys(service.getAll()), Object.keys(SETTINGS), 'les réglages inconnus ne sont pas exposés');
  assert.equal({}.pollution, undefined);

  service.set('quick.muted', true);
  service.flushSync();
  const saved = readFile(file);
  assert.equal(saved.schema, 7, 'le format le plus récent reste noté');
  assert.equal(saved.app, '1.2.3');
  assert.deepEqual(Object.keys(saved.values), ['__proto__', 'futur.actif', 'futur.theme', 'quick.muted', 'quick.volume']);
  assert.deepEqual(saved.values['futur.theme'], { nom: 'aurore', teintes: [1, 2, 3] });
  assert.deepEqual(Object.getOwnPropertyDescriptor(saved.values, '__proto__').value, { pollution: true });
});

test('fichier d’un ancien format : converti de proche en proche, puis réenregistré', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const definitions = { 'son.niveau': { type: 'integer', default: 50, min: 0, max: 100 }, 'son.coupe': { type: 'boolean', default: false } };
  const migrations = {
    1: ({ volume, ...rest }) => ({ ...rest, 'son.volume': volume }),
    2: ({ 'son.volume': level, ...rest }) => ({ ...rest, 'son.niveau': Math.round(level * 100) }),
  };
  const options = { definitions, schemaVersion: 3, migrations };

  const file = freshFile();
  writeRaw(file, JSON.stringify({ schema: 1, values: { volume: 0.35, 'son.coupe': true } }));
  const { service } = create(file, options);
  assert.deepEqual(service.getAll(), { 'son.niveau': 35, 'son.coupe': true });
  assert.equal(readFile(file).schema, 1, 'pas encore réenregistré');
  t.mock.timers.tick(DEFAULT_DELAYS.debounce);
  assert.deepEqual(readFile(file), { schema: 3, app: '1.2.3', savedAt: readFile(file).savedAt, values: { 'son.coupe': true, 'son.niveau': 35 } });

  // Sans numéro de format : premier format. Format courant : aucune conversion.
  const bare = freshFile();
  writeRaw(bare, JSON.stringify({ values: { volume: 0.5 } }));
  assert.equal(create(bare, options).service.get('son.niveau'), 50);
  const current = freshFile();
  writeRaw(current, JSON.stringify({ schema: 3, values: { 'son.niveau': 80, volume: 0.1 } }));
  assert.equal(create(current, options).service.get('son.niveau'), 80);

  // Conversion impossible ou absente : le fichier est mis de côté, jamais perdu.
  for (const broken of [{ 1: () => { throw new Error('conversion en panne'); }, 2: migrations[2] }, { 1: () => 'pas un objet', 2: migrations[2] }, { 2: migrations[2] }]) {
    const old = freshFile();
    writeRaw(old, JSON.stringify({ schema: 1, values: { volume: 0.35 } }));
    const { service: fallback } = create(old, { ...options, migrations: broken });
    assert.deepEqual(fallback.getAll(), { 'son.niveau': 50, 'son.coupe': false });
    assert.equal(fallback.state().recovered, 'corrupt');
    assert.deepEqual(readdirSync(path.dirname(old)), ['settings.corrupt.json']);
  }
});

test('marque invisible en tête de fichier (éditeur de texte) : tolérée', () => {
  const file = freshFile();
  writeRaw(file, `\uFEFF${JSON.stringify({ schema: 1, values: { 'quick.volume': 12 } })}`);
  const { service } = create(file);
  assert.equal(service.get('quick.volume'), 12);
  assert.deepEqual(service.state(), DURABLE);
});

// ---------------------------------------------------------------------------------
// Disque inaccessible
// ---------------------------------------------------------------------------------

test('fichier existant mais illisible : jamais écrasé, réglages gardés en mémoire pour la session', () => {
  const file = freshFile();
  const original = JSON.stringify({ schema: 1, values: { 'quick.volume': 12 } });
  writeRaw(file, original);
  let reads = 0;
  const { service, sleeps, events } = create(file, {
    fs: faultyFs({
      readFileSync: () => {
        reads += 1;
        throw fault('EACCES');
      },
    }),
  });

  assert.equal(reads, RETRY_DELAYS.length + 1, 'lecture retentée avant de renoncer');
  assert.deepEqual(sleeps, [...RETRY_DELAYS]);
  assert.deepEqual(service.state(), { storage: 'file', durable: false, problem: 'unreadable', recovered: null });
  assert.equal(service.status().state, 'limited');
  assert.match(service.status().lastError, /EACCES/);
  assert.equal(service.get('quick.volume'), 64);

  assert.equal(service.set('quick.volume', 99), 99);
  assert.equal(service.get('quick.volume'), 99, 'utilisable en mémoire');
  assert.equal(service.flushSync(), false, 'rien n’a pu être enregistré');
  assert.equal(readFileSync(file, 'utf8'), original, 'fichier intact');
  assert.deepEqual(readdirSync(path.dirname(file)), ['settings.json']);
  assert.deepEqual(events.map((item) => item.event), ['changed']);

  // Un dossier à la place du fichier : même prudence.
  const occupied = freshFile();
  mkdirSync(occupied, { recursive: true });
  const { service: other } = create(occupied);
  assert.equal(other.state().problem, 'unreadable');
  other.set('quick.muted', true);
  assert.equal(other.flushSync(), false);
  assert.deepEqual(readdirSync(path.dirname(occupied)), ['settings.json']);
});

test('écriture impossible : valeur gardée en mémoire, incident signalé une fois, reprise dès que possible', () => {
  const file = freshFile();
  let broken = true;
  const { service, events, logs } = create(file, {
    fs: faultyFs({
      mkdirSync: (...args) => {
        if (broken) throw fault('EROFS');
        return fs.mkdirSync(...args);
      },
    }),
  });

  service.set('quick.volume', 10);
  assert.equal(service.flushSync(), false);
  const failing = { storage: 'file', durable: false, problem: 'unwritable', recovered: null };
  assert.deepEqual(service.state(), failing);
  assert.equal(service.status().state, 'limited');
  assert.match(service.status().lastError, /EROFS/);
  assert.equal(service.status().pending, true);
  assert.equal(service.get('quick.volume'), 10);
  assert.equal(existsSync(path.dirname(file)), false);

  // Nouvel échec : pas de second signalement.
  service.set('quick.volume', 11);
  assert.equal(service.flushSync(), false);
  assert.deepEqual(events.filter((item) => item.event === 'state'), [{ event: 'state', payload: failing, origin: null }]);
  assert.equal(logs.length, 2);

  // Le disque redevient accessible : tout ce qui attendait est enregistré.
  broken = false;
  assert.equal(service.flushSync(), true);
  assert.deepEqual(readFile(file).values, { 'quick.volume': 11 });
  assert.deepEqual(service.state(), DURABLE);
  assert.equal(service.status().lastError, null);
  assert.deepEqual(events.filter((item) => item.event === 'state').map((item) => item.payload), [failing, DURABLE]);
});

test('dossier des réglages impossible à créer (un fichier porte son nom) : incident signalé, reprise dès que possible', () => {
  const file = freshFile();
  const dir = path.dirname(file);
  writeRaw(dir, 'un fichier occupe la place du dossier');

  const { service, events } = create(file);
  // Rien à lire : ce n'est pas un incident, tant que rien n'est à enregistrer.
  assert.deepEqual(service.state(), DURABLE);
  service.set('quick.volume', 10);
  assert.equal(service.flushSync(), false);
  assert.equal(service.state().problem, 'unwritable');
  assert.equal(readFileSync(dir, 'utf8'), 'un fichier occupe la place du dossier', 'le fichier gênant n’est pas touché');

  rmSync(dir);
  assert.equal(service.flushSync(), true);
  assert.deepEqual(readFile(file).values, { 'quick.volume': 10 });
  assert.deepEqual(events.filter((item) => item.event === 'state').map((item) => item.payload.problem), ['unwritable', null]);
});

test('écriture « tout ou rien » : une panne en cours d’écriture laisse le fichier précédent intact', () => {
  for (const [step, code] of [['openSync', 'EMFILE'], ['writeFileSync', 'ENOSPC'], ['fsyncSync', 'EIO'], ['closeSync', 'EIO'], ['renameSync', 'EXDEV']]) {
    const file = freshFile();
    const healthy = create(file).service;
    healthy.set('quick.volume', 10);
    healthy.flushSync();
    const before = readFileSync(file, 'utf8');

    let failures = 0;
    const { service } = create(file, {
      fs: faultyFs({
        [step]: (...args) => {
          // Seule l'écriture du fichier provisoire est perturbée.
          if (step === 'closeSync' || step === 'fsyncSync' || step === 'writeFileSync' ? failures === 0 : true) {
            failures += 1;
            throw fault(code);
          }
          return fs[step](...args);
        },
      }),
    });
    service.set('quick.volume', 90);
    assert.equal(service.flushSync(), false, step);
    assert.equal(service.state().problem, 'unwritable', step);
    assert.equal(readFileSync(file, 'utf8'), before, `${step} : fichier précédent intact`);
    assert.equal(create(file).service.get('quick.volume'), 10, `${step} : relecture saine`);
    assert.ok(failures >= 1, step);
  }
});

test('fichier provisoire resté après une coupure : ignoré à la lecture, remplacé à l’écriture suivante', () => {
  const file = freshFile();
  const first = create(file).service;
  first.set('quick.volume', 10);
  first.flushSync();
  writeRaw(`${file}.tmp`, '{ "schema": 1, "values": { "quick.vol');

  const { service } = create(file);
  assert.equal(service.get('quick.volume'), 10);
  assert.deepEqual(service.state(), DURABLE);
  service.set('quick.volume', 20);
  assert.equal(service.flushSync(), true);
  assert.deepEqual(readdirSync(path.dirname(file)), ['settings.json']);
  assert.deepEqual(readFile(file).values, { 'quick.volume': 20 });
});

test('fichier retenu un instant par un autre programme (antivirus) : l’opération est retentée', () => {
  // Trois refus passagers, puis le remplacement du fichier aboutit.
  const file = freshFile();
  let refusals = 3;
  const { service, sleeps } = create(file, {
    fs: faultyFs({
      renameSync: (...args) => {
        if (refusals > 0) {
          refusals -= 1;
          throw fault(['EPERM', 'EBUSY', 'EACCES'][refusals]);
        }
        return fs.renameSync(...args);
      },
    }),
  });
  service.set('quick.volume', 15);
  assert.equal(service.flushSync(), true);
  assert.deepEqual(sleeps, RETRY_DELAYS.slice(0, 3));
  assert.deepEqual(readFile(file).values, { 'quick.volume': 15 });
  assert.deepEqual(service.state(), DURABLE);

  // Refus persistant : abandon après un nombre fini d'essais, sans fichier provisoire oublié.
  const stuck = freshFile();
  let attempts = 0;
  const blocked = create(stuck, {
    fs: faultyFs({
      renameSync: () => {
        attempts += 1;
        throw fault('EPERM');
      },
    }),
  });
  blocked.service.set('quick.volume', 15);
  assert.equal(blocked.service.flushSync(), false);
  assert.equal(attempts, RETRY_DELAYS.length + 1);
  assert.deepEqual(readdirSync(path.dirname(stuck)), []);
  assert.ok(RETRY_DELAYS.reduce((total, ms) => total + ms, 0) <= 500, 'la fermeture de l’application n’est jamais retardée longtemps');
});

test('disque incapable de confirmer l’écriture (lecteur réseau) : sans gravité', () => {
  const file = freshFile();
  const { service } = create(file, {
    fs: faultyFs({
      fsyncSync: () => {
        throw fault('EINVAL');
      },
    }),
  });
  service.set('quick.volume', 15);
  assert.equal(service.flushSync(), true);
  assert.deepEqual(readFile(file).values, { 'quick.volume': 15 });
});

test('mémoire seule (aucun fichier) : les réglages fonctionnent, rien n’est lu ni écrit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const forbidden = new Proxy({}, { get: (_target, name) => () => assert.fail(`accès au disque inattendu : ${String(name)}`) });
  const { service, events } = create(null, { fs: forbidden });

  assert.deepEqual(service.state(), { storage: 'memory', durable: false, problem: null, recovered: null });
  assert.equal(service.set('quick.volume', 20), 20);
  assert.equal(service.get('quick.volume'), 20);
  t.mock.timers.tick(10_000);
  assert.equal(service.flushSync(), true);
  assert.deepEqual(events, [{ event: 'changed', payload: { key: 'quick.volume', value: 20 }, origin: null }]);
  const status = service.status();
  assert.deepEqual({ state: status.state, file: status.file, exists: status.exists, pending: status.pending }, { state: 'available', file: null, exists: false, pending: false });
});

// ---------------------------------------------------------------------------------
// Lecture et écriture d'un fichier JSON
// ---------------------------------------------------------------------------------

test('fichier JSON : lecture sans exception, écriture avec création du dossier', () => {
  const file = path.join(workDir, 'json', 'a', 'b', 'donnees.json');
  assert.deepEqual(readJson(file), { status: 'missing' });

  writeJsonAtomic(file, { texte: 'éàü — « ok »', liste: [1, 2] });
  assert.equal(readFileSync(file, 'utf8'), '{\n  "texte": "éàü — « ok »",\n  "liste": [\n    1,\n    2\n  ]\n}\n');
  assert.deepEqual(readJson(file), { status: 'ok', data: { texte: 'éàü — « ok »', liste: [1, 2] } });
  writeJsonAtomic(file, { remplace: true });
  assert.deepEqual(readJson(file).data, { remplace: true });
  assert.deepEqual(readdirSync(path.dirname(file)), ['donnees.json']);

  writeFileSync(file, '{ pas du JSON');
  assert.equal(readJson(file).status, 'corrupt');
  assert.equal(readJson(path.dirname(file)).status, 'unreadable');
  // Un fichier occupe la place du dossier : le fichier demandé n'existe pas, sur tous les systèmes.
  assert.deepEqual(readJson(path.join(file, 'settings.json')), { status: 'missing' });
  assert.throws(() => writeJsonAtomic(path.join(file, 'impossible.json'), {}), 'un fichier ne peut pas servir de dossier');
});

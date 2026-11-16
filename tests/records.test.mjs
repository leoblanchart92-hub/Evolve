/**
 * Notes et agenda (src/services/notes.js, agenda.js) et la liste de fiches
 * qui les conserve (src/services/records.js) : enregistrement durable,
 * relecture après redémarrage, limites, et — surtout — rien de perdu en
 * silence quand le fichier est abîmé, illisible ou venu d'une autre version.
 */
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const { createRecordStore, DEFAULT_DELAYS, SCHEMA_VERSION } = require('../src/services/records.js');
const { createNotesService, NOTE_LIMITS, NOTES_FILE, titleOf, excerptOf } = require('../src/services/notes.js');
const { createAgendaService, AGENDA_LIMITS, AGENDA_FILE, isCalendarDay } = require('../src/services/agenda.js');
const { setAsideUnique } = require('../src/services/json-file.js');
const { dataFile } = require('../src/services/platform.js');
const { ServiceError } = require('../src/services/hub.js');

const workDir = mkdtempSync(path.join(tmpdir(), 'evolve-fiches-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

let sequence = 0;
/** Fichier dans un dossier neuf, qui n'existe pas encore. */
const freshFile = (name = 'notes.json') => path.join(workDir, `cas-${(sequence += 1)}`, 'Evolve', name);
const readFile = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeRaw = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const fault = (code) => Object.assign(new Error(`${code} : panne simulée`), { code });
const faultyFs = (overrides) => ({ ...fs, ...overrides });

/** Horloge de test : avance d'une seconde à chaque lecture — deux fiches n'ont jamais la même date. */
function clock(start = Date.parse('2026-11-10T08:00:00Z')) {
  let time = start;
  return () => (time += 1000);
}

/** Service des notes de test : journal consigné, événements relevés, pauses supprimées. */
function notesAt(file, options = {}) {
  const logs = [];
  const service = createNotesService({ file, appVersion: '1.2.3', log: (message) => logs.push(message), now: clock(), retry: { sleep: () => {} }, ...options });
  const events = [];
  service.on((event, payload, origin) => events.push({ event, payload, origin }));
  return { service, logs, events };
}

/** Code de l'erreur de service levée par `task`. */
function codeOf(task) {
  try {
    task();
  } catch (error) {
    assert.ok(error instanceof ServiceError, `erreur inattendue : ${error?.stack ?? error}`);
    return error.code;
  }
  return 'aucune erreur';
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------------
// Notes : enregistrement et relecture
// ---------------------------------------------------------------------------------

test('notes : rien n’est créé sur le disque avant la première note ; elle est ensuite enregistrée dans un fichier lisible', () => {
  const file = freshFile();
  const { service, events } = notesAt(file);
  assert.deepEqual(service.list(), []);
  assert.deepEqual(service.state(), { storage: 'file', durable: true, problem: null, recovered: false, count: 0, limit: 200, maxLength: 20000 });
  assert.equal(existsSync(path.dirname(file)), false, 'ni fichier, ni dossier');

  const created = service.create('Courses\n\n- pain\n- lait');
  assert.match(created.id, ID);
  assert.deepEqual({ ...created, id: 'x' }, { id: 'x', title: 'Courses', excerpt: '- pain - lait', length: 22, createdAt: '2026-11-10T08:00:01.000Z', updatedAt: '2026-11-10T08:00:01.000Z' });
  assert.deepEqual(events, [{ event: 'changed', payload: { reason: 'created', id: created.id }, origin: null }]);
  assert.equal(service.status().pending, true);
  assert.equal(service.flushSync(), true);
  assert.equal(service.status().pending, false);

  const saved = readFile(file);
  assert.deepEqual(Object.keys(saved), ['schema', 'app', 'savedAt', 'items']);
  assert.equal(saved.schema, SCHEMA_VERSION);
  assert.equal(saved.app, '1.2.3');
  assert.deepEqual(saved.items, [{ id: created.id, createdAt: created.createdAt, updatedAt: created.updatedAt, text: 'Courses\n\n- pain\n- lait' }]);
  // Un fichier lisible : indenté, terminé par un saut de ligne, sans fichier provisoire à côté.
  assert.match(readFileSync(file, 'utf8'), /^\{\n {2}"schema": 1,[\s\S]*\n\}\n$/);
  assert.deepEqual(readdirSync(path.dirname(file)), ['notes.json']);
});

test('notes : un nouveau service retrouve les notes, la plus récemment modifiée en premier', () => {
  const file = freshFile();
  const first = notesAt(file).service;
  const a = first.create('Première');
  const b = first.create('Deuxième');
  const c = first.create('Troisième');
  assert.deepEqual(first.list().map((note) => note.title), ['Troisième', 'Deuxième', 'Première']);
  // Une note modifiée repasse en tête.
  const updated = first.update(a.id, 'Première, revue\nsuite');
  assert.deepEqual([updated.title, updated.excerpt, updated.createdAt === a.createdAt, updated.updatedAt > c.updatedAt], ['Première, revue', 'suite', true, true]);
  assert.deepEqual(first.list().map((note) => note.id), [a.id, c.id, b.id]);
  first.flushSync();

  const second = notesAt(file).service;
  assert.deepEqual(second.list(), first.list());
  assert.deepEqual(second.read(a.id), { ...updated, text: 'Première, revue\nsuite' });
  assert.equal(second.status().count, 3);
});

test('notes : sans changement réel, rien n’est écrit ni annoncé', () => {
  const file = freshFile();
  const { service, events } = notesAt(file);
  const note = service.create('Texte');
  service.flushSync();
  const before = readFileSync(file, 'utf8');
  events.length = 0;
  assert.deepEqual(service.update(note.id, 'Texte'), note);
  assert.deepEqual(events, []);
  assert.equal(service.status().pending, false);
  assert.equal(service.flushSync(), true);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('notes : enregistrement différé — une saisie continue ne fait qu’une écriture, sans jamais attendre plus de deux secondes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const file = freshFile();
  let time = 0;
  let writes = 0;
  const counting = faultyFs({ renameSync: (...args) => ((writes += 1), fs.renameSync(...args)) });
  const service = createNotesService({ file, now: () => time, fs: counting });
  const note = service.create('');
  // Une lettre toutes les 100 ms pendant 1,9 s : aucun enregistrement tant que la saisie se poursuit.
  for (let step = 1; step <= 19; step += 1) {
    time = step * 100;
    t.mock.timers.tick(100);
    service.update(note.id, 'x'.repeat(step));
  }
  assert.equal(writes, 0);
  // Deux secondes après le premier changement, l'enregistrement a lieu même si la saisie continue.
  time = 2000;
  t.mock.timers.tick(100);
  assert.equal(writes, 1);
  assert.equal(readFile(file).items[0].text, 'x'.repeat(19));
  // Puis, après la dernière lettre, 400 ms de calme suffisent.
  service.update(note.id, 'fin');
  time = 2399;
  t.mock.timers.tick(399);
  assert.equal(writes, 1);
  time = 2400;
  t.mock.timers.tick(1);
  assert.equal(writes, 2);
  assert.equal(readFile(file).items[0].text, 'fin');
  assert.deepEqual(DEFAULT_DELAYS, { debounce: 400, maxWait: 2000 });
});

test('notes : contenu contrôlé — texte seulement, longueur bornée, fins de ligne unifiées', () => {
  const { service } = notesAt(null);
  assert.equal(service.read(service.create('ligne 1\r\nligne 2\rligne 3').id).text, 'ligne 1\nligne 2\nligne 3');
  assert.equal(service.read(service.create().id).text, '');
  assert.equal(service.create('\tretrait conservé').title, 'retrait conservé');
  const longest = 'é'.repeat(NOTE_LIMITS.text);
  assert.equal(service.create(longest).length, NOTE_LIMITS.text);
  for (const refused of [`${longest}x`, null, 12, {}, ['texte'], 'nul \u0000 interdit', 'sonnerie \u0007', 'échappement \u001b[0m']) {
    assert.equal(codeOf(() => service.create(refused)), 'invalid-value', JSON.stringify(refused)?.slice(0, 40));
  }
  const note = service.create('Valable');
  assert.equal(codeOf(() => service.update(note.id, 42)), 'invalid-value');
  assert.equal(service.read(note.id).text, 'Valable', 'une modification refusée ne change rien');
  // Note inconnue.
  for (const id of ['inconnue', '', null, undefined, {}, '00000000-0000-4000-8000-000000000000']) {
    assert.equal(codeOf(() => service.read(id)), 'not-found');
    assert.equal(codeOf(() => service.update(id, 'x')), 'not-found');
    assert.equal(codeOf(() => service.remove(id, { confirmed: true })), 'not-found');
  }
});

test('notes : titre et aperçu', () => {
  assert.equal(titleOf(''), 'Note sans titre');
  assert.equal(titleOf('\n  \n\t\n'), 'Note sans titre');
  assert.equal(titleOf('\n\n  Liste de courses  \nPain'), 'Liste de courses');
  assert.equal(titleOf('a'.repeat(80)), 'a'.repeat(80));
  assert.equal(titleOf('a'.repeat(81)), `${'a'.repeat(79)}…`);
  assert.equal(titleOf(`${'mot '.repeat(30)}`).length <= 80, true);
  assert.equal(excerptOf('Titre'), '');
  assert.equal(excerptOf('Titre\n\n  première   ligne \n deuxième'), 'première ligne deuxième');
  assert.equal(excerptOf(`Titre\n${'b'.repeat(200)}`), `${'b'.repeat(139)}…`);
});

test('notes : une suppression est définitive, et exige une confirmation explicite', () => {
  const file = freshFile();
  const { service, events } = notesAt(file);
  const keep = service.create('À garder');
  const drop = service.create('À supprimer');
  events.length = 0;
  for (const choices of [undefined, null, {}, { confirmed: false }, { confirmed: 'oui' }, { confirmed: 1 }, true]) {
    assert.equal(codeOf(() => service.remove(drop.id, choices)), 'confirmation-required');
  }
  assert.equal(service.list().length, 2);
  assert.deepEqual(events, []);
  assert.equal(service.remove(drop.id, { confirmed: true }), true);
  assert.deepEqual(events, [{ event: 'changed', payload: { reason: 'removed', id: drop.id }, origin: null }]);
  assert.deepEqual(service.list().map((note) => note.id), [keep.id]);
  assert.equal(codeOf(() => service.remove(drop.id, { confirmed: true })), 'not-found');
  service.flushSync();
  assert.deepEqual(readFile(file).items.map((item) => item.text), ['À garder']);
});

test('notes : au plus deux cents ; au-delà, la création est refusée et rien ne change', () => {
  const { service } = notesAt(null);
  for (let index = 0; index < NOTE_LIMITS.count; index += 1) service.create(`Note ${index}`);
  assert.equal(codeOf(() => service.create('une de trop')), 'limit');
  assert.equal(service.list().length, 200);
  // Une place libérée : une note peut de nouveau être créée.
  service.remove(service.list()[0].id, { confirmed: true });
  assert.equal(service.create('après une suppression').title, 'après une suppression');
  assert.deepEqual(NOTE_LIMITS, { count: 200, text: 20000, title: 80, excerpt: 140 });
});

test('notes : sans fichier, tout fonctionne en mémoire et rien n’est lu ni écrit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { service } = notesAt(null);
  const note = service.create('En mémoire');
  service.update(note.id, 'Toujours en mémoire');
  t.mock.timers.tick(60_000);
  assert.equal(service.flushSync(), true);
  assert.deepEqual(service.state(), { storage: 'memory', durable: false, problem: null, recovered: false, count: 1, limit: 200, maxLength: 20000 });
  assert.deepEqual({ ...service.status(), savedAt: null }, { state: 'available', storage: 'memory', durable: false, problem: null, recovered: false, file: null, exists: false, count: 1, kept: 0, pending: false, savedAt: null, lastError: null, recoveredTo: null });
});

// ---------------------------------------------------------------------------------
// Rien n'est perdu en silence
// ---------------------------------------------------------------------------------

test('fichier au contenu inutilisable : mis de côté sous un nom libre — jamais à la place d’une copie précédente', () => {
  for (const [label, content] of [['texte tronqué', '{ "schema": 1, "items": [ { "id": '], ['autre chose qu’une liste', '{ "schema": 1, "items": {} }'], ['sans format', '{ "items": [] }'], ['vide', '']]) {
    const file = freshFile();
    writeRaw(file, content);
    const { service, logs } = notesAt(file, { now: () => Date.parse('2026-11-10T15:30:00Z') });
    const copy = path.join(path.dirname(file), 'notes.illisible-20261110-153000.json');
    assert.deepEqual(readdirSync(path.dirname(file)), ['notes.illisible-20261110-153000.json'], label);
    assert.equal(readFileSync(copy, 'utf8'), content, 'la copie est le fichier d’origine, intact');
    assert.deepEqual(service.list(), []);
    assert.equal(service.state().recovered, true);
    assert.equal(service.state().durable, true);
    assert.equal(service.status().recoveredTo, copy);
    assert.ok(logs.some((line) => line.includes('mis de côté')));
    // Les notes écrites ensuite vont dans un nouveau fichier, sain.
    service.create('Nouvelle note');
    service.flushSync();
    assert.equal(readFile(file).items.length, 1);

    // Le fichier s'abîme une seconde fois, à la même seconde : la première copie n'est pas remplacée.
    writeRaw(file, 'abîmé de nouveau');
    notesAt(file, { now: () => Date.parse('2026-11-10T15:30:00Z') });
    assert.deepEqual(readdirSync(path.dirname(file)).sort(), ['notes.illisible-20261110-153000-2.json', 'notes.illisible-20261110-153000.json']);
    assert.equal(readFileSync(copy, 'utf8'), content);
  }
  // La mise de côté elle-même ne remplace jamais rien, et renonce plutôt que d'écraser.
  const file = freshFile();
  writeRaw(file, 'contenu');
  assert.equal(setAsideUnique(file, '2026-11-10T15:30:00Z'), path.join(path.dirname(file), 'notes.illisible-2026-11-10T153000Z.json'));
  assert.equal(setAsideUnique(file, 'x'), null, 'plus rien à déplacer');
});

test('fichier au contenu inutilisable et impossible à mettre de côté : il n’est pas écrasé pour autant', () => {
  const file = freshFile();
  writeRaw(file, 'pas du JSON');
  const { service, logs } = notesAt(file, { fs: faultyFs({ renameSync: () => { throw fault('EPERM'); } }) });
  assert.deepEqual(service.state(), { storage: 'file', durable: false, problem: 'unreadable', recovered: false, count: 0, limit: 200, maxLength: 20000 });
  // La session continue en mémoire.
  service.create('Note de cette session');
  assert.equal(service.flushSync(), false);
  assert.equal(readFileSync(file, 'utf8'), 'pas du JSON');
  assert.ok(logs.some((line) => line.includes('impossible à mettre de côté')));
});

test('fichier existant mais illisible : jamais écrasé, les notes de la session restent en mémoire', () => {
  const file = freshFile();
  writeRaw(file, JSON.stringify({ schema: 1, items: [] }));
  const { service } = notesAt(file, { fs: faultyFs({ readFileSync: () => { throw fault('EACCES'); } }) });
  assert.equal(service.state().problem, 'unreadable');
  assert.equal(service.status().state, 'limited');
  assert.match(service.status().lastError, /EACCES/);
  service.create('Note');
  assert.equal(service.flushSync(), false);
  assert.deepEqual(readFile(file), { schema: 1, items: [] });
  assert.deepEqual(readdirSync(path.dirname(file)), ['notes.json']);
});

test('fichier d’un format plus récent : ni lu, ni modifié', () => {
  const file = freshFile();
  const content = JSON.stringify({ schema: 2, items: [{ id: 'x', contenu: { riche: true } }] });
  writeRaw(file, content);
  const { service } = notesAt(file);
  assert.equal(service.state().problem, 'newer');
  assert.deepEqual(service.list(), []);
  service.create('Note de cette session');
  assert.equal(service.flushSync(), false);
  assert.equal(readFileSync(file, 'utf8'), content);
  assert.deepEqual(readdirSync(path.dirname(file)), ['notes.json']);
});

test('fiches que cette version ne comprend pas : jamais montrées, jamais perdues — elles restent dans le fichier', () => {
  const file = freshFile();
  const good = { id: '11111111-1111-4111-8111-111111111111', createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-02T10:00:00.000Z', text: 'Note valable' };
  const strangers = [
    { id: '22222222-2222-4222-8222-222222222222', createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:00:00.000Z', text: 42 },
    { id: 'pas-un-identifiant', createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:00:00.000Z', text: 'identifiant inattendu' },
    { ...good, text: 'même identifiant qu’une autre' },
    { id: '33333333-3333-4333-8333-333333333333', createdAt: 'hier', updatedAt: 'demain', text: 'dates illisibles' },
    'un simple texte',
    null,
    { id: '44444444-4444-4444-8444-444444444444', createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:00:00.000Z', text: 'x'.repeat(NOTE_LIMITS.text + 1) },
  ];
  writeRaw(file, JSON.stringify({ schema: 1, items: [strangers[0], good, ...strangers.slice(1)] }));
  const { service, logs } = notesAt(file);
  assert.deepEqual(service.list().map((note) => note.title), ['Note valable']);
  assert.equal(service.status().kept, 7);
  assert.ok(logs.some((line) => /7 fiche\(s\) non comprise/.test(line)));

  // Après une modification, le fichier contient toujours chacune d'elles, à l'identique.
  service.update(good.id, 'Note valable, modifiée');
  const added = service.create('Nouvelle');
  service.flushSync();
  const saved = readFile(file);
  assert.deepEqual(saved.items.slice(2), strangers);
  assert.deepEqual(saved.items.slice(0, 2).map((item) => [item.id, item.text]), [[good.id, 'Note valable, modifiée'], [added.id, 'Nouvelle']]);
  // Et un nouveau lancement les retrouve dans le même état.
  assert.equal(notesAt(file).service.status().kept, 7);
});

test('écriture impossible : les notes restent en mémoire, l’incident est signalé une fois, puis l’enregistrement reprend', () => {
  const file = freshFile();
  let broken = true;
  const { service, events } = notesAt(file, { fs: faultyFs({ openSync: (...args) => (broken ? (() => { throw fault('ENOSPC'); })() : fs.openSync(...args)) }) });
  const note = service.create('Disque plein');
  assert.equal(service.flushSync(), false);
  service.update(note.id, 'Disque toujours plein');
  assert.equal(service.flushSync(), false);
  assert.deepEqual(events.filter((item) => item.event === 'state').map((item) => item.payload), [{ storage: 'file', durable: false, problem: 'unwritable', recovered: false }]);
  assert.equal(existsSync(file), false);
  assert.equal(service.read(note.id).text, 'Disque toujours plein');
  // Le disque redevient utilisable : tout est enregistré, et la reprise est annoncée.
  broken = false;
  assert.equal(service.flushSync(), true);
  assert.equal(readFile(file).items[0].text, 'Disque toujours plein');
  assert.deepEqual(events.filter((item) => item.event === 'state').at(-1).payload, { storage: 'file', durable: true, problem: null, recovered: false });
});

test('une panne en cours d’écriture laisse le fichier précédent intact', () => {
  const file = freshFile();
  let broken = false;
  const { service } = notesAt(file, { fs: faultyFs({ writeFileSync: (...args) => (broken ? (() => { throw fault('EIO'); })() : fs.writeFileSync(...args)) }) });
  const note = service.create('Version enregistrée');
  service.flushSync();
  const before = readFileSync(file, 'utf8');
  broken = true;
  service.update(note.id, 'Version perdue par la panne');
  assert.equal(service.flushSync(), false);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(readdirSync(path.dirname(file)), ['notes.json'], 'aucun fichier provisoire ne reste');
});

// ---------------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------------

test('agenda : un rendez-vous est une date réelle et un intitulé d’une ligne', () => {
  const service = createAgendaService({ now: clock() });
  const dentist = service.add('2026-11-12', '  Dentiste   14 h ');
  assert.match(dentist.id, ID);
  assert.deepEqual({ ...dentist, id: 'x' }, { id: 'x', date: '2026-11-12', title: 'Dentiste 14 h', createdAt: '2026-11-10T08:00:01.000Z' });
  assert.equal(service.add('2028-02-29', 'Année bissextile').date, '2028-02-29');
  for (const [date, title] of [
    ['2026-02-29', 'jour inexistant'],
    ['2026-04-31', 'jour inexistant'],
    ['2026-13-01', 'mois inexistant'],
    ['2026-00-10', 'mois inexistant'],
    ['2026-11-00', 'jour zéro'],
    ['1899-12-31', 'trop ancien'],
    ['2200-01-01', 'trop lointain'],
    ['12/11/2026', 'autre écriture'],
    ['2026-11-12T10:00', 'avec une heure'],
    ['2026-1-2', 'sans zéros'],
    [20261112, 'un nombre'],
    [null, 'rien'],
    ['2026-11-12', ''],
    ['2026-11-12', '   '],
    ['2026-11-12', 'x'.repeat(AGENDA_LIMITS.title + 1)],
    ['2026-11-12', 'sonnerie \u0007'],
    ['2026-11-12', 42],
    ['2026-11-12', null],
  ]) {
    assert.equal(codeOf(() => service.add(date, title)), 'invalid-value', `${date} / ${String(title).slice(0, 20)}`);
  }
  assert.equal(service.list().length, 2);
  // Un saut de ligne dans l'intitulé devient une espace : l'intitulé tient sur une ligne.
  assert.equal(service.add('2026-11-12', 'Réunion\nde chantier').title, 'Réunion de chantier');
  assert.equal(isCalendarDay('2026-11-30'), true);
  assert.equal(isCalendarDay('2026-11-31'), false);
  assert.deepEqual(AGENDA_LIMITS, { count: 2000, title: 120, minYear: 1900, maxYear: 2199 });
});

test('agenda : classé par date, puis par ordre d’inscription ; renommer, supprimer avec confirmation', () => {
  const file = freshFile('agenda.json');
  const events = [];
  const service = createAgendaService({ file, now: clock() });
  service.on((event, payload) => events.push([event, payload.reason]));
  const b = service.add('2026-12-25', 'Noël');
  const a = service.add('2026-11-12', 'Dentiste');
  const c = service.add('2026-11-12', 'Courses');
  assert.deepEqual(service.list().map((event) => event.title), ['Dentiste', 'Courses', 'Noël']);

  assert.deepEqual(service.rename(c.id, ' Courses de la semaine '), { ...c, title: 'Courses de la semaine' });
  assert.equal(codeOf(() => service.rename(c.id, '')), 'invalid-value');
  assert.equal(codeOf(() => service.rename('inconnu', 'x')), 'not-found');
  assert.equal(codeOf(() => service.remove(a.id)), 'confirmation-required');
  assert.equal(codeOf(() => service.remove(a.id, { confirmed: false })), 'confirmation-required');
  assert.equal(service.remove(a.id, { confirmed: true }), true);
  assert.deepEqual(events, [['changed', 'created'], ['changed', 'created'], ['changed', 'created'], ['changed', 'updated'], ['changed', 'removed']]);
  service.flushSync();

  // Relecture par un nouveau service.
  const again = createAgendaService({ file });
  assert.deepEqual(again.list(), [{ ...c, title: 'Courses de la semaine' }, b]);
  assert.deepEqual(again.state(), { storage: 'file', durable: true, problem: null, recovered: false, count: 2, limit: 2000, maxLength: 120 });
  assert.deepEqual(readFile(file).items.map((item) => Object.keys(item)), [['id', 'createdAt', 'updatedAt', 'date', 'title'], ['id', 'createdAt', 'updatedAt', 'date', 'title']]);
});

// ---------------------------------------------------------------------------------
// Emplacement des fichiers
// ---------------------------------------------------------------------------------

test('notes et agenda sont rangés à côté des réglages, sous des noms fixes', () => {
  assert.equal(NOTES_FILE, 'notes.json');
  assert.equal(AGENDA_FILE, 'agenda.json');
  assert.equal(dataFile('C:\\Users\\Léa\\AppData\\Roaming\\Evolve', NOTES_FILE, { platform: 'win32' }), 'C:\\Users\\Léa\\AppData\\Roaming\\Evolve\\notes.json');
  assert.equal(dataFile('/home/lea/.config/evolve', AGENDA_FILE, { platform: 'linux' }), '/home/lea/.config/evolve/agenda.json');
  // Un nom de fichier, jamais un chemin.
  for (const name of ['../notes.json', 'sous\\notes.json', 'sous/notes.json', 'notes.txt', 'Notes.json', '', null, 'C:notes.json']) {
    assert.throws(() => dataFile('/tmp', name), TypeError, String(name));
  }
});

test('liste de fiches : une description incomplète est refusée dès la construction', () => {
  assert.throws(() => createRecordStore({ label: 'x', maxCount: 10 }), TypeError);
  assert.throws(() => createRecordStore({ label: 'x', check: () => ({ ok: true, value: {} }), maxCount: 0 }), TypeError);
  assert.throws(() => createRecordStore({ check: () => ({ ok: true, value: {} }), maxCount: 10 }), TypeError);
  // Un identifiant fourni mal formé, ou déjà pris, est remplacé par un identifiant neuf.
  let calls = 0;
  const store = createRecordStore({ label: 'x', check: (fields) => ({ ok: true, value: { n: fields.n } }), maxCount: 10, newId: () => ((calls += 1) === 1 ? 'mal formé' : '55555555-5555-4555-8555-555555555555') });
  const first = store.create({ n: 1 });
  const second = store.create({ n: 2 });
  const third = store.create({ n: 3 });
  assert.match(first.id, ID);
  assert.equal(second.id, '55555555-5555-4555-8555-555555555555');
  assert.match(third.id, ID);
  assert.equal(new Set([first.id, second.id, third.id]).size, 3);
});

/** Recherche du menu Démarrer : applications, dossiers personnels, paramètres rapides. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PLACES } from '../src/renderer/js/apps/explorer-nav.js';
import { APPS, isAvailable } from '../src/renderer/js/data/apps.js';
import { normalize } from '../src/renderer/js/core/text.js';
import { matchScore, PLACE_KEYWORDS, QUICK_SETTING_ENTRIES, search } from '../src/renderer/js/shell/search.js';
import { readText } from './helpers.mjs';

const find = (query) => search(query, { apps: APPS, places: PLACES, isAvailable });
const label = (result) => result.item.name ?? result.item.label;

test('normalisation : minuscules, sans accents, sans espaces superflus', () => {
  assert.equal(normalize('  Éclairage NOCTURNE '), 'eclairage nocturne');
  assert.equal(normalize('Paramètres'), 'parametres');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
  assert.equal(normalize(42), '42');
});

test('score : début du nom, début d’un mot, contenu, mot-clé, aucun', () => {
  assert.equal(matchScore('expl', 'Explorateur de fichiers'), 0);
  assert.equal(matchScore('fich', 'Explorateur de fichiers'), 1);
  assert.equal(matchScore('nocturne', 'Éclairage nocturne'), 1);
  assert.equal(matchScore('énergie', "Économie d'énergie"), 1);
  assert.equal(matchScore('orat', 'Explorateur de fichiers'), 2);
  assert.equal(matchScore('web', 'Navigateur', ['web', 'internet']), 3);
  assert.equal(matchScore('xyz', 'Navigateur', ['web']), -1);
  assert.equal(matchScore('', 'Navigateur'), -1);
  assert.equal(matchScore('   ', 'Navigateur'), -1);
});

test('requête vide : aucun résultat', () => {
  assert.deepEqual(find(''), []);
  assert.deepEqual(find('   '), []);
});

test('« wifi » trouve le paramètre Wi-Fi', () => {
  const results = find('wifi');
  assert.ok(results.length >= 1);
  assert.equal(results[0].type, 'setting');
  assert.equal(results[0].item.id, 'wifi');
  assert.equal(results[0].available, true);
});

test('une application disponible se trouve par le début de son nom, accents facultatifs', () => {
  assert.equal(label(find('expl')[0]), 'Explorateur de fichiers');
  assert.deepEqual([find('expl')[0].type, find('expl')[0].available], ['app', true]);
  assert.equal(label(find('EXPLORATEUR')[0]), 'Explorateur de fichiers');
  // Aussi par mot-clé.
  assert.ok(find('disque').some((result) => result.type === 'app' && result.item.id === 'explorer'));
});

test('une application seulement annoncée est trouvée, mais signalée comme indisponible', () => {
  const [first] = find('parametres');
  assert.deepEqual([first.type, first.item.id, first.available], ['app', 'settings', false]);
  const internet = find('internet');
  const browser = internet.find((result) => result.type === 'app' && result.item.id === 'browser');
  assert.equal(browser.available, false);
  // Chaque résultat dit s'il peut être ouvert : le registre en décide.
  for (const result of [...find('e'), ...find('a'), ...find('o')]) {
    assert.equal(result.available, result.type === 'app' ? isAvailable(result.item) : true, label(result));
  }
});

test('un dossier personnel se trouve par son nom ou par un mot voisin', () => {
  for (const place of PLACES) {
    const results = find(place.name);
    assert.deepEqual([results[0].type, results[0].item.id], ['place', place.id], place.name);
  }
  assert.deepEqual(find('docu').map((result) => `${result.type}:${result.item.id}`), ['place:documents', 'app:explorer']);
  assert.ok(find('telech').some((result) => result.type === 'place' && result.item.id === 'downloads'), 'accents facultatifs');
  // « photos » : le dossier Images s'ouvre, l'application Photos n'existe pas encore.
  assert.deepEqual(find('photos').map((result) => `${result.type}:${result.item.id}:${result.available}`), ['place:pictures:true', 'app:photos:false']);
  // Les mots voisins désignent des dossiers personnels qui existent.
  const ids = new Set(PLACES.map((place) => place.id));
  for (const [id, words] of Object.entries(PLACE_KEYWORDS)) {
    assert.ok(ids.has(id), `mots-clés d'un dossier inconnu : ${id}`);
    assert.ok(words.length > 0);
  }
});

test('le meilleur résultat est ce que l’on peut ouvrir de plus proche, toutes sources confondues', () => {
  // « vol » : le paramètre Volume commence par la requête.
  const results = find('vol');
  assert.equal(results[0].type, 'setting');
  assert.equal(label(results[0]), 'Volume');
  // « mu » : le dossier Musique (disponible) passe avant l'application Musique (à venir), pourtant de même nom.
  assert.deepEqual(find('mu').slice(0, 2).map((result) => `${result.type}:${result.item.id}`), ['place:music', 'app:music']);
  // Seule une application à venir correspond : elle est en tête, signalée.
  assert.deepEqual(find('calculat').map((result) => [result.item.id, result.available]), [['calculator', false]]);
  // En tête, jamais une application à venir quand autre chose correspond.
  for (const query of ['e', 'a', 'c', 'im', 'vi', 'doc', 'photos', 'n']) {
    const found = find(query);
    if (found.some((result) => result.available)) assert.equal(found[0].available, true, query);
  }
});

test('après le meilleur résultat : applications (les disponibles d’abord), puis dossiers, puis paramètres', () => {
  const rest = find('e').slice(1);
  const order = { app: 0, place: 1, setting: 2 };
  const ranks = rest.map((result) => order[result.type]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  const apps = rest.filter((result) => result.type === 'app').map((result) => result.available);
  assert.deepEqual(apps, [...apps].sort((a, b) => Number(b) - Number(a)));
});

test('le nombre de résultats reste limité par source', () => {
  const results = find('e');
  const count = (type) => results.filter((result) => result.type === type).length;
  assert.ok(count('app') <= 6);
  assert.ok(count('place') <= 6);
  assert.ok(count('setting') <= 4);
  assert.ok(results.length > 3);
});

test('aucun résultat pour une requête sans correspondance', () => {
  assert.deepEqual(find('zzzz-introuvable'), []);
});

test('chaque paramètre rapide est trouvable par son libellé', () => {
  for (const entry of QUICK_SETTING_ENTRIES) {
    const results = find(entry.label);
    assert.ok(results.some((result) => result.type === 'setting' && result.item.id === entry.id), entry.label);
  }
});

test('la recherche ne propose aucun fichier : ni lecture du disque, ni fichier fictif', () => {
  const types = new Set(['e', 'a', 'doc', 'txt', 'pdf', 'budget', 'rapport'].flatMap((query) => find(query).map((result) => result.type)));
  assert.deepEqual([...types].sort(), ['app', 'place', 'setting']);
  assert.deepEqual(find('budget'), []);
  // Le module ne connaît que les sources qu'on lui confie, et n'appelle aucun service.
  const source = readText('src/renderer/js/shell/search.js');
  assert.doesNotMatch(source, /import .* from '\.\.\/core\/services\.js'|demo-files|window\.evolve/);
  // Sans dossiers personnels ni registre d'état : les applications sont toutes tenues pour disponibles.
  assert.deepEqual(search('expl', { apps: APPS }).map((result) => [result.type, result.available]), [['app', true]]);
});

/** Recherche du menu Démarrer : applications, fichiers d'exemple, paramètres rapides. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { APPS } from '../src/renderer/js/data/apps.js';
import { createDemoFileSystem } from '../src/renderer/js/data/demo-files.js';
import { normalize } from '../src/renderer/js/core/text.js';
import { matchScore, QUICK_SETTING_ENTRIES, search } from '../src/renderer/js/shell/search.js';

const files = createDemoFileSystem(new Date(2026, 10, 10, 9, 0, 0));
const find = (query) => search(query, { apps: APPS, files });
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
});

test('une application se trouve par le début de son nom, accents facultatifs', () => {
  assert.equal(label(find('expl')[0]), 'Explorateur de fichiers');
  assert.equal(find('expl')[0].type, 'app');
  assert.equal(label(find('parametres')[0]), 'Paramètres');
  assert.equal(label(find('PARAM')[0]), 'Paramètres');
});

test('une application se trouve aussi par mot-clé', () => {
  const results = find('internet');
  assert.ok(results.some((result) => result.type === 'app' && result.item.id === 'browser'));
});

test('un fichier d’exemple se trouve par son nom', () => {
  const results = find('budget');
  assert.equal(results[0].type, 'file');
  assert.equal(label(results[0]), 'Budget 2026.xlsx');
});

test('le meilleur résultat est en tête, toutes sources confondues', () => {
  for (const query of ['doc', 'lumi', 'mus', 'not', 'cal', 'e', 'a', 'pa']) {
    const results = find(query);
    assert.ok(results.length > 0, `aucun résultat pour « ${query} »`);
    const best = Math.min(...results.map((result) => result.score));
    assert.equal(results[0].score, best, `meilleur résultat mal placé pour « ${query} »`);
  }
});

test('après le meilleur résultat : applications, puis fichiers, puis paramètres', () => {
  const order = { app: 0, file: 1, setting: 2 };
  for (const query of ['doc', 'e', 'a', 'pa', 'vol']) {
    const rest = find(query).slice(1).map((result) => order[result.type]);
    assert.deepEqual(rest, [...rest].sort((a, b) => a - b), `ordre des groupes pour « ${query} »`);
  }
});

test('le nombre de résultats reste limité par source', () => {
  const results = find('e');
  const count = (type) => results.filter((result) => result.type === type).length;
  assert.ok(count('app') <= 6);
  assert.ok(count('file') <= 5);
  assert.ok(count('setting') <= 4);
  assert.equal(new Set(results.map((result) => `${result.type}:${result.item.id}`)).size, results.length, 'aucun doublon');
});

test('aucun résultat pour une requête sans correspondance', () => {
  assert.deepEqual(find('zzzzqqq'), []);
});

test('chaque paramètre rapide est trouvable par son libellé', () => {
  for (const entry of QUICK_SETTING_ENTRIES) {
    const results = find(entry.label);
    assert.ok(
      results.some((result) => result.type === 'setting' && result.item.id === entry.id),
      `« ${entry.label} » introuvable`,
    );
  }
});

/** Mise en forme française des dates, heures, tailles et nombres. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  capitalize,
  formatDayMonth,
  formatFileDate,
  formatLongDate,
  formatMonthYear,
  formatNumber,
  formatRelative,
  formatSeconds,
  formatShortDate,
  formatSize,
  formatTime,
  plural,
} from '../src/renderer/js/core/format.js';
import { plainSpaces } from './helpers.mjs';

const date = new Date(2026, 10, 10, 9, 5, 7); // mardi 10 novembre 2026, 09:05:07

test('heure et date au format français', () => {
  assert.equal(formatTime(date), '09:05');
  assert.equal(formatSeconds(date), '07');
  assert.equal(formatShortDate(date), '10/11/2026');
  assert.equal(formatLongDate(date), 'Mardi 10 novembre 2026');
  assert.equal(formatDayMonth(date), 'Mardi 10 novembre');
  assert.equal(formatMonthYear(date), 'Novembre 2026');
  assert.equal(formatFileDate(date), '10/11/2026 09:05');
});

test('nombres : virgule décimale et séparateur de milliers', () => {
  assert.equal(formatNumber(3.64, 1), '3,6');
  assert.equal(formatNumber(42), '42');
  assert.equal(plainSpaces(formatNumber(1234567.891, 1)), '1 234 567,9');
});

test('tailles de fichiers en octets, Ko, Mo, Go', () => {
  const size = (bytes) => plainSpaces(formatSize(bytes));
  assert.equal(size(0), '0 o');
  assert.equal(size(512), '512 o');
  assert.equal(size(1024), '1,0 Ko');
  assert.equal(size(1536), '1,5 Ko');
  assert.equal(size(2_398_788), '2,3 Mo');
  assert.equal(size(150 * 1024 ** 2), '150 Mo');
  assert.equal(size(1.5 * 1024 ** 3), '1,5 Go');
  assert.equal(size(3 * 1024 ** 4), '3,0 To');
  assert.equal(formatSize(null), '');
  assert.equal(formatSize(undefined), '');
  assert.equal(formatSize(Number.NaN), '');
});

test('durées relatives', () => {
  const ago = (ms) => formatRelative(new Date(date.getTime() - ms), date);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  assert.equal(ago(10_000), "À l'instant");
  assert.equal(ago(5 * minute), 'Il y a 5 min');
  assert.equal(ago(59 * minute), 'Il y a 59 min');
  assert.equal(ago(3 * hour), 'Il y a 3 h');
  assert.equal(ago(30 * hour), 'Hier');
  assert.equal(ago(3 * day), 'Il y a 3 jours');
  assert.equal(ago(10 * day), '31/10/2026');
});

test('accord du pluriel', () => {
  assert.equal(plural(0, 'élément'), '0 élément');
  assert.equal(plural(1, 'élément'), '1 élément');
  assert.equal(plural(2, 'élément'), '2 éléments');
  assert.equal(plainSpaces(plural(1200, 'élément')), '1 200 éléments');
  assert.equal(plural(3, 'journal', 'journaux'), '3 journaux');
});

test('capitalize met la première lettre en majuscule, accents compris', () => {
  assert.equal(capitalize('écran'), 'Écran');
  assert.equal(capitalize('mardi'), 'Mardi');
  assert.equal(capitalize(''), '');
});

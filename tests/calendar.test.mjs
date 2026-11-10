/** Modèle du calendrier mensuel du centre de notifications. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { monthGrid, shiftMonth, WEEKDAY_LABELS } from '../src/renderer/js/core/calendar.js';

test('la semaine commence le lundi', () => {
  assert.deepEqual([...WEEKDAY_LABELS], ['lu', 'ma', 'me', 'je', 've', 'sa', 'di']);
});

test('novembre 2026 : 6 semaines, premier jour un dimanche', () => {
  const today = new Date(2026, 10, 10);
  const grid = monthGrid(2026, 10, today);

  assert.equal(grid.length, 42);
  // Le 1er novembre 2026 est un dimanche : la grille commence le lundi 26 octobre.
  assert.equal(grid[0].date.getMonth(), 9);
  assert.equal(grid[0].day, 26);
  assert.equal(grid[0].inMonth, false);
  assert.equal(grid[6].day, 1);
  assert.equal(grid[6].inMonth, true);

  assert.equal(grid.filter((cell) => cell.inMonth).length, 30);
  const todays = grid.filter((cell) => cell.isToday);
  assert.equal(todays.length, 1);
  assert.equal(todays[0].day, 10);
  assert.equal(todays[0].inMonth, true);
});

test('chaque case suit la précédente d’un jour, chaque colonne garde son jour de semaine', () => {
  for (const [year, month] of [[2026, 0], [2026, 1], [2024, 1], [2027, 7], [2026, 11]]) {
    const grid = monthGrid(year, month, new Date(2000, 0, 1));
    assert.equal(grid.length, 42);
    grid.forEach((cell, index) => {
      assert.equal((cell.date.getDay() + 6) % 7, index % 7, 'colonne = jour de la semaine (lundi = 0)');
      if (index > 0) {
        const previous = grid[index - 1].date;
        const expected = new Date(previous.getFullYear(), previous.getMonth(), previous.getDate() + 1);
        assert.equal(cell.date.getTime(), expected.getTime());
      }
    });
    const days = new Date(year, month + 1, 0).getDate();
    assert.equal(grid.filter((cell) => cell.inMonth).length, days);
    assert.equal(grid.filter((cell) => cell.isToday).length, 0);
  }
});

test('février d’une année bissextile compte 29 jours', () => {
  assert.equal(monthGrid(2028, 1).filter((cell) => cell.inMonth).length, 29);
});

test('changement de mois avec passage d’année', () => {
  assert.deepEqual(shiftMonth(2026, 10, 1), { year: 2026, month: 11 });
  assert.deepEqual(shiftMonth(2026, 11, 1), { year: 2027, month: 0 });
  assert.deepEqual(shiftMonth(2026, 0, -1), { year: 2025, month: 11 });
  assert.deepEqual(shiftMonth(2026, 5, -18), { year: 2024, month: 11 });
  assert.deepEqual(shiftMonth(2026, 5, 0), { year: 2026, month: 5 });
});

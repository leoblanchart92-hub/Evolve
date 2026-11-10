/** Tracé des courbes d'historique des widgets. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sparklinePath } from '../src/renderer/js/widgets/sparkline.js';

/** Extrait toutes les coordonnées (x, y) d'un tracé SVG. */
function points(d) {
  const numbers = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const result = [];
  for (let i = 0; i < numbers.length; i += 2) result.push({ x: numbers[i], y: numbers[i + 1] });
  return result;
}

test('aucune valeur : tracé vide', () => {
  assert.equal(sparklinePath([]), '');
});

test('une seule valeur : simple point de départ', () => {
  assert.equal(sparklinePath([50]), 'M0 50.00');
});

test('0 % est en bas, 100 % en haut, avec une marge', () => {
  assert.equal(sparklinePath([0, 50, 100]), 'M0 94.00C5 94.00 5 50.00 10 50.00C15 50.00 15 6.00 20 6.00');
});

test('les valeurs hors limites sont ramenées entre 0 et 100', () => {
  assert.equal(sparklinePath([-40, 250]), sparklinePath([0, 100]));
});

test('la courbe reste dans le cadre et avance d’un cran par valeur', () => {
  const values = [12, 80, 33, 97, 5, 61, 61, 0, 100];
  const all = points(sparklinePath(values, { step: 10, height: 100, padding: 6 }));
  for (const { x, y } of all) {
    assert.ok(y >= 6 && y <= 94, `y = ${y} hors du cadre`);
    assert.ok(x >= 0 && x <= (values.length - 1) * 10, `x = ${x} hors du cadre`);
  }
  // Un point de départ puis trois points (deux poignées + arrivée) par segment.
  assert.equal(all.length, 1 + (values.length - 1) * 3);
  assert.equal(all.at(-1).x, (values.length - 1) * 10);
});

test('les options de taille sont respectées', () => {
  assert.equal(sparklinePath([0, 100], { step: 4, height: 40, padding: 0 }), 'M0 40.00C2 40.00 2 0.00 4 0.00');
});

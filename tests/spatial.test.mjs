/** Déplacement au clavier entre des éléments disposés à l'écran (core/spatial.js). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { arrowDirection, neighbourIndex, targetIndex } from '../src/renderer/js/core/spatial.js';

/** Case d'une grille : colonne, rangée. */
const cell = (col, row, { w = 92, h = 102, gapX = 2, gapY = 4 } = {}) => ({ left: 10 + col * (w + gapX), top: 14 + row * (h + gapY), width: w, height: h });

/** Icônes du bureau : rangées en colonnes, trois par colonne ; la dernière colonne est incomplète. */
const DESKTOP = [cell(0, 0), cell(0, 1), cell(0, 2), cell(1, 0), cell(1, 1)];

/** Grille du menu Démarrer : six tuiles par rangée, la dernière rangée incomplète. */
const GRID = Array.from({ length: 15 }, (_, index) => cell(index % 6, Math.floor(index / 6), { w: 100, h: 80 }));

/** Rangée de boutons de largeurs inégales (barre des tâches). */
const ROW = [
  { left: 20, top: 660, width: 90, height: 42 },
  { left: 500, top: 658, width: 46, height: 46 },
  { left: 552, top: 662, width: 224, height: 38 },
  { left: 786, top: 658, width: 46, height: 46 },
  { left: 1080, top: 660, width: 90, height: 42 },
  { left: 1180, top: 660, width: 80, height: 42 },
  { left: 1264, top: 660, width: 14, height: 42 },
];

const others = (rects, index) => rects.map((rect, position) => (position === index ? null : rect));

test('une touche fléchée désigne une direction', () => {
  assert.deepEqual(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map(arrowDirection), ['left', 'right', 'up', 'down']);
  for (const key of ['Home', 'End', 'Enter', 'a', '', 'Tab']) assert.equal(arrowDirection(key), null, key);
});

test('grille en colonnes (icônes du bureau) : haut et bas dans la colonne, gauche et droite d’une colonne à l’autre', () => {
  assert.equal(targetIndex('ArrowDown', 0, DESKTOP), 1);
  assert.equal(targetIndex('ArrowDown', 1, DESKTOP), 2);
  assert.equal(targetIndex('ArrowUp', 2, DESKTOP), 1);
  assert.equal(targetIndex('ArrowRight', 0, DESKTOP), 3);
  assert.equal(targetIndex('ArrowRight', 1, DESKTOP), 4);
  assert.equal(targetIndex('ArrowLeft', 3, DESKTOP), 0);
  assert.equal(targetIndex('ArrowLeft', 4, DESKTOP), 1);
  // Au bord : aucun voisin, le clavier reste où il est.
  assert.equal(targetIndex('ArrowUp', 0, DESKTOP), -1);
  assert.equal(targetIndex('ArrowLeft', 2, DESKTOP), -1);
  assert.equal(targetIndex('ArrowDown', 2, DESKTOP), -1);
  assert.equal(targetIndex('ArrowRight', 4, DESKTOP), -1);
  // Colonne voisine incomplète : l'élément le plus proche de ce côté.
  assert.equal(targetIndex('ArrowRight', 2, DESKTOP), 4);
  // Rien dessous dans une colonne plus courte : l'élément le plus proche de la rangée suivante.
  assert.equal(targetIndex('ArrowDown', 4, DESKTOP), 2);
});

test('grille en rangées (menu Démarrer) : chaque flèche mène à la tuile voisine', () => {
  assert.equal(targetIndex('ArrowRight', 0, GRID), 1);
  assert.equal(targetIndex('ArrowLeft', 1, GRID), 0);
  assert.equal(targetIndex('ArrowDown', 0, GRID), 6);
  assert.equal(targetIndex('ArrowUp', 6, GRID), 0);
  assert.equal(targetIndex('ArrowDown', 7, GRID), 13);
  // En fin de rangée, la flèche droite ne saute pas à la rangée suivante.
  assert.equal(targetIndex('ArrowRight', 5, GRID), -1);
  assert.equal(targetIndex('ArrowLeft', 6, GRID), -1);
  // Sous la dernière tuile d'une rangée complète, la dernière rangée s'arrête plus tôt : la plus proche.
  assert.equal(targetIndex('ArrowDown', 11, GRID), 14);
  // Chaque déplacement s'inverse : aller puis revenir ramène au point de départ (rangées complètes).
  for (let index = 0; index < 12; index += 1) {
    for (const [go, back] of [['ArrowRight', 'ArrowLeft'], ['ArrowDown', 'ArrowUp']]) {
      const there = targetIndex(go, index, GRID);
      if (there >= 0 && there < 12) assert.equal(targetIndex(back, there, GRID), index, `${go} depuis ${index}`);
    }
  }
});

test('rangée de boutons de tailles inégales (barre des tâches) : gauche et droite, d’un bouton au suivant', () => {
  for (let index = 0; index < ROW.length - 1; index += 1) {
    assert.equal(targetIndex('ArrowRight', index, ROW), index + 1, `droite depuis ${index}`);
    assert.equal(targetIndex('ArrowLeft', index + 1, ROW), index, `gauche depuis ${index + 1}`);
  }
  assert.equal(targetIndex('ArrowLeft', 0, ROW), -1);
  assert.equal(targetIndex('ArrowRight', ROW.length - 1, ROW), -1);
  // Rien au-dessus ni au-dessous dans une rangée.
  assert.equal(targetIndex('ArrowUp', 2, ROW), -1);
  assert.equal(targetIndex('ArrowDown', 2, ROW), -1);
});

test('Début et Fin mènent au premier et au dernier élément', () => {
  assert.equal(targetIndex('Home', 3, DESKTOP), 0);
  assert.equal(targetIndex('End', 0, DESKTOP), 4);
  assert.equal(targetIndex('Home', -1, GRID), 0);
  assert.equal(targetIndex('End', -1, GRID), 14);
});

test('sans élément courant, la première flèche mène au premier élément', () => {
  for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight']) assert.equal(targetIndex(key, -1, DESKTOP), 0, key);
  assert.equal(targetIndex('ArrowDown', 99, DESKTOP), 0, 'rang inconnu');
});

test('un élément masqué (sans surface) n’est jamais atteint', () => {
  const hidden = { left: 0, top: 0, width: 0, height: 0 };
  const rects = [cell(0, 0), hidden, cell(0, 2), null, cell(1, 0)];
  assert.equal(targetIndex('ArrowDown', 0, rects), 2, 'l’élément masqué est enjambé');
  assert.equal(targetIndex('Home', 4, [hidden, cell(0, 1), cell(0, 2)]), 1);
  assert.equal(targetIndex('End', 0, [cell(0, 0), cell(0, 1), hidden, null]), 1);
  // Aucun élément visible : rien.
  assert.equal(targetIndex('ArrowDown', -1, [hidden, null]), -1);
  assert.equal(targetIndex('Home', 0, []), -1);
});

test('une touche qui ne déplace rien est ignorée', () => {
  for (const key of ['Enter', 'a', ' ', 'Tab', 'Escape', 'PageDown']) assert.equal(targetIndex(key, 0, DESKTOP), -1, key);
});

test('voisin : un élément aligné l’emporte sur un élément plus proche en diagonale', () => {
  const origin = { left: 0, top: 0, width: 100, height: 100 };
  const aligned = { left: 400, top: 0, width: 100, height: 100 };
  const diagonal = { left: 110, top: 120, width: 100, height: 100 };
  assert.equal(neighbourIndex(origin, [diagonal, aligned], 'right'), 1);
  // Sans élément aligné, le plus proche de ce côté.
  assert.equal(neighbourIndex(origin, [diagonal], 'right'), 0);
  assert.equal(neighbourIndex(origin, [diagonal], 'down'), 0);
  // De l'autre côté : rien.
  assert.equal(neighbourIndex(origin, [diagonal, aligned], 'left'), -1);
  assert.equal(neighbourIndex(origin, [diagonal, aligned], 'up'), -1);
  // Direction inconnue, origine absente.
  assert.equal(neighbourIndex(origin, [aligned], 'diagonale'), -1);
  assert.equal(neighbourIndex(null, [aligned], 'right'), -1);
  // Deux éléments superposés (même centre) ne sont voisins dans aucune direction.
  for (const direction of ['left', 'right', 'up', 'down']) assert.equal(neighbourIndex(origin, [{ ...origin }], direction), -1, direction);
  assert.deepEqual(others(DESKTOP, 1)[1], null);
});

/** Géométrie des fenêtres : placement initial, déplacement, changement de résolution. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { centeredRect, clampWindowPosition, fitRectToArea } from '../src/renderer/js/wm/geometry.js';

const area = { w: 1920, h: 1004 };

test('une nouvelle fenêtre est centrée, légèrement au-dessus du milieu', () => {
  const rect = centeredRect(area, { w: 992, h: 640 });
  assert.deepEqual(rect, { x: 464, y: 153, w: 992, h: 640 });
});

test('les fenêtres suivantes sont décalées en cascade sans sortir de la zone', () => {
  const second = centeredRect(area, { w: 992, h: 640 }, { margin: 16, offsetX: 32, offsetY: 32 });
  assert.deepEqual(second, { x: 496, y: 185, w: 992, h: 640 });

  const far = centeredRect(area, { w: 992, h: 640 }, { margin: 16, offsetX: 5000, offsetY: 5000 });
  assert.equal(far.x, area.w - 992 - 16);
  assert.equal(far.y, area.h - 640 - 16);
});

test('une fenêtre trop grande est réduite à la zone de travail', () => {
  const rect = centeredRect({ w: 800, h: 500 }, { w: 992, h: 640 }, { margin: 16 });
  assert.deepEqual(rect, { x: 16, y: 16, w: 768, h: 468 });
});

test('déplacement : le haut de la fenêtre ne sort jamais de l’écran', () => {
  const position = clampWindowPosition({ x: 100, y: -250, w: 800 }, area);
  assert.deepEqual(position, { x: 100, y: 0 });
});

test('déplacement : la barre de titre reste au-dessus de la barre des tâches', () => {
  const position = clampWindowPosition({ x: 100, y: 5000, w: 800 }, area, { titlebar: 42 });
  assert.deepEqual(position, { x: 100, y: area.h - 42 });
});

test('déplacement : une partie saisissable de la barre de titre reste visible', () => {
  const options = { keepLeft: 200, keepRight: 96, titlebar: 42 };
  // Vers la gauche : 200 px de la fenêtre restent à l'écran.
  assert.equal(clampWindowPosition({ x: -5000, y: 10, w: 800 }, area, options).x, -600);
  // Vers la droite : 96 px restent à l'écran.
  assert.equal(clampWindowPosition({ x: 5000, y: 10, w: 800 }, area, options).x, area.w - 96);
  // Fenêtre plus étroite que la marge : elle reste entièrement visible à gauche.
  assert.equal(clampWindowPosition({ x: -5000, y: 10, w: 150 }, area, options).x, 0);
});

test('déplacement : une position valide n’est pas modifiée', () => {
  assert.deepEqual(clampWindowPosition({ x: 321, y: 123, w: 800 }, area), { x: 321, y: 123 });
});

test('changement de résolution : la fenêtre est ramenée dans la zone', () => {
  const rect = fitRectToArea({ x: 1500, y: 700, w: 992, h: 640 }, { w: 1280, h: 660 }, { minW: 352, minH: 224 });
  assert.deepEqual(rect, { x: 288, y: 20, w: 992, h: 640 });
});

test('changement de résolution : une fenêtre trop grande est réduite', () => {
  const rect = fitRectToArea({ x: 40, y: 40, w: 1600, h: 900 }, { w: 1024, h: 700 }, { minW: 352, minH: 224 });
  assert.deepEqual(rect, { x: 0, y: 0, w: 1024, h: 700 });
});

test('changement de résolution : une fenêtre déjà visible ne bouge pas', () => {
  const rect = { x: 100, y: 80, w: 800, h: 500 };
  assert.deepEqual(fitRectToArea(rect, area, { minW: 352, minH: 224 }), rect);
});

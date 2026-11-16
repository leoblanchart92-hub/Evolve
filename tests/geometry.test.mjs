/** Géométrie des fenêtres : placement initial, déplacement, redimensionnement, ancrage, changement de résolution. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cascadeRect, centeredRect, clampWindowPosition, detachedRect, fitRectToArea, isRect, reachableRect, resizedRect, snapRect, snapZoneAt } from '../src/renderer/js/wm/geometry.js';

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

// --- Ancrage sur une moitié de l'écran ------------------------------------------------

test('ancrage : les deux moitiés se touchent sans se recouvrir, quelle que soit la largeur', () => {
  for (const width of [1920, 1281, 1024, 961]) {
    const zone = { w: width, h: 644 };
    const left = snapRect(zone, 'left');
    const right = snapRect(zone, 'right');
    assert.deepEqual([left.x, left.y, left.h, right.y, right.h], [0, 0, 644, 0, 644]);
    assert.equal(left.w + right.w, width, `largeur ${width}`);
    assert.equal(right.x, left.w, 'la moitié droite commence où finit la gauche');
    assert.ok(Math.abs(left.w - right.w) <= 1);
  }
  assert.deepEqual(snapRect(area, 'top'), { x: 0, y: 0, w: 1920, h: 1004 });
  for (const unknown of ['bottom', '', null, undefined]) assert.equal(snapRect(area, unknown), null);
});

test('ancrage : la zone désignée par le pointeur — bord gauche, bord droit, bord supérieur', () => {
  const edge = { edge: 12 };
  assert.equal(snapZoneAt({ x: 0, y: 400 }, area, edge), 'left');
  assert.equal(snapZoneAt({ x: 12, y: 400 }, area, edge), 'left');
  assert.equal(snapZoneAt({ x: 13, y: 400 }, area, edge), null);
  assert.equal(snapZoneAt({ x: 1919, y: 400 }, area, edge), 'right');
  assert.equal(snapZoneAt({ x: 1908, y: 400 }, area, edge), 'right');
  assert.equal(snapZoneAt({ x: 1907, y: 400 }, area, edge), null);
  assert.equal(snapZoneAt({ x: 900, y: 0 }, area, edge), 'top');
  assert.equal(snapZoneAt({ x: 900, y: 12 }, area, edge), 'top');
  assert.equal(snapZoneAt({ x: 900, y: 13 }, area, edge), null);
  // Dans un coin, le côté l'emporte sur l'agrandissement.
  assert.equal(snapZoneAt({ x: 3, y: 3 }, area, edge), 'left');
  assert.equal(snapZoneAt({ x: 1917, y: 3 }, area, edge), 'right');
  // Au milieu de l'écran : rien.
  assert.equal(snapZoneAt({ x: 900, y: 500 }, area, edge), null);
  // Sous la zone de travail (au-dessus de la barre des tâches) : rien, même contre un bord.
  assert.equal(snapZoneAt({ x: 0, y: 1005 }, area, edge), null);
  assert.equal(snapZoneAt({ x: 1919, y: 1040 }, area, edge), null);
  // Pointeur sorti de la fenêtre par le haut ou par un côté : le bord correspondant.
  assert.equal(snapZoneAt({ x: 900, y: -40 }, area, edge), 'top');
  assert.equal(snapZoneAt({ x: -25, y: 300 }, area, edge), 'left');
  assert.equal(snapZoneAt({ x: 2500, y: 300 }, area, edge), 'right');
  // Position inutilisable, ou zone vide : rien.
  for (const point of [null, undefined, {}, { x: NaN, y: 3 }, { x: 3, y: Infinity }]) assert.equal(snapZoneAt(point, area, edge), null);
  assert.equal(snapZoneAt({ x: 0, y: 0 }, { w: 0, h: 0 }, edge), null);
});

test('fenêtre détachée d’un état agrandi ou ancré : sa barre de titre reste sous le pointeur', () => {
  const size = { w: 800, h: 500 };
  // Agrandie, saisie aux trois quarts de sa largeur : le pointeur reste aux trois quarts de la fenêtre libre.
  assert.deepEqual(detachedRect({ x: 1440, y: 14 }, { x: 0, y: 0, w: 1920, h: 1004 }, size), { x: 840, y: 0, w: 800, h: 500 });
  // Saisie tout à gauche, tout à droite.
  assert.equal(detachedRect({ x: 0, y: 10 }, { x: 0, y: 0, w: 1920, h: 1004 }, size).x, 0);
  assert.equal(detachedRect({ x: 1920, y: 10 }, { x: 0, y: 0, w: 1920, h: 1004 }, size).x, 1120);
  // Ancrée à droite, saisie en son milieu.
  assert.deepEqual(detachedRect({ x: 1440, y: 20 }, { x: 960, y: 0, w: 960, h: 1004 }, size), { x: 1040, y: 0, w: 800, h: 500 });
  // Pointeur hors du rectangle d'origine : la proportion est bornée.
  assert.equal(detachedRect({ x: -50, y: 5 }, { x: 0, y: 0, w: 1920, h: 1004 }, size).x, -50);
  assert.equal(detachedRect({ x: 5000, y: 5 }, { x: 0, y: 0, w: 1920, h: 1004 }, size).x, 4200);
});

// --- Fenêtres en cascade ----------------------------------------------------------------

test('une fenêtre de plus s’ouvre décalée ; arrivée au bord, la cascade repart du coin', () => {
  const first = { x: 464, y: 153, w: 992, h: 640 };
  const second = cascadeRect(first, area, { stepX: 28, stepY: 24 });
  assert.deepEqual(second, { x: 492, y: 177, w: 992, h: 640 });
  // Plus de place à droite : retour à gauche, la descente continue.
  assert.deepEqual(cascadeRect({ x: 910, y: 177, w: 992, h: 640 }, area, { stepX: 28, stepY: 24 }), { x: 0, y: 201, w: 992, h: 640 });
  // Plus de place en bas : retour en haut.
  assert.deepEqual(cascadeRect({ x: 100, y: 350, w: 992, h: 640 }, area, { stepX: 28, stepY: 24 }), { x: 128, y: 0, w: 992, h: 640 });
  // Marge demandée ; fenêtre plus grande que la zone : ramenée à la zone.
  assert.deepEqual(cascadeRect({ x: 910, y: 350, w: 992, h: 640 }, area, { stepX: 28, stepY: 24, margin: 16 }), { x: 16, y: 16, w: 992, h: 640 });
  assert.deepEqual(cascadeRect({ x: 0, y: 0, w: 4000, h: 3000 }, area), { x: 0, y: 0, w: 1920, h: 1004 });
  // Douze fenêtres de suite restent toutes dans la zone de travail.
  let rect = first;
  for (let index = 0; index < 12; index += 1) {
    rect = cascadeRect(rect, area, { stepX: 28, stepY: 24 });
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= area.w && rect.y + rect.h <= area.h, JSON.stringify(rect));
  }
});

// --- Redimensionnement -----------------------------------------------------------------------

test('redimensionnement : chaque poignée déplace les bords qu’elle tient, et eux seuls', () => {
  const start = { x: 400, y: 200, w: 800, h: 500 };
  const limits = { minW: 352, minH: 224 };
  const resize = (dir, dx, dy) => resizedRect(start, dir, dx, dy, area, limits);
  assert.deepEqual(resize('e', 50, 999), { x: 400, y: 200, w: 850, h: 500 });
  assert.deepEqual(resize('s', 999, 40), { x: 400, y: 200, w: 800, h: 540 });
  assert.deepEqual(resize('w', -50, 999), { x: 350, y: 200, w: 850, h: 500 });
  assert.deepEqual(resize('n', 999, -40), { x: 400, y: 160, w: 800, h: 540 });
  assert.deepEqual(resize('se', 30, 20), { x: 400, y: 200, w: 830, h: 520 });
  assert.deepEqual(resize('nw', 30, 20), { x: 430, y: 220, w: 770, h: 480 });
  assert.deepEqual(resize('ne', 30, 20), { x: 400, y: 220, w: 830, h: 480 });
  assert.deepEqual(resize('sw', 30, 20), { x: 430, y: 200, w: 770, h: 520 });
  // Sans déplacement : rien ne change.
  for (const dir of ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw']) assert.deepEqual(resize(dir, 0, 0), start, dir);
});

test('redimensionnement : taille minimale, haut de l’écran et zone de travail respectés', () => {
  const start = { x: 400, y: 200, w: 800, h: 500 };
  const limits = { minW: 352, minH: 224 };
  const resize = (dir, dx, dy) => resizedRect(start, dir, dx, dy, area, limits);
  // Taille minimale : le bord opposé ne bouge pas.
  assert.deepEqual(resize('e', -5000, 0), { x: 400, y: 200, w: 352, h: 500 });
  assert.deepEqual(resize('w', 5000, 0), { x: 848, y: 200, w: 352, h: 500 });
  assert.deepEqual(resize('s', 0, -5000), { x: 400, y: 200, w: 800, h: 224 });
  assert.deepEqual(resize('n', 0, 5000), { x: 400, y: 476, w: 800, h: 224 });
  // Le bord supérieur ne dépasse jamais le haut de l'écran.
  assert.deepEqual(resize('n', 0, -5000), { x: 400, y: 0, w: 800, h: 700 });
  // Le bord inférieur ne descend pas sous la zone de travail.
  assert.deepEqual(resize('s', 0, 5000), { x: 400, y: 200, w: 800, h: 804 });
  // Fenêtre qui dépassait déjà en bas : elle ne grandit plus vers le bas, mais ne rétrécit pas d'elle-même.
  const low = { x: 100, y: 900, w: 800, h: 500 };
  assert.deepEqual(resizedRect(low, 's', 0, 300, area, limits), low);
  assert.deepEqual(resizedRect(low, 's', 0, -100, area, limits), { x: 100, y: 900, w: 800, h: 400 });
  // Sans limites : jamais de taille négative.
  const tiny = resizedRect(start, 'se', -9999, -9999, area);
  assert.deepEqual([tiny.w, tiny.h], [0, 0]);
});

// --- Contrôle d'un rectangle -----------------------------------------------------------------

test('disposition retrouvée : la fenêtre revient où elle avait été laissée, même en partie hors de l’écran', () => {
  const area = { w: 1280, h: 654 };
  const keep = { keepLeft: 200, keepRight: 96, titlebar: 40 };
  // Laissée dépassant en bas, puis à gauche, puis à droite : rien ne bouge — ce qu'un déplacement permet est conservé.
  for (const rect of [
    { x: 287, y: 146, w: 868, h: 560 },
    { x: -600, y: 20, w: 868, h: 560 },
    { x: 1150, y: 600, w: 868, h: 560 },
  ]) {
    assert.deepEqual(reachableRect(rect, area, { minW: 400, minH: 260, ...keep }), rect);
    // Un déplacement à la souris l'aurait laissée au même endroit.
    assert.deepEqual(clampWindowPosition(rect, area, keep), { x: rect.x, y: rect.y });
  }
  // « Remise entière dans l'écran » serait une autre règle : celle d'un changement de résolution.
  assert.notDeepEqual(fitRectToArea({ x: 287, y: 146, w: 868, h: 560 }, area), { x: 287, y: 146, w: 868, h: 560 });
});

test('disposition retrouvée sur un écran devenu plus petit : taille bornée, barre de titre ramenée à portée', () => {
  const keep = { keepLeft: 200, keepRight: 96, titlebar: 40 };
  // Plus grande que la zone : réduite à la zone.
  assert.deepEqual(reachableRect({ x: 0, y: 0, w: 1600, h: 900 }, { w: 1024, h: 600 }, keep), { x: 0, y: 0, w: 1024, h: 600 });
  // Barre de titre sous la zone de travail, ou au-dessus de l'écran : ramenée.
  assert.deepEqual(reachableRect({ x: 100, y: 900, w: 500, h: 300 }, { w: 1024, h: 600 }, keep), { x: 100, y: 560, w: 500, h: 300 });
  assert.deepEqual(reachableRect({ x: 100, y: -80, w: 500, h: 300 }, { w: 1024, h: 600 }, keep), { x: 100, y: 0, w: 500, h: 300 });
  // Trop à droite ou trop à gauche : une partie saisissable de la barre de titre revient à l'écran.
  assert.deepEqual(reachableRect({ x: 5000, y: 10, w: 500, h: 300 }, { w: 1024, h: 600 }, keep), { x: 928, y: 10, w: 500, h: 300 });
  assert.deepEqual(reachableRect({ x: -5000, y: 10, w: 500, h: 300 }, { w: 1024, h: 600 }, keep), { x: -300, y: 10, w: 500, h: 300 });
  // La taille minimale est respectée, sauf si la zone elle-même est plus petite.
  assert.deepEqual(reachableRect({ x: 0, y: 0, w: 100, h: 50 }, { w: 1024, h: 600 }, { minW: 400, minH: 260, ...keep }), { x: 0, y: 0, w: 400, h: 260 });
  assert.deepEqual(reachableRect({ x: 0, y: 0, w: 100, h: 50 }, { w: 300, h: 200 }, { minW: 400, minH: 260, ...keep }), { x: 0, y: 0, w: 300, h: 200 });
});

test('un rectangle utilisable a quatre nombres finis et une surface', () => {
  assert.equal(isRect({ x: 0, y: -40, w: 800, h: 500 }), true);
  for (const value of [null, undefined, {}, { x: 0, y: 0, w: 0, h: 500 }, { x: 0, y: 0, w: 800, h: -1 }, { x: NaN, y: 0, w: 8, h: 8 }, { x: 0, y: Infinity, w: 8, h: 8 }, { x: '0', y: 0, w: 8, h: 8 }, { x: 0, y: 0, w: 8 }]) {
    assert.equal(isRect(value), false, JSON.stringify(value));
  }
});

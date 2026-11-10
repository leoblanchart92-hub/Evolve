/**
 * Le fond d'écran officiel doit rester EXACTEMENT celui fourni pour le projet
 * et être affiché sans retouche.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { WALLPAPER_URL } from '../src/renderer/js/config.js';
import { WALLPAPER_FILE } from '../src/renderer/js/data/demo-files.js';
import { fromRoot, readText, stripComments } from './helpers.mjs';

const WALLPAPER_PATH = 'assets/wallpapers/panorama-cosmique-violet-sur-lac-miroir.png';
const SHA256 = '13756eda633dcf18a16579202ad04354312f42449f09d1c7f6428b4fb8b32e53';

const bytes = readFileSync(fromRoot(WALLPAPER_PATH));

test("le fond d'écran est identique, à l'octet près, à l'image d'origine", () => {
  assert.equal(bytes.length, 2_398_788);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), SHA256);
});

test("le fond d'écran est un PNG de 1672 × 941 pixels", () => {
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(bytes.toString('latin1', 12, 16), 'IHDR');
  assert.equal(bytes.readUInt32BE(16), 1672);
  assert.equal(bytes.readUInt32BE(20), 941);
});

test("la page affiche ce fichier comme fond d'écran", () => {
  const html = readText('src/renderer/index.html');
  const tag = html.match(/<img\b[^>]*\bid="wallpaper"[^>]*>/s)?.[0];
  assert.ok(tag, 'balise <img id="wallpaper"> introuvable');
  assert.match(tag, /src="\.\.\/\.\.\/assets\/wallpapers\/panorama-cosmique-violet-sur-lac-miroir\.png"/);
  assert.ok(WALLPAPER_URL.endsWith(WALLPAPER_PATH), "config.js doit désigner le même fichier");
});

test("l'image n'est ni déformée, ni filtrée, ni recolorée par les styles", () => {
  const css = stripComments(readText('src/renderer/styles/desktop.css'));
  const rule = css.match(/\.wallpaper__image\s*\{([^}]*)\}/)?.[1];
  assert.ok(rule, 'règle .wallpaper__image introuvable');
  assert.match(rule, /object-fit:\s*cover/, 'proportions conservées (recadrage centré)');
  assert.match(rule, /object-position:\s*center/);
  for (const property of ['filter', 'opacity', 'mix-blend-mode', 'transform', 'mask', 'clip-path']) {
    assert.doesNotMatch(rule, new RegExp(`(^|[;\\s])${property}\\s*:`), `propriété « ${property} » interdite sur le fond d'écran`);
  }
  assert.equal([...css.matchAll(/\.wallpaper__image\b/g)].length, 1, 'une seule règle doit cibler le fond d’écran');
});

test("l'explorateur d'exemple décrit le fond d'écran avec ses vraies caractéristiques", () => {
  assert.equal(WALLPAPER_FILE.name, 'panorama-cosmique-violet-sur-lac-miroir.png');
  assert.equal(WALLPAPER_FILE.size, bytes.length);
  assert.equal(WALLPAPER_FILE.dimensions, '1672 × 941');
});

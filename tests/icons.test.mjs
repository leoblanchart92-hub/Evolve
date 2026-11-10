/**
 * Pictogrammes : tout nom utilisé par l'interface doit exister dans la planche
 * générée (src/renderer/js/core/icons.data.js), et la planche ne doit contenir
 * aucun pictogramme inutilisé.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { hasIcon } from '../src/renderer/js/core/icons.js';
import { ICON_NAMES, ICON_SYMBOLS, ICON_WEIGHTS } from '../src/renderer/js/core/icons.data.js';
import { APPS, DESKTOP_ICONS } from '../src/renderer/js/data/apps.js';
import { createDemoNotifications } from '../src/renderer/js/data/demo-content.js';
import { createDemoFileSystem, describeNode, FILE_TYPES } from '../src/renderer/js/data/demo-files.js';
import { QUICK_SETTING_ENTRIES } from '../src/renderer/js/shell/search.js';
import { networkGlyph, volumeGlyph } from '../src/renderer/js/shell/ui-state.js';
import { listFiles, relative, RENDERER, stripComments } from './helpers.mjs';

const WEIGHTS = new Set(['regular', 'fill', 'duotone']);

/** Sources de l'interface, hors fichier généré. */
const sources = listFiles(path.join(RENDERER, 'js'), ['.js'])
  .filter((file) => !file.endsWith('icons.data.js'))
  .map((file) => ({ file: relative(file), code: stripComments(readFileSync(file, 'utf8')) }));

/**
 * Arguments d'un appel dont la parenthèse ouvrante est à `start`, réduits à
 * leur premier niveau : le contenu des parenthèses, crochets et accolades
 * imbriqués (autres appels, objets d'options) est ignoré.
 */
function topLevelArguments(code, start) {
  let depth = 0;
  let result = '';
  for (let i = start; i < code.length; i += 1) {
    const char = code[i];
    if ('([{'.includes(char)) {
      depth += 1;
    } else if (')]}'.includes(char)) {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1) {
      result += char;
    }
  }
  return result;
}

test('la planche générée est cohérente', () => {
  assert.deepEqual([...ICON_WEIGHTS], ['regular', 'fill', 'duotone']);
  assert.equal(new Set(ICON_NAMES).size, ICON_NAMES.length, 'aucun nom en double');
  assert.deepEqual([...ICON_NAMES], [...ICON_NAMES].sort(), 'noms triés');
  for (const name of ICON_NAMES) {
    assert.ok(hasIcon(name));
    for (const weight of ICON_WEIGHTS) {
      assert.ok(ICON_SYMBOLS.includes(`<symbol id="i-${name}-${weight}"`), `symbole manquant : ${name} (${weight})`);
    }
  }
  assert.equal([...ICON_SYMBOLS.matchAll(/<symbol /g)].length, ICON_NAMES.length * ICON_WEIGHTS.length);
  assert.equal(hasIcon('pictogramme-inexistant'), false);
  // Le pictogramme de repli (nom inconnu) doit toujours exister.
  assert.ok(hasIcon('question'));
});

test('la planche ne contient ni script ni ressource externe', () => {
  assert.doesNotMatch(ICON_SYMBOLS, /<script|javascript:|\son[a-z]+=|https?:|<image|<foreignObject/i);
});

test('les pictogrammes des données existent', () => {
  const used = new Map();
  const add = (name, origin) => used.set(name, origin);

  for (const app of APPS) add(app.glyph, `application ${app.id}`);
  for (const item of DESKTOP_ICONS) add(item.glyph, `icône du bureau ${item.id}`);
  for (const entry of QUICK_SETTING_ENTRIES) add(entry.glyph, `paramètre rapide ${entry.id}`);
  for (const [ext, type] of Object.entries(FILE_TYPES)) add(type.icon, `type de fichier .${ext}`);
  for (const item of createDemoNotifications()) if (item.glyph) add(item.glyph, `notification ${item.id}`);

  const files = createDemoFileSystem(new Date(2026, 10, 10));
  (function walk(node) {
    for (const child of node.children ?? []) {
      add(describeNode(child).icon, `élément ${child.id}`);
      walk(child);
    }
  })(files.root);
  add(describeNode({ kind: 'file', name: 'x.inconnu', ext: 'inconnu' }).icon, 'fichier de type inconnu');

  for (let volume = 0; volume <= 100; volume += 1) {
    add(volumeGlyph(volume, false), `volume ${volume}`);
    add(volumeGlyph(volume, true), `volume ${volume} (muet)`);
  }
  for (const wifi of [true, false]) {
    for (const airplane of [true, false]) add(networkGlyph({ wifi, airplane }), `réseau wifi=${wifi} avion=${airplane}`);
  }

  assert.ok(used.size > 40);
  for (const [name, origin] of used) assert.ok(hasIcon(name), `pictogramme inconnu « ${name} » (${origin})`);
});

test('les pictogrammes cités dans le code existent', () => {
  const problems = [];
  let count = 0;
  const verify = (name, file) => {
    count += 1;
    if (!hasIcon(name)) problems.push(`${file} : « ${name} »`);
  };

  for (const { file, code } of sources) {
    // Appels icon('nom', …) et setIcon(élément, 'nom', …), expressions conditionnelles comprises.
    for (const match of code.matchAll(/\b(icon|setIcon)\(/g)) {
      const args = topLevelArguments(code, match.index + match[0].length - 1);
      for (const literal of args.matchAll(/'([^']*)'/g)) {
        if (!WEIGHTS.has(literal[1])) verify(literal[1], file);
      }
    }
    // Propriétés de données : glyph: 'nom', icon: 'nom', on: 'nom', off: 'nom'.
    for (const match of code.matchAll(/\b(?:glyph|icon|on|off):\s*'([^']*)'/g)) verify(match[1], file);
    // Fonctions qui renvoient un nom de pictogramme : glyph: () => (… ? 'a' : 'b').
    for (const match of code.matchAll(/\bglyph:\s*\(\)\s*=>\s*\(([^()]*)\)/g)) {
      for (const literal of match[1].matchAll(/'([^']*)'/g)) verify(literal[1], file);
    }
  }

  assert.ok(count > 100, `trop peu de références trouvées (${count}) : l'analyse est-elle à jour ?`);
  assert.deepEqual(problems, [], 'pictogrammes inconnus');
});

test('chaque pictogramme de la planche est utilisé', () => {
  const everything = sources.map(({ code }) => code).join('\n');
  const unused = ICON_NAMES.filter((name) => !everything.includes(`'${name}'`));
  assert.deepEqual(unused, [], 'pictogrammes inutilisés : les retirer de scripts/build-icons.mjs puis lancer « npm run icons »');
});

test('la liste du script de génération correspond à la planche', () => {
  const script = readFileSync(path.join(RENDERER, '..', '..', 'scripts', 'build-icons.mjs'), 'utf8');
  const block = script.match(/const NAMES = \[([\s\S]*?)\];/)?.[1];
  assert.ok(block, 'liste NAMES introuvable dans scripts/build-icons.mjs');
  const names = [...stripComments(block).matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.equal(new Set(names).size, names.length, 'nom en double dans NAMES');
  assert.deepEqual([...names].sort(), [...ICON_NAMES], 'relancer « npm run icons » après toute modification de NAMES');
});

/**
 * Application « Paramètres » (src/renderer/js/apps/settings.js) : l'une des
 * deux applications réellement fonctionnelles d'Evolve, avec l'explorateur.
 * Elle n'est pas construite dans un navigateur par les tests — ce sont ses
 * sources qui sont analysées, et le module est chargé tel quel par Node :
 * une faute de syntaxe ou un nom qui n'existe pas est ainsi détecté avant
 * même la compilation.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fromRoot, readText } from './helpers.mjs';
import { ICON_NAMES } from '../src/renderer/js/core/icons.data.js';
import { SETTINGS } from '../src/services/settings-schema.js';

const FILE = 'src/renderer/js/apps/settings.js';
const source = readText(FILE);
const { stripComments } = await import('./helpers.mjs');
const code = stripComments(source);

/** Sources des services, pour vérifier les appels de l'interface. */
const services = readText('src/services/index.js');

/**
 * Code sans ses chaînes de caractères : les noms qui restent sont du code.
 * Les expressions des littéraux de gabarit (`${…}`) sont conservées.
 */
function withoutStrings(text) {
  return text
    .replace(/`(?:[^`\\]|\\.)*`/g, (match) => match.slice(1, -1).replace(/\$\{([^}]*)\}/g, ' $1 '))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

test('le module se charge sans toucher au document : aucune faute de syntaxe', async () => {
  const module = await import('../src/renderer/js/apps/settings.js');
  assert.deepEqual(Object.keys(module), ['mountSettings']);
  assert.equal(typeof module.mountSettings, 'function');
});

test('chaque page du panneau possède son constructeur, et un pictogramme existant', () => {
  const pageBlock = code.match(/const PAGES = Object\.freeze\(\[([\s\S]*?)\]\);/);
  const buildBlock = code.match(/const BUILDERS = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(pageBlock, 'liste des pages introuvable');
  assert.ok(buildBlock, 'constructeurs de pages introuvables');

  const pages = [...pageBlock[1].matchAll(/id: '([^']+)', label: '([^']+)', glyph: '([^']+)'/g)].map((match) => ({
    id: match[1],
    label: match[2],
    glyph: match[3],
  }));
  assert.ok(pages.length >= 5, `pages décrites : ${pages.length}`);
  assert.equal(new Set(pages.map((page) => page.id)).size, pages.length, 'identifiants de page uniques');

  const builders = [...buildBlock[1].matchAll(/(\w+):\s*(\w+),/g)].map((match) => match[1]);
  assert.deepEqual(builders, pages.map((page) => page.id), 'une page affichée = une page construite');
  for (const page of pages) {
    assert.ok(ICON_NAMES.includes(page.glyph), `pictogramme inconnu : ${page.glyph} (${page.id})`);
    assert.ok(page.label.length > 0);
  }
});

test('tout nom employé par le module existe : constante déclarée, importée ou connue', () => {
  // Un nom qui n'existe plus — une adresse retirée, par exemple — passerait
  // inaperçu jusqu'à l'ouverture de la page : il est cherché ici.
  const body = withoutStrings(code);
  const used = [...new Set([...body.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map((match) => match[1]))];
  const declared = new Set([...body.matchAll(/(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]{2,})/g)].map((match) => match[1]));
  const imported = new Set(
    [...body.matchAll(/import\s*(?:\{([^}]*)\}|(\w+))\s*from/g)].flatMap((match) =>
      (match[1] ?? match[2] ?? '').split(',').map((name) => name.trim().split(/\s+as\s+/).pop().trim()),
    ),
  );
  const unknown = used.filter((name) => !declared.has(name) && !imported.has(name));
  assert.deepEqual(unknown, [], `noms employés sans être définis dans ${FILE}`);
  assert.ok(used.length >= 2, 'la recherche porte sur le module entier');
});

test('les services sont appelés par des méthodes qu’ils déclarent, et seulement celles-là', () => {
  const calls = [...code.matchAll(/services\.call\('(\w+)',\s*'(\w+)'/g)].map((match) => [match[1], match[2]]);
  assert.ok(calls.length >= 5, `appels trouvés : ${calls.length}`);
  for (const [service, method] of calls) {
    // Le bloc « methods » se termine à la première accolade fermante du même
    // niveau (quatre espaces), et non à la première trouvée dans une signature.
    const block = services.match(new RegExp(`register\\('${service}',\\s*\\{[\\s\\S]*?methods:\\s*\\{([\\s\\S]*?)\\n {4}\\},`));
    assert.ok(block, `service inconnu : ${service}`);
    assert.match(block[1], new RegExp(`\\b${method}\\s*[:(]`), `méthode non déclarée : ${service}.${method}`);
  }
  // Les réglages modifiés depuis l'interface passent par l'état partagé, jamais
  // par un appel direct : une seule écriture, la réinitialisation.
  const settingsCalls = calls.filter(([service]) => service === 'settings').map(([, method]) => method);
  assert.deepEqual([...new Set(settingsCalls)], ['reset']);
  assert.ok(code.includes("services.call('settings', 'reset')"));
  // Le réglage des mises à jour est un réglage déclaré, comme les autres.
  assert.ok(SETTINGS['updates.autoCheck'], 'réglage « updates.autoCheck » absent du schéma');
});

test('aucune adresse n’est écrite en dur : les adresses viennent du service des mises à jour', () => {
  assert.doesNotMatch(code, /https?:\/\//, 'adresse écrite en dur dans l’interface');
  // La page ouvre l'adresse que le service connaît, ou celle de la version publiée.
  assert.match(code, /openExternal\(state\.releaseUrl \?\? state\.latest\.url\)/);
  assert.match(code, /openExternal\(state\.latest\.url\)/);
  // Le fichier d'empreintes qui garantit la mise à jour est celui que publie
  // le projet : son nom est annoncé par le service, jamais écrit dans l'interface.
  assert.match(readText('src/services/updates.js'), /CHECKSUM_ASSET = 'SHA256SUMS\.txt'/);
});

test('la page des mises à jour suit l’état du service, sans jamais rien décider d’elle-même', async () => {
  // Chaque commande passe par le service ; l'interface ne télécharge rien.
  for (const method of ['check', 'download', 'install', 'state']) {
    assert.ok(code.includes(`services.call('updates', '${method}'`), method);
  }
  // L'interface s'abonne aux événements du service : état et progression.
  assert.match(code, /services\.on\('updates', 'state'/);
  assert.match(code, /services\.on\('updates', 'progress'/);
  // Cas prévus : indisponible, recherche en cours, téléchargement, à jour, erreur.
  for (const text of [
    'Les mises à jour ne sont pas disponibles dans cette exécution.',
    'Recherche de la dernière version…',
    'Téléchargement en cours…',
    'Evolve est à jour.',
    'La dernière vérification a échoué.',
  ]) {
    assert.ok(code.includes(text), `message absent : ${text}`);
  }
  // Version portable : pas d'installation silencieuse possible, on ouvre la page des versions.
  assert.match(code, /state\.channel === 'portable'/);
  assert.match(code, /Une mise à jour n'est installée que si son empreinte correspond à celle publiée avec elle\./);
});

test('l’application est bien celle que le registre et la fenêtre savent ouvrir', () => {
  const apps = readText('src/renderer/js/apps/index.js');
  assert.match(apps, /settings/);
  const registry = readText('src/renderer/js/data/apps.js');
  assert.match(registry, /id: 'settings'/);
  assert.ok(!registry.includes('placeholder'));
  // Sa feuille de style est chargée avec celles des applications.
  assert.ok(fromRoot('src/renderer/styles/apps/settings.css'));
});

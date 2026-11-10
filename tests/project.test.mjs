/**
 * Intégrité du projet : ce que la compilation ne vérifie pas d'elle-même.
 * Le projet n'utilise ni compilateur ni empaqueteur JavaScript ; ces tests
 * détectent donc les fichiers manquants, les imports erronés et tout accès
 * réseau avant que l'exécutable ne soit produit.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { fromRoot, listFiles, readText, relative, RENDERER, ROOT, stripComments } from './helpers.mjs';

const html = readText('src/renderer/index.html');
const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
const jsFiles = listFiles(path.join(RENDERER, 'js'), ['.js']);
const cssFiles = listFiles(path.join(RENDERER, 'styles'), ['.css']);
const pkg = JSON.parse(readText('package.json'));

/** Résout une référence relative (href, src, url()) depuis un fichier. */
const resolveFrom = (file, reference) => path.resolve(path.dirname(file), reference.split(/[?#]/)[0]);

// ---------------------------------------------------------------------------------
// Page HTML
// ---------------------------------------------------------------------------------

test('toutes les ressources citées par la page existent', () => {
  const indexFile = path.join(RENDERER, 'index.html');
  const references = [...htmlNoComments.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(references.length >= 17, 'feuilles de style, script, icône et fond d’écran attendus');
  for (const reference of references) {
    assert.ok(!/^[a-z]+:/i.test(reference) && !reference.startsWith('//'), `référence non locale : ${reference}`);
    assert.ok(!reference.startsWith('/'), `chemin absolu (incompatible avec l'exécutable) : ${reference}`);
    assert.ok(existsSync(resolveFrom(indexFile, reference)), `fichier manquant : ${reference}`);
  }
});

test('chaque feuille de style est chargée par la page, une seule fois', () => {
  const linked = [...htmlNoComments.matchAll(/<link rel="stylesheet" href="\.\/([^"]+)"/g)].map((match) => match[1]);
  const present = cssFiles.map((file) => path.relative(RENDERER, file).split(path.sep).join('/'));
  assert.equal(new Set(linked).size, linked.length, 'feuille de style chargée deux fois');
  assert.deepEqual([...linked].sort(), [...present].sort());
  // Les variables (tokens) d'abord, les adaptations d'écran en dernier.
  assert.equal(linked[0], 'styles/tokens.css');
  assert.equal(linked.at(-1), 'styles/responsive.css');
});

test('la politique de sécurité interdit tout contenu distant ou injecté', () => {
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/s)?.[1];
  assert.ok(csp, 'balise Content-Security-Policy manquante');
  const directives = Object.fromEntries(
    csp.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]),
  );
  assert.deepEqual(directives['default-src'], ["'none'"]);
  assert.deepEqual(directives['script-src'], ["'self'"]);
  assert.deepEqual(directives['font-src'], ["'self'"]);
  assert.ok(!('connect-src' in directives), 'aucune connexion réseau ne doit être autorisée');
  assert.doesNotMatch(csp, /unsafe-eval|https?:|\*/);
});

test('la page ne contient ni script en ligne ni gestionnaire d’événement en attribut', () => {
  const scripts = [...htmlNoComments.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0][1], /type="module"/);
  assert.match(scripts[0][1], /src="\.\/js\/main\.js"/);
  assert.equal(scripts[0][2].trim(), '');
  assert.doesNotMatch(htmlNoComments, /\son[a-z]+\s*=/i);
});

test('la page est en français et déclare les calques attendus', () => {
  assert.match(html, /<html lang="fr">/);
  for (const id of ['wallpaper', 'desktop', 'widgets', 'windows', 'flyouts', 'taskbar', 'menus', 'toasts', 'tooltip', 'screen-fx', 'boot']) {
    assert.equal([...html.matchAll(new RegExp(`\\bid="${id}"`, 'g'))].length, 1, `élément #${id}`);
  }
});

// ---------------------------------------------------------------------------------
// Feuilles de style
// ---------------------------------------------------------------------------------

test('toutes les ressources citées par les feuilles de style existent', () => {
  let count = 0;
  for (const file of cssFiles) {
    const css = stripComments(readFileSync(file, 'utf8'));
    for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      const reference = match[2];
      if (reference.startsWith('data:') || reference.startsWith('#')) continue;
      count += 1;
      assert.ok(!/^[a-z]+:/i.test(reference), `${relative(file)} : ressource distante ${reference}`);
      assert.ok(existsSync(resolveFrom(file, reference)), `${relative(file)} : fichier manquant ${reference}`);
    }
    assert.doesNotMatch(css, /@import\b/, `${relative(file)} : @import interdit (chargement en cascade)`);
  }
  assert.ok(count >= 4, 'les polices embarquées doivent être référencées');
});

test('les polices embarquées sont accompagnées de leur licence', () => {
  for (const family of ['inter', 'outfit']) {
    const dir = fromRoot('assets', 'fonts', family);
    assert.ok(listFiles(dir, ['.woff2']).length >= 2, `polices ${family}`);
    assert.match(readFileSync(path.join(dir, 'LICENSE.txt'), 'utf8'), /SIL OPEN FONT LICENSE/i);
  }
});

// ---------------------------------------------------------------------------------
// Modules JavaScript de l'interface
// ---------------------------------------------------------------------------------

/** Noms exportés par un module (formes utilisées dans le projet). */
function exportsOf(code) {
  const names = new Set();
  for (const match of code.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  return names;
}

/** Imports d'un module : [{ names, from }]. Seule la forme « import { a, b } from '…' » est admise. */
function importsOf(code, file) {
  const imports = [];
  const pattern = /^import\s+([\s\S]*?)\s+from\s+'([^']+)';?$/gm;
  for (const match of code.matchAll(pattern)) {
    const clause = match[1].trim();
    assert.match(clause, /^\{[\s\S]*\}$/, `${relative(file)} : seule la forme « import { … } from » est utilisée dans ce projet`);
    const names = clause
      .slice(1, -1)
      .split(',')
      .map((name) => name.trim().split(/\s+as\s+/)[0])
      .filter(Boolean);
    imports.push({ names, from: match[2] });
  }
  const statements = [...code.matchAll(/^import\b/gm)].length;
  assert.equal(imports.length, statements, `${relative(file)} : forme d'import non reconnue`);
  return imports;
}

const modules = new Map(
  jsFiles.map((file) => {
    const code = stripComments(readFileSync(file, 'utf8'));
    return [file, { code, exports: exportsOf(code), imports: importsOf(code, file) }];
  }),
);

test('chaque import désigne un fichier existant et un nom réellement exporté', () => {
  let count = 0;
  for (const [file, module] of modules) {
    for (const { names, from } of module.imports) {
      assert.match(from, /^\.{1,2}\/.+\.js$/, `${relative(file)} : import non relatif ou sans extension « ${from} »`);
      const target = resolveFrom(file, from);
      assert.ok(modules.has(target), `${relative(file)} : module introuvable « ${from} »`);
      for (const name of names) {
        count += 1;
        assert.ok(modules.get(target).exports.has(name), `${relative(file)} : « ${name} » n'est pas exporté par ${from}`);
      }
    }
  }
  assert.ok(count > 100, `analyse des imports incomplète (${count})`);
});

test("aucun module n'est orphelin : tous sont atteints depuis main.js", () => {
  const entry = path.join(RENDERER, 'js', 'main.js');
  const reached = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    for (const { from } of modules.get(file).imports) {
      const target = resolveFrom(file, from);
      if (!reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }
  const orphans = jsFiles.filter((file) => !reached.has(file)).map(relative);
  assert.deepEqual(orphans, []);
});

test("l'interface n'utilise ni import dynamique, ni eval, ni HTML injecté depuis des données", () => {
  for (const [file, { code }] of modules) {
    if (file.endsWith('icons.data.js')) continue;
    assert.doesNotMatch(code, /\bimport\s*\(/, `${relative(file)} : import() dynamique`);
    assert.doesNotMatch(code, /\beval\s*\(|new Function\s*\(/, `${relative(file)} : eval`);
    assert.doesNotMatch(code, /\b(?:insertAdjacentHTML|outerHTML|document\.write)\b/, `${relative(file)} : HTML injecté`);
    // innerHTML n'est admis que pour du balisage SVG fixe, défini par des constantes du projet
    // (pictogrammes, logo, boutons de fenêtre) : jamais pour des données ou du texte.
    const constant = /^(?:[A-Z][A-Z0-9_]*(?:\[[a-z]+\])?|`(?:[^`$]|\$\{[A-Z][A-Z0-9_]*\})*`)$/;
    for (const match of code.matchAll(/\binnerHTML\b\s*([-+*]?=)?\s*([^;\n]*)/g)) {
      assert.equal(match[1], '=', `${relative(file)} : innerHTML ne doit être qu'affecté`);
      assert.match(match[2].trim(), constant, `${relative(file)} : innerHTML doit recevoir une constante du projet`);
    }
  }
});

test("l'interface ne fait aucun accès réseau", () => {
  const namespaces = /http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xhtml|1999\/xlink)/g;
  for (const file of [...jsFiles, ...cssFiles]) {
    const code = stripComments(readFileSync(file, 'utf8')).replace(namespaces, '');
    assert.doesNotMatch(code, /\b(?:https?|wss?|ftp):\/\//i, `${relative(file)} : adresse distante`);
    assert.doesNotMatch(code, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/, `${relative(file)} : API réseau`);
  }
  assert.doesNotMatch(htmlNoComments, /\b(?:https?|wss?):\/\//i);
});

test('les textes affichés n’utilisent que des caractères présents dans les polices embarquées', () => {
  // Plages Unicode déclarées dans fonts.css (police de texte « Inter »).
  const fontsCss = stripComments(readText('src/renderer/styles/fonts.css'));
  const ranges = [];
  for (const block of fontsCss.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    if (!/font-family:\s*'Inter Variable'/.test(block[1])) continue;
    const list = block[1].match(/unicode-range:\s*([^;]+);/)[1];
    for (const item of list.split(',')) {
      const [start, end] = item.trim().replace(/^U\+/i, '').split('-');
      ranges.push([parseInt(start, 16), parseInt(end ?? start, 16)]);
    }
  }
  assert.ok(ranges.length > 20);
  const covered = (codePoint) => ranges.some(([start, end]) => codePoint >= start && codePoint <= end);

  const problems = [];
  const inspect = (text, origin) => {
    for (const char of text) {
      const codePoint = char.codePointAt(0);
      if (codePoint > 0x7e && !covered(codePoint)) {
        problems.push(`${origin} : « ${char} » (U+${codePoint.toString(16).toUpperCase().padStart(4, '0')})`);
      }
    }
  };
  for (const [file, { code }] of modules) {
    if (!file.endsWith('icons.data.js')) inspect(code, relative(file));
  }
  inspect(htmlNoComments, 'src/renderer/index.html');
  assert.deepEqual([...new Set(problems)], []);
});

// ---------------------------------------------------------------------------------
// Application de bureau (Electron) et empaquetage
// ---------------------------------------------------------------------------------

test('les scripts de l’application de bureau existent', () => {
  assert.equal(pkg.main, 'src/main/main.js');
  for (const file of ['main.js', 'preload.js', 'args.js', 'selftest.js', 'selftest-settings.js', 'status.js']) {
    assert.ok(existsSync(fromRoot('src', 'main', file)), `src/main/${file}`);
  }
  const main = readText('src/main/main.js');
  for (const required of [...main.matchAll(/require\('(\.\/[^']+)'\)/g)].map((match) => match[1])) {
    assert.ok(existsSync(fromRoot('src', 'main', `${required}.js`)), `module requis introuvable : ${required}`);
  }
  assert.match(main, /path\.join\(__dirname, 'preload\.js'\)/);
  assert.match(main, /path\.join\(__dirname, '\.\.', 'renderer', 'index\.html'\)/);
});

/** Fichiers de l'application de bureau : processus principal et couche de services. */
const desktopFiles = [...listFiles(fromRoot('src', 'main'), ['.js']), ...listFiles(fromRoot('src', 'services'), ['.js'])];

/** Modules locaux requis par un fichier de l'application de bureau (chemins complets). */
function requiredModules(file) {
  const code = stripComments(readFileSync(file, 'utf8'));
  const names = [...code.matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]);
  assert.equal(names.length, [...code.matchAll(/\brequire\s*\(/g)].length, `${relative(file)} : forme de require non reconnue`);
  const modules = [];
  for (const name of names) {
    if (name === 'electron' || name.startsWith('node:')) continue;
    assert.match(name, /^\.{1,2}\//, `${relative(file)} : paquet externe « ${name} » — aucune dépendance n'est embarquée dans le .exe`);
    const target = path.resolve(path.dirname(file), name);
    const resolved = [target, `${target}.js`, path.join(target, 'index.js')].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    assert.ok(resolved, `${relative(file)} : module introuvable « ${name} »`);
    modules.push(resolved);
  }
  return modules;
}

test('chaque module requis par l’application de bureau existe et est embarqué dans le .exe', () => {
  // Dossiers copiés dans l'exécutable : un module situé ailleurs manquerait au
  // lancement du .exe, alors que tout fonctionne en développement.
  const shipped = pkg.build.files.filter((pattern) => pattern.endsWith('/**/*')).map((pattern) => pattern.slice(0, -'/**/*'.length));
  const required = new Set();
  for (const file of desktopFiles) {
    for (const module of requiredModules(file)) {
      const name = relative(module);
      assert.ok(shipped.some((dir) => name.startsWith(`${dir}/`)), `${relative(file)} : « ${name} » n'est pas embarqué dans l'exécutable`);
      required.add(name);
    }
  }
  // La couche de services est bien reliée à l'application.
  for (const name of ['src/services/index.js', 'src/services/settings.js', 'src/services/platform.js']) assert.ok(required.has(name), name);
});

test('aucun module de l’application de bureau n’est orphelin', () => {
  // Points d'entrée : le processus principal et le script de préchargement, que la fenêtre charge par son chemin.
  const reached = new Set();
  const visit = (file) => {
    if (reached.has(file)) return;
    reached.add(file);
    for (const module of requiredModules(file)) visit(module);
  };
  visit(fromRoot('src', 'main', 'main.js'));
  visit(fromRoot('src', 'main', 'preload.js'));
  assert.deepEqual(desktopFiles.filter((file) => !reached.has(file)).map(relative), []);
});

test('le script de préchargement, exécuté dans un bac à sable, ne requiert que le module electron', () => {
  // Dans une page isolée (sandbox), ce script ne peut charger aucun autre fichier.
  assert.deepEqual(requiredModules(fromRoot('src', 'main', 'preload.js')), []);
  const names = [...stripComments(readText('src/main/preload.js')).matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]);
  assert.deepEqual(names, ['electron']);
});

test('la fenêtre de l’application est isolée du système', () => {
  const main = stripComments(readText('src/main/main.js'));
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /webSecurity:\s*true/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(main, /'will-navigate'/);
  // Aucune API d'accès au système n'est utilisée par l'application.
  for (const source of ['src/main/main.js', 'src/main/preload.js']) {
    const code = stripComments(readText(source));
    assert.doesNotMatch(code, /\b(?:child_process|shell\.openExternal|shell\.openPath|registry|regedit|powerShell|exec\(|spawn\()/i, source);
  }
});

test('la passerelle expose exactement ce que l’interface utilise', () => {
  const preload = stripComments(readText('src/main/preload.js'));
  const main = stripComments(readText('src/main/main.js'));
  const platform = stripComments(readText('src/renderer/js/core/platform.js'));

  // Méthodes appelées par l'interface sur `window.evolve`.
  const used = new Set([...platform.matchAll(/\bhost\.([A-Za-z]+)/g)].map((match) => match[1]));
  assert.deepEqual([...used].sort(), ['isFullscreen', 'onFullscreenChange', 'quit', 'services', 'toggleFullscreen']);
  for (const name of used) assert.match(preload, new RegExp(`\\b${name}:`), `preload.js n'expose pas ${name}`);
  assert.match(preload, /exposeInMainWorld\('evolve'/);
  assert.match(platform, /globalThis\.evolve/);

  // Services : l'interface n'appelle que « call » et « on », seules entrées exposées.
  const client = stripComments(readText('src/renderer/js/core/services.js'));
  const serviceUses = new Set([...client.matchAll(/\bhost\.([A-Za-z]+)/g)].map((match) => match[1]));
  assert.deepEqual([...serviceUses].sort(), ['call', 'on']);
  const exposedServices = preload.match(/\bservices: \{([\s\S]*)\n {2}\},\n\}\);/)?.[1];
  assert.ok(exposedServices, 'entrée « services » de preload.js non reconnue');
  assert.deepEqual([...exposedServices.matchAll(/^ {4}([A-Za-z]+): /gm)].map((match) => match[1]), ['call', 'on']);

  // Aucun autre module de l'interface ne touche à la passerelle.
  for (const file of jsFiles) {
    if (file.endsWith(path.join('core', 'platform.js'))) continue;
    assert.doesNotMatch(stripComments(readFileSync(file, 'utf8')), /(?:globalThis|window|self)\.evolve\b/, relative(file));
  }

  // Canaux de communication : chaque canal émis est traité de l'autre côté.
  const channels = (code) => new Set([...code.matchAll(/'(evolve:[a-z-]+)'/g)].map((match) => match[1]));
  assert.deepEqual([...channels(preload)].sort(), [...channels(main)].sort());
  assert.deepEqual([...channels(preload)].sort(), [
    'evolve:fullscreen-changed',
    'evolve:is-fullscreen',
    'evolve:quit',
    'evolve:service-call',
    'evolve:service-event',
    'evolve:toggle-fullscreen',
  ]);
  // Aucun service n'ouvre son propre canal : tout passe par le point d'accès.
  for (const file of desktopFiles) {
    if (/[\\/]main[\\/](?:main|preload)\.js$/.test(file)) continue;
    assert.doesNotMatch(stripComments(readFileSync(file, 'utf8')), /'evolve:[a-z-]+'|\bipc(?:Main|Renderer)\b/, relative(file));
  }
});

test('configuration de la compilation Windows', () => {
  const { build } = pkg;
  assert.equal(build.productName, 'Evolve');
  assert.deepEqual(build.win.target, [{ target: 'portable', arch: ['x64'] }]);
  // Aucun droit administrateur : ni pour l'application, ni pour son lanceur.
  assert.equal(build.win.requestedExecutionLevel, 'asInvoker');
  assert.equal(build.portable.requestExecutionLevel, 'user');
  assert.equal(build.portable.artifactName, 'Evolve-${version}-portable.exe');
  assert.equal(build.publish, null, 'aucune publication automatique');
  assert.deepEqual(build.files, ['package.json', 'THIRD-PARTY-NOTICES.md', 'src/main/**/*', 'src/services/**/*', 'src/renderer/**/*', 'assets/**/*']);
  for (const pattern of build.files) assert.ok(existsSync(fromRoot(pattern.replace(/\/\*\*\/\*$/, ''))), `fichier ou dossier absent : ${pattern}`);
  // Dossier de décompression fixe et reconnaissable dans %TEMP% (voir README).
  assert.equal(build.portable.unpackDirName, 'Evolve-portable');
  // Fichiers décompressés directement à leur place, sans archive intermédiaire :
  // lancement plus court de plusieurs secondes et un seul exemplaire de
  // l'application dans %TEMP% (313 Mo, mesurés par la compilation automatique),
  // au prix d'un fichier .exe plus gros (141 Mo au lieu de 100 Mo).
  assert.equal(build.portable.useZip, true);
  assert.ok(existsSync(fromRoot(build.win.icon)));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test("l'icône de l'exécutable est un fichier ICO complet (16 à 256 pixels)", () => {
  const ico = readFileSync(fromRoot('packaging', 'icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, 'type icône');
  const count = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const offset = 6 + i * 16;
    const width = ico[offset] || 256;
    const height = ico[offset + 1] || 256;
    assert.equal(width, height);
    const dataSize = ico.readUInt32LE(offset + 8);
    const dataOffset = ico.readUInt32LE(offset + 12);
    assert.ok(dataOffset + dataSize <= ico.length, 'image tronquée');
    sizes.push(width);
  }
  for (const size of [16, 24, 32, 48, 256]) assert.ok(sizes.includes(size), `taille ${size} manquante`);
});

test('les dépendances sont figées et aucune n’est nécessaire à l’exécution', () => {
  assert.equal(pkg.dependencies, undefined, "l'application n'embarque aucune dépendance");
  for (const [name, version] of Object.entries(pkg.devDependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `version non figée pour ${name} : ${version}`);
  }
  const lock = JSON.parse(readText('package-lock.json'));
  for (const [name, version] of Object.entries(pkg.devDependencies)) {
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `package-lock.json désynchronisé pour ${name}`);
  }
});

test('les scripts npm désignent des fichiers existants', () => {
  for (const [name, command] of Object.entries(pkg.scripts)) {
    for (const match of command.matchAll(/\bnode\s+(?:--[\w=-]+\s+)*([\w./-]+\.m?js)/g)) {
      assert.ok(existsSync(fromRoot(match[1])), `script « ${name} » : fichier introuvable ${match[1]}`);
    }
  }
});

test('les fichiers volumineux restent raisonnables (exécutable léger)', () => {
  const sizeOf = (...parts) => statSync(fromRoot(...parts)).size;
  assert.ok(sizeOf('src', 'renderer', 'js', 'core', 'icons.data.js') < 200_000);
  const rendererTotal = [...jsFiles, ...cssFiles].reduce((total, file) => total + statSync(file).size, 0);
  assert.ok(rendererTotal < 900_000, `interface : ${rendererTotal} octets`);
  assert.ok(existsSync(path.join(ROOT, 'assets', 'icons', 'evolve-256.png')));
});

// --- Compilation automatique (GitHub Actions) ----------------------------------------

const workflow = readText('.github/workflows/build-windows.yml');
/** Lignes utiles du fichier (sans commentaires), pour les contrôles d'ordre. */
const workflowCode = workflow
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

test('compilation automatique : machine Windows, droits minimaux, aucun secret', () => {
  assert.match(workflowCode, /^\s+runs-on: windows-latest$/m);
  assert.match(workflowCode, /^permissions:\n {2}contents: read$/m, 'lecture seule du dépôt');
  assert.ok(!/\bsecrets\./.test(workflowCode), 'aucun secret utilisé');
  assert.ok(!/pull_request_target/.test(workflowCode));
  assert.match(workflowCode, /persist-credentials: false/);
  assert.match(workflowCode, /^\s+timeout-minutes: \d+$/m);
  // Actions officielles de GitHub uniquement, à une version majeure fixée.
  const actions = [...workflowCode.matchAll(/^\s+uses: (\S+)$/gm)].map((match) => match[1]);
  assert.deepEqual([...new Set(actions)].sort(), ['actions/checkout@v7', 'actions/setup-node@v7', 'actions/upload-artifact@v7']);
});

test('compilation automatique : les commandes citées existent', () => {
  for (const match of workflowCode.matchAll(/\b(scripts\/[\w.-]+\.(?:mjs|sh))\b/g)) {
    assert.ok(existsSync(fromRoot(match[1])), `fichier introuvable : ${match[1]}`);
  }
  const used = [...workflowCode.matchAll(/\bnpm run ([\w:-]+)/g)].map((match) => match[1]);
  assert.ok(used.length >= 2);
  for (const name of used) assert.ok(pkg.scripts[name], `script npm inconnu : ${name}`);
  assert.match(workflowCode, /\bnpm ci\b/, 'installation fidèle à package-lock.json');
  assert.match(workflowCode, /\bnpm test\b/);
});

test('compilation automatique : le .exe n’est publié qu’après toutes les vérifications', () => {
  const order = [
    'npm test',
    'check-exe.mjs electron',
    'npm run build:win',
    'npm run check:manifest',
    'check-exe.mjs --out=self-test-output/executable',
    'check-launch.mjs --out=self-test-output/lancement',
    'check-settings.mjs --out=self-test-output/reglages',
    'path: dist/Evolve-*-portable.exe',
  ].map((needle) => {
    const index = workflowCode.indexOf(needle);
    assert.ok(index >= 0, `étape absente : ${needle}`);
    return index;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'ordre des étapes');

  // Aucune étape de vérification n'est tolérante à l'échec.
  const tolerant = [...workflowCode.matchAll(/continue-on-error: true/g)];
  assert.equal(tolerant.length, 1, 'seul le réglage de la définition d’écran peut échouer');
  const steps = workflowCode.split(/\n {6}- name: /).slice(1);
  const lenient = steps.filter((step) => step.includes('continue-on-error: true'));
  assert.equal(lenient.length, 1);
  assert.match(lenient[0], /^Régler l'écran/);
  assert.ok(!/check-exe|check-launch|check-settings|build:win|check:manifest|npm test/.test(lenient[0]));

  // Les réglages sont éprouvés là où ils seront réellement rangés : %APPDATA%\Evolve.
  const settingsStep = steps.find((step) => step.includes('check-settings.mjs'));
  assert.match(settingsStep, /--settings-dir="\$APPDATA\/Evolve"/);

  // La publication du .exe n'a pas de condition : elle n'a lieu que si tout a réussi.
  const publish = steps.find((step) => step.includes('path: dist/Evolve-*-portable.exe'));
  assert.ok(!/^\s+if:/m.test(publish), 'publication sans condition particulière');
  assert.match(publish, /archive: false/, 'fichier .exe téléchargé tel quel');
  assert.match(publish, /if-no-files-found: error/);
  // Le nom du fichier produit correspond à celui que la compilation publie.
  assert.match(pkg.build.portable.artifactName, /^Evolve-\$\{version\}-portable\.exe$/);
});

test('les fichiers de script gardent des fins de ligne Unix (exécutés par bash sous Windows)', () => {
  assert.match(readText('.gitattributes'), /^\* text=auto eol=lf$/m);
  for (const file of ['scripts/ci-run.sh', '.github/workflows/build-windows.yml']) {
    assert.ok(!readText(file).includes('\r'), `fins de ligne Windows dans ${file}`);
  }
});

test('le numéro de version est le même partout', async () => {
  const { PRODUCT } = await import('../src/renderer/js/config.js');
  assert.equal(PRODUCT.version, pkg.version, 'src/renderer/js/config.js');
  assert.equal(JSON.parse(readText('package-lock.json')).version, pkg.version, 'package-lock.json');
  // L'exécutable d'exemple présenté dans l'explorateur porte le nom du vrai fichier.
  assert.ok(readText('src/renderer/js/data/demo-files.js').includes(`'Evolve-${pkg.version}-portable.exe'`));
});

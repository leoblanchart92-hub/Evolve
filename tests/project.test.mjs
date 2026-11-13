/**
 * Intégrité du projet : ce que la compilation ne vérifie pas d'elle-même.
 * Le projet n'utilise ni compilateur ni empaqueteur JavaScript ; ces tests
 * détectent donc les fichiers manquants, les imports erronés et tout accès
 * réseau avant que l'exécutable ne soit produit.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
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
  for (const id of ['wallpaper', 'desktop', 'widgets', 'windows', 'flyouts', 'taskbar', 'dialogs', 'menus', 'toasts', 'tooltip', 'screen-fx', 'boot']) {
    assert.equal([...html.matchAll(new RegExp(`\\bid="${id}"`, 'g'))].length, 1, `élément #${id}`);
  }
});

// ---------------------------------------------------------------------------------
// Feuilles de style
// ---------------------------------------------------------------------------------

test('animations réduites : un panneau qui s’ouvre est visible aussitôt, pour recevoir le clavier', () => {
  // Avec les animations réduites de Windows, toutes les transitions durent 1 ms.
  // Appliquée à la visibilité d'un panneau et de son contenu, cette milliseconde
  // les rendrait invisibles à l'instant de l'ouverture : le champ de recherche du
  // menu Démarrer ne pourrait pas recevoir le clavier.
  const base = stripComments(readText('src/renderer/styles/base.css'));
  const reduced = base.slice(base.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /transition-duration: 1ms !important;/);
  assert.match(reduced, /\.flyout\.is-open,\s*\.flyout\.is-open \* \{\s*transition-duration: 0s !important;\s*\}/);
  // Les panneaux qui prennent le clavier à l'ouverture portent tous la classe « flyout »…
  assert.match(readText('src', 'renderer', 'js', 'shell', 'flyouts.js'), /el\.classList\.add\('flyout'\);/);
  // … et ce sont les seuls éléments rendus visibles par une classe d'ouverture.
  for (const file of ['flyouts.css', 'start-menu.css']) {
    const css = stripComments(readText('src', 'renderer', 'styles', file));
    const shown = [...css.matchAll(/([^{}]+)\{[^{}]*visibility: visible;[^{}]*\}/g)].map((match) => match[1].trim());
    assert.ok(shown.length >= 1, file);
    for (const selector of shown) assert.match(selector, /^\.(?:start|side-flyout)\.is-open$|^\.start__view\.is-current$/, `${file} : ${selector}`);
  }
});

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
  for (const file of ['main.js', 'preload.js', 'args.js', 'personal-folders.js', 'selftest.js', 'selftest-explorer.js', 'selftest-settings.js', 'selftest-documents.js', 'status.js']) {
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

/**
 * Modules intégrés à Electron. « original-fs » est le module de fichiers de
 * Node tel quel : celui d'Electron présente les archives .asar comme des
 * dossiers, ce que l'explorateur ne doit pas faire.
 */
const ELECTRON_MODULES = ['electron', 'original-fs'];

/** Modules locaux requis par un fichier de l'application de bureau (chemins complets). */
function requiredModules(file) {
  const code = stripComments(readFileSync(file, 'utf8'));
  const names = [...code.matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]);
  assert.equal(names.length, [...code.matchAll(/\brequire\s*\(/g)].length, `${relative(file)} : forme de require non reconnue`);
  const modules = [];
  for (const name of names) {
    // Modules fournis par Electron ou par Node : rien à embarquer.
    if (ELECTRON_MODULES.includes(name) || name.startsWith('node:')) continue;
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
  for (const name of ['src/services/index.js', 'src/services/settings.js', 'src/services/platform.js', 'src/services/files.js', 'src/services/file-operations.js', 'src/main/selftest-explorer.js']) {
    assert.ok(required.has(name), name);
  }
});

test('le module de fichiers d’origine n’est requis que par le processus principal, pour l’explorateur', () => {
  const users = desktopFiles.filter((file) => /require\(\s*'original-fs'\s*\)/.test(stripComments(readFileSync(file, 'utf8')))).map(relative);
  assert.deepEqual(users, ['src/main/main.js']);
  const main = stripComments(readText('src/main/main.js'));
  // Hors d'Electron (tests), ce module n'existe pas : le module de Node le remplace.
  assert.match(main, /try \{\s*return require\('original-fs'\);\s*\} catch \{\s*return fs;/);
  // Il n'est remis qu'au service de fichiers, qui ne s'en sert que pour lire.
  assert.equal([...main.matchAll(/plainFileSystem\(\)/g)].length, 2, 'une définition, un usage');
  assert.match(main, /fs: plainFileSystem\(\)/);
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
  // Aucune API d'accès au système n'est utilisée par l'application : ni lancement de programme, ni registre,
  // ni ouverture d'une adresse. (Seules exceptions, contrôlées plus bas : la Corbeille et l'ouverture d'un fichier.)
  for (const source of ['src/main/main.js', 'src/main/preload.js']) {
    const code = stripComments(readText(source));
    assert.doesNotMatch(code, /\b(?:child_process|shell\.openExternal|registry|regedit|powerShell|exec\(|spawn\()/i, source);
  }
  // Le script de préchargement, lui, n'a accès à rien d'autre qu'aux canaux de communication.
  assert.doesNotMatch(stripComments(readText('src/main/preload.js')), /\bshell\b|\bopenPath\b|\btrashItem\b/);
});

test('Windows n’est sollicité que pour trois gestes : envoyer à la Corbeille, ouvrir un fichier, déplacer sans rien remplacer', () => {
  const main = stripComments(readText('src/main/main.js'));
  // Deux fonctions du module « shell », chacune appelée à un seul endroit.
  assert.deepEqual([...main.matchAll(/\bshell\.(\w+)/g)].map((match) => match[1]).sort(), ['openPath', 'trashItem']);
  assert.equal([...main.matchAll(/\bshell\b/g)].length, 3, 'une importation, deux appels');
  // Chacune est enveloppée dans une fonction qui ne fait rien d'autre : ni option, ni repli.
  assert.match(main, /function sendToRecycleBin\(location\) \{\s*return shell\.trashItem\(location\);\s*\}/);
  assert.match(main, /function openWithAssociatedApp\(location\) \{\s*return shell\.openPath\(location\);\s*\}/);
  // Ces deux fonctions ne sont remises qu'aux opérations sur les fichiers, qui contrôlent chaque chemin avant de s'en servir.
  assert.equal([...main.matchAll(/\bsendToRecycleBin\b/g)].length, 2, 'une définition, un usage');
  assert.equal([...main.matchAll(/\bopenWithAssociatedApp\b/g)].length, 2, 'une définition, un usage');
  assert.match(main, /operations: \{ trash: sendToRecycleBin, openPath: openWithAssociatedApp, moveNoReplace \},/);
  // Aucun autre fichier de l'application de bureau ne touche au module « shell ».
  for (const file of desktopFiles) {
    if (file.endsWith(path.join('main', 'main.js'))) continue;
    assert.doesNotMatch(stripComments(readFileSync(file, 'utf8')), /\bshell\b|\btrashItem\b|\bopenExternal\b|\bshowItemInFolder\b/, relative(file));
  }

  // Troisième geste : le déplacement sans remplacement, demandé à Windows par le module natif. Il est chargé une
  // seule fois ; s'il ne peut pas l'être, la fonction reste absente — rien ne la remplace.
  assert.equal([...main.matchAll(/\bloadAtomicMove\b/g)].length, 2, 'une importation, un appel');
  assert.match(main, /let moveNoReplace = null;[\s\S]*?\ntry \{\s*moveNoReplace = loadAtomicMove\(\);\s*\} catch \(error\) \{\s*moveNoReplaceFailure = [^\n]+\n\s*console\.warn\([^\n]+\);\s*\}/);
  // Elle n'est remise qu'aux opérations sur les fichiers, et à l'auto-test, qui l'éprouve sur le disque.
  assert.equal([...main.matchAll(/\bmoveNoReplace\b/g)].length, 4, 'une déclaration, un chargement, deux usages');
  // Un auto-test n'a pas lieu sans elle : l'exécutable ne serait pas publié.
  assert.match(main, /if \(moveNoReplaceFailure\) return abortSelfTest\(moveNoReplaceFailure\);/);
  // Aucun repli : le processus principal ne renomme ni ne déplace rien par lui-même.
  assert.doesNotMatch(main, /\b\w*[fF]s\s*(?:\.\s*promises\s*)?\.\s*rename(?:Sync)?\b|\brenameSync\b|\bMoveFile/);
  // Seul le chargeur connaît le module natif ; lui-même n'emploie pas le module de fichiers de Node.
  for (const file of desktopFiles) {
    if (file.endsWith(path.join('main', 'atomic-move.js'))) continue;
    assert.doesNotMatch(stripComments(readFileSync(file, 'utf8')), /evolve_fs|\bdlopen\b|\.node'/, relative(file));
  }
  const loader = stripComments(readText('src/main/atomic-move.js'));
  assert.deepEqual([...loader.matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]), ['node:path', 'node:util']);
  assert.match(loader, /const ADDON_FILE = nodePath\.join\(__dirname, '\.\.', '\.\.', 'native', 'build', 'Release', 'evolve_fs\.node'\);/);
  // La couche de services, elle, ne connaît qu'une fonction remise par l'hôte : elle n'appelle jamais le renommage de Node.
  for (const file of listFiles(fromRoot('src', 'services'), ['.js'])) {
    const code = stripComments(readFileSync(file, 'utf8'));
    if (file.endsWith('json-file.js')) continue; // fichier des réglages d'Evolve : remplacé volontairement par sa nouvelle version
    assert.doesNotMatch(code, /\b\w*[fF]s\s*(?:\.\s*promises\s*)?\.\s*rename(?:Sync)?\b|\bdisk\.rename\b|\brenameSync\b/, relative(file));
  }
});

test('module natif : source, compilation et empaquetage', () => {
  // Description de la compilation (format gyp : du JSON, avec des commentaires).
  const gyp = JSON.parse(readText('native/binding.gyp').replace(/^\s*#.*$/gm, ''));
  assert.equal(gyp.targets.length, 1);
  assert.deepEqual([gyp.targets[0].target_name, gyp.targets[0].sources], ['evolve_fs', ['evolve_fs.c']]);
  assert.ok(existsSync(fromRoot('native', 'evolve_fs.c')));
  // Compilé par un script npm, avec node-gyp, dépendance de développement figée (voir plus bas).
  assert.equal(pkg.scripts['build:native'], 'node-gyp rebuild --directory=native');
  assert.equal(pkg.scripts['check:native'], 'node scripts/check-native.mjs');
  assert.match(pkg.devDependencies['node-gyp'], /^\d+\.\d+\.\d+$/);
  // Le résultat de la compilation n'est pas versionné…
  assert.match(readText('.gitignore'), /^native\/build\/$/m);
  // … mais il est embarqué dans l'exécutable, hors de l'archive de l'application : Windows doit pouvoir le charger.
  const addon = 'native/build/Release/evolve_fs.node';
  assert.ok(pkg.build.files.includes(addon));
  assert.deepEqual(pkg.build.asarUnpack, [addon]);
  assert.equal(pkg.build.asar, true);
  // C'est bien le fichier que l'application charge, et il a été compilé avant les tests.
  const { ADDON_FILE } = createRequire(import.meta.url)('../src/main/atomic-move.js');
  assert.equal(relative(ADDON_FILE), addon);
  assert.ok(existsSync(ADDON_FILE), 'module natif absent : compilez-le avec « npm run build:native »');
  // Rien d'autre du dossier « native » n'est embarqué : ni la source, ni les fichiers intermédiaires.
  assert.deepEqual(pkg.build.files.filter((pattern) => pattern.startsWith('native')), [addon]);
});

// --- Inventaire de ce qui peut écrire sur le disque ------------------------------------

/** Fonctions du module de fichiers de Node qui créent, modifient ou suppriment — nom sans ambiguïté. */
const FS_WRITERS = [
  'appendFile', 'appendFileSync', 'writeFile', 'writeFileSync', 'writeSync', 'writev', 'writevSync', 'createWriteStream',
  'mkdirSync', 'mkdtemp', 'mkdtempSync', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'renameSync',
  'copyFile', 'copyFileSync', 'cpSync', 'truncateSync', 'ftruncate', 'ftruncateSync',
  'symlink', 'symlinkSync', 'linkSync', 'chmod', 'chmodSync', 'fchmod', 'fchmodSync', 'lchmod', 'lchmodSync',
  'chown', 'chownSync', 'fchown', 'fchownSync', 'lchown', 'lchownSync', 'utimes', 'utimesSync', 'futimes', 'futimesSync',
  'lutimes', 'lutimesSync', 'fsync', 'fsyncSync', 'fdatasync', 'fdatasyncSync', 'openSync',
];
/** Mêmes fonctions, au nom courant : reconnues seulement appelées sur un module de fichiers (`fs.mkdir`, `nodeFs.rm`…). */
const FS_WRITERS_SHORT = ['mkdir', 'rm', 'cp', 'rename', 'link', 'open', 'write', 'truncate'];

/** Fonctions d'écriture du module de fichiers employées par un texte de programme, triées. */
function writersIn(code) {
  const plain = [...code.matchAll(new RegExp(`\\b(${FS_WRITERS.join('|')})\\b`, 'g'))].map((match) => match[1]);
  const short = [...code.matchAll(new RegExp(`\\b\\w*[fF]s\\s*(?:\\.\\s*promises\\s*)?\\.\\s*(${FS_WRITERS_SHORT.join('|')})\\b`, 'g'))].map((match) => match[1]);
  return [...new Set([...plain, ...short])].sort();
}

test('chaque écriture sur le disque est inventoriée : les fichiers de l’utilisateur ne sont modifiés que par les opérations sur les fichiers', () => {
  // La détection reconnaît bien les formes d'appel, sans se méprendre sur des mots voisins.
  assert.deepEqual(
    writersIn("fs.mkdir(dir); nodeFs.promises.rm(x); fs.writeFileSync(a, b); io.fs.rename(a, b); original_fs.open(f, 'w'); fs.truncate(f)"),
    ['mkdir', 'open', 'rename', 'rm', 'truncate', 'writeFileSync'],
  );
  assert.deepEqual(writersIn("nav.open('documents'); const truncated = list.truncate; ['write', 'mkdir', 'rename']; el.querySelector('.truncate'); window.open(); fs.opendir(dir); fs.lstat(a)"), []);

  // Fichier → fonctions d'écriture qu'il emploie. Tout autre fichier n'en emploie aucune.
  const EXPECTED = {
    // Journal d'erreur de l'auto-test (option --self-test) ; dossier de travail du moteur, dans le dossier temporaire.
    'src/main/main.js': ['appendFileSync', 'mkdirSync'],
    // Auto-test (option --self-test) : rapport et captures, dans le dossier de résultats.
    'src/main/selftest.js': ['mkdirSync', 'writeFileSync'],
    // Auto-test : dossier d'essai de l'explorateur, créé dans le dossier de résultats.
    'src/main/selftest-explorer.js': ['mkdirSync', 'mkdtempSync', 'rmdirSync', 'utimesSync', 'writeFileSync'],
    // Auto-test : éléments d'essai de la vérification « rien n'est remplacé », créés dans le dossier que l'appelant
    // lui confie — des dossiers, des fichiers, un lien. Rien qui renomme ni supprime : les déplacements sont
    // demandés à la fonction éprouvée.
    'src/main/selftest-no-replace.js': ['mkdir', 'mkdirSync', 'symlinkSync', 'writeFile', 'writeFileSync'],
    // Auto-test : atelier des opérations, créé lui aussi dans le dossier de résultats — des dossiers, des fichiers,
    // un lien. Rien qui déplace, remplace ou supprime : les opérations elles-mêmes sont demandées à l'application.
    'src/main/selftest-operations.js': ['mkdirSync', 'symlinkSync', 'writeFileSync'],
    // Compte rendu de démarrage (option --status-file), pour la vérification du lancement.
    'src/main/status.js': ['mkdirSync', 'renameSync', 'writeFileSync'],
    // Opérations sur les fichiers de l'utilisateur, à sa demande : créer un dossier, copier un fichier. Deux
    // fonctions, que le système refuse si le nom existe ; aucune ne supprime ni ne remplace. Le renommage de
    // Node, qui remplace, n'y figure plus : renommer et déplacer passent par la fonction sans remplacement
    // de l'hôte (voir tests/file-operations.test.mjs).
    'src/services/file-operations.js': ['copyFile', 'mkdir'],
    // Fichier des réglages (%APPDATA%\Evolve\settings.json), écrit seulement après un réglage modifié.
    'src/services/json-file.js': ['fsyncSync', 'mkdirSync', 'openSync', 'renameSync', 'rmSync', 'writeFileSync'],
  };
  const found = {};
  for (const file of desktopFiles) {
    const code = stripComments(readFileSync(file, 'utf8'));
    // Le module de fichiers est toujours désigné en entier : ses fonctions ne sont ni extraites ni renommées.
    assert.doesNotMatch(code, /\{[^}]*\}\s*=\s*require\(\s*'(?:node:)?fs(?:\/promises)?'\s*\)/, relative(file));
    assert.doesNotMatch(code, /require\(\s*'(?:node:)?fs\/promises'\s*\)|\bfs\s*\[/i, relative(file));
    const writers = writersIn(code);
    if (writers.length) found[relative(file)] = writers;
  }
  assert.deepEqual(found, EXPECTED);

  // En particulier : ni le service de consultation, ni la recherche des dossiers personnels, ni le point d'accès aux services.
  for (const name of ['src/services/files.js', 'src/main/personal-folders.js', 'src/main/selftest-documents.js', 'src/services/hub.js', 'src/services/index.js', 'src/main/preload.js']) {
    assert.ok(desktopFiles.map(relative).includes(name) && !Object.hasOwn(found, name), name);
  }
  // (Le service de consultation ne retient du module de fichiers que quatre fonctions de lecture : voir tests/files.test.mjs.)
});

test('la copie récursive de Node (fs.cp, fs.cpSync) n’est employée nulle part : ni l’application, ni les scripts, ni les tests', () => {
  // Sous Windows, cette fonction décode les chemins dans la page de codes du système au lieu d'UTF-8 : devant un
  // dossier dont le nom porte un accent, elle arrête Node sur-le-champ, sans erreur ni message (nodejs/node#58768).
  // Une copie se fait fichier par fichier (`copyFile`), dans des dossiers créés un à un (`mkdir`).
  const uses = (code) => /\bcpSync\b|\b\w*[fF]s\s*(?:\.\s*promises\s*)?\.\s*cp\b|\bcp\s*(?:,|\}\s*(?:=|from))/.test(code);
  assert.ok(uses("cpSync(a, b, { recursive: true })") && uses('await fs.promises.cp(a, b)') && uses("import { cp, rm } from 'node:fs/promises'") && uses('nodeFs.cp(a, b, done)'));
  assert.ok(!uses("fs.copyFileSync(a, b); copyTree(a, b); const scp = 1; fs.cpus; 'cp returned EEXIST'"));

  const sources = [
    ...desktopFiles,
    ...jsFiles,
    ...listFiles(fromRoot('scripts'), ['.js', '.mjs', '.cjs']),
    ...listFiles(fromRoot('tests'), ['.js', '.mjs', '.cjs']),
  ];
  assert.ok(sources.length >= 80, 'application, interface, scripts et tests');
  // Ce fichier-ci est mis à part : il nomme la fonction pour la reconnaître.
  const guilty = sources.filter((file) => relative(file) !== 'tests/project.test.mjs' && uses(stripComments(readFileSync(file, 'utf8')))).map(relative);
  assert.deepEqual(guilty, []);
});

test('le moteur n’est interrogé que sur des emplacements qu’il ne crée pas, et n’écrit rien de lui-même', () => {
  const main = stripComments(readText('src/main/main.js'));
  // Emplacements demandés par leur nom : aucun dossier personnel (le moteur créerait « Documents »).
  const named = [...main.matchAll(/\bgetPath\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]).sort();
  assert.deepEqual(named, ['appData', 'temp', 'userData']);
  // Une seule autre demande : celle des dossiers personnels, confiée au module qui sait lesquels demander.
  const others = [...main.matchAll(/\bgetPath\(\s*(?!')([^)]*)\)/g)].map((match) => match[1].trim());
  assert.deepEqual(others, ['name']);
  assert.match(main, /function locatePersonalFolders\(known\) \{\s*return personalFolders\(\{ getPath: \(name\) => app\.getPath\(name\), known \}\);\s*\}/);
  assert.match(main, /files: \{ places: locatePersonalFolders,/);

  // Aucun autre fichier ne s'adresse au moteur pour un emplacement.
  const askers = desktopFiles.filter((file) => /\bgetPath\b/.test(stripComments(readFileSync(file, 'utf8')))).map(relative);
  assert.deepEqual(askers, ['src/main/main.js', 'src/main/personal-folders.js']);
  // Ni ne modifie un emplacement, hormis le dossier de travail du moteur, placé dans le dossier temporaire.
  assert.deepEqual([...main.matchAll(/\bsetPath\(\s*'([^']+)'/g)].map((match) => match[1]), ['userData']);
  assert.match(main, /const userData = path\.join\(app\.getPath\('temp'\),/);

  // Fonctions d'Electron qui écrivent sur le disque ou dans Windows : aucune n'est employée — hormis l'envoi à la
  // Corbeille et l'ouverture d'un fichier, deux appels du processus principal contrôlés par le test précédent.
  for (const source of ['src/main/main.js', 'src/main/preload.js', 'src/main/personal-folders.js']) {
    const code = stripComments(readText(source));
    assert.doesNotMatch(
      code,
      /\b(?:clipboard|nativeImage|crashReporter|contentTracing|netLog|autoUpdater|downloadURL|savePage|printToPDF|setDownloadPath|setSavePath|showSaveDialog|showOpenDialog|startDrag|writeShortcutLink|addRecentDocument|setJumpList|setUserTasks|setLoginItemSettings|setAsDefaultProtocolClient|setAppLogsPath|openExternal|showItemInFolder|beep)\b/,
      source,
    );
    if (source !== 'src/main/main.js') assert.doesNotMatch(code, /\b(?:shell|trashItem|openPath)\b/, source);
  }
  // Et tout téléchargement est annulé.
  assert.match(main, /session\.defaultSession\.on\('will-download', \(event\) => event\.preventDefault\(\)\);/);
});

test('la passerelle expose exactement ce que l’interface utilise', () => {
  const preload = stripComments(readText('src/main/preload.js'));
  const main = stripComments(readText('src/main/main.js'));
  const platform = stripComments(readText('src/renderer/js/core/platform.js'));

  // Méthodes appelées par l'interface sur `window.evolve`.
  const used = new Set([...platform.matchAll(/\bhost\.([A-Za-z]+)/g)].map((match) => match[1]));
  assert.deepEqual([...used].sort(), ['files', 'isFullscreen', 'onFullscreenChange', 'quit', 'services', 'toggleFullscreen']);
  for (const name of used) assert.match(preload, new RegExp(`\\b${name}:`), `preload.js n'expose pas ${name}`);
  assert.match(preload, /exposeInMainWorld\('evolve'/);
  assert.match(platform, /globalThis\.evolve/);

  // Services : l'interface n'appelle que « call » et « on », seules entrées exposées.
  const client = stripComments(readText('src/renderer/js/core/services.js'));
  const serviceUses = new Set([...client.matchAll(/\bhost\.([A-Za-z]+)/g)].map((match) => match[1]));
  assert.deepEqual([...serviceUses].sort(), ['call', 'on']);
  const exposedServices = preload.match(/\bservices: \{([\s\S]*?)\n {2}\},\n/)?.[1];
  assert.ok(exposedServices, 'entrée « services » de preload.js non reconnue');
  assert.deepEqual([...exposedServices.matchAll(/^ {4}([A-Za-z]+): /gm)].map((match) => match[1]), ['call', 'on']);

  // Opérations sur les fichiers : l'interface n'appelle que les huit fonctions exposées — dernière entrée de la passerelle.
  const operationsClient = stripComments(readText('src/renderer/js/core/file-operations.js'));
  const operationUses = new Set([...operationsClient.matchAll(/\bhost\.([A-Za-z]+)/g)].map((match) => match[1]));
  const FILE_FUNCTIONS = ['createFolder', 'rename', 'copy', 'move', 'trash', 'open', 'cancel', 'onProgress'];
  assert.deepEqual([...operationUses].sort(), [...FILE_FUNCTIONS].sort());
  const exposedFiles = preload.match(/\bfiles: \{([\s\S]*)\n {2}\},\n\}\);/)?.[1];
  assert.ok(exposedFiles, 'entrée « files » de preload.js non reconnue');
  assert.deepEqual([...exposedFiles.matchAll(/^ {4}([A-Za-z]+): /gm)].map((match) => match[1]), FILE_FUNCTIONS);
  // Aucune de ces fonctions ne supprime définitivement, ne remplace, ne lit ni n'écrit un contenu.
  assert.doesNotMatch(exposedFiles, /\b(?:delete|remove|unlink|erase|replace|overwrite|write|read|exec|run)[A-Za-z]*: /i);

  // Aucun autre module de l'interface ne touche à la passerelle.
  for (const file of jsFiles) {
    if (file.endsWith(path.join('core', 'platform.js'))) continue;
    assert.doesNotMatch(stripComments(readFileSync(file, 'utf8')), /(?:globalThis|window|self)\.evolve\b/, relative(file));
  }

  // Canaux de communication : chaque canal émis est traité de l'autre côté.
  const channels = (code) => new Set([...code.matchAll(/'(evolve:[a-z-]+)'/g)].map((match) => match[1]));
  assert.deepEqual([...channels(preload)].sort(), [...channels(main)].sort());
  assert.deepEqual([...channels(preload)].sort(), [
    'evolve:files-cancel',
    'evolve:files-copy',
    'evolve:files-create-folder',
    'evolve:files-move',
    'evolve:files-open',
    'evolve:files-progress',
    'evolve:files-rename',
    'evolve:files-trash',
    'evolve:fullscreen-changed',
    'evolve:is-fullscreen',
    'evolve:quit',
    'evolve:service-call',
    'evolve:service-event',
    'evolve:toggle-fullscreen',
  ]);
  // Opérations sur les fichiers : un canal par opération, écrit en toutes lettres des deux côtés, une seule fois.
  // La page ne choisit jamais un canal : aucun nom de canal n'est calculé.
  for (const channel of [...channels(preload)].filter((name) => name.startsWith('evolve:files-'))) {
    assert.equal(preload.split(`'${channel}'`).length - 1, 1, `preload.js : ${channel}`);
    assert.equal(main.split(`'${channel}'`).length - 1, 1, `main.js : ${channel}`);
  }
  const requested = [...preload.matchAll(/\bipcRenderer\.(?:invoke|send|on|removeListener)\(\s*([^,)]+)/g)].map((match) => match[1].trim());
  assert.ok(requested.length >= 14);
  // L'avancement des opérations : un seul écouteur, posé une fois pour toutes — jamais un par fenêtre de l'explorateur.
  assert.match(preload, /^ipcRenderer\.on\('evolve:files-progress', /m, "l'écouteur de l'avancement doit être posé au chargement de la passerelle");
  for (const name of requested) assert.match(name, /^'evolve:[a-z-]+'$/, `canal calculé : ${name}`);
  const handled = [...main.matchAll(/\bipcMain\.(?:handle|on)\(\s*([^,)]+)/g)].map((match) => match[1].trim());
  assert.equal(handled.length, 11);
  for (const name of handled) assert.match(name, /^'evolve:[a-z-]+'$/, `canal calculé : ${name}`);
  // Chaque demande d'opération est refusée si elle ne vient pas de la fenêtre de l'application.
  const guarded = [...main.matchAll(/ipcMain\.handle\('evolve:files-[a-z-]+', \(event(?:, [a-z, ]+)?\) => \(trusted\(event\) \? services\.fileOperations\.(\w+)\(/g)].map((match) => match[1]);
  assert.deepEqual(guarded, ['createFolder', 'rename', 'copy', 'move', 'trash', 'open', 'cancel']);
  assert.match(main, /const trusted = \(event\) => fromMainWindow\(event\) && Boolean\(services\);/);
  // Aucun service n'ouvre son propre canal : la communication avec la page n'appartient qu'au processus principal.
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
  assert.deepEqual(build.files, ['package.json', 'THIRD-PARTY-NOTICES.md', 'src/main/**/*', 'src/services/**/*', 'src/renderer/**/*', 'assets/**/*', 'native/build/Release/evolve_fs.node']);
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
    // Le module natif est compilé, puis éprouvé sur le disque, avant tout le reste.
    'npm run build:native',
    'check-native.mjs --record=native/build/evolve_fs.sha256',
    'npm test',
    'check-exe.mjs electron',
    'npm run build:win',
    'npm run check:manifest',
    // Le module embarqué a l'empreinte de celui qui a été éprouvé avant les tests — et il est éprouvé de nouveau.
    'check-native.mjs --module=dist/win-unpacked/resources/app.asar.unpacked/native/build/Release/evolve_fs.node --expect=native/build/evolve_fs.sha256',
    'check-exe.mjs --out=self-test-output/executable',
    'check-launch.mjs --out=self-test-output/lancement',
    'check-settings.mjs --out=self-test-output/reglages',
    'check-documents.mjs --out=self-test-output/documents-absent',
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
  assert.ok(!/check-exe|check-launch|check-settings|check-documents|check-native|build:win|build:native|check:manifest|npm test/.test(lenient[0]));

  // Les deux auto-tests complets exigent les gestes réels (souris et clavier injectés) : sans eux, les contrôles du
  // bureau qui en dépendent ne seraient pas menés, et la compilation réussirait sans les avoir faits. L'option est
  // lue par le script : elle précède le séparateur « -- », après lequel tout est transmis à l'application.
  const selfTests = steps.filter((step) => /check-exe\.mjs/.test(step));
  assert.equal(selfTests.length, 2);
  for (const step of selfTests) {
    const command = step.match(/node scripts\/check-exe\.mjs[^\n]*/)[0];
    assert.match(command.split(' -- ')[0], / --require-input(?: |$)/, command);
  }

  // Les réglages sont éprouvés là où ils seront réellement rangés : %APPDATA%\Evolve.
  const settingsStep = steps.find((step) => step.includes('check-settings.mjs'));
  assert.match(settingsStep, /--settings-dir="\$APPDATA\/Evolve"/);

  // Le dossier Documents absent est éprouvé sur l'exécutable produit, avec le véritable dossier du compte
  // (aucun dossier d'essai) : la preuve porte sur le fichier distribué, tel que Windows le fait fonctionner.
  const documentsStep = steps.find((step) => step.includes('check-documents.mjs'));
  assert.match(documentsStep, /^Dossier Documents absent jamais recréé par l'exécutable portable\n/);
  assert.ok(!/--folder|electron|continue-on-error|\bif:/.test(documentsStep), documentsStep);
  assert.match(documentsStep, /timeout-minutes: \d+/);

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
  const lock = JSON.parse(readText('package-lock.json'));
  assert.equal(lock.version, pkg.version, 'package-lock.json');
  assert.equal(lock.packages[''].version, pkg.version, 'package-lock.json (paquet racine)');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  // Le nom du fichier .exe, lui, est composé à partir de ce numéro par la compilation.
  assert.equal(pkg.build.portable.artifactName, 'Evolve-${version}-portable.exe');
});

/** Raccourcis clavier du bureau : reconnaissance d'une commande dans un événement clavier (shell/shortcuts.js). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COMMANDS, commandFor, shortcutLabel } from '../src/renderer/js/shell/shortcuts.js';
import { readText } from './helpers.mjs';

/** Événement « keydown » : `key('Tab', 'ctrl', 'shift')`. */
function key(name, ...modifiers) {
  const has = (modifier) => modifiers.includes(modifier);
  return {
    key: name,
    code: name === ' ' ? 'Space' : '',
    ctrlKey: has('ctrl'),
    altKey: has('alt'),
    shiftKey: has('shift'),
    metaKey: has('meta'),
    repeat: has('repeat'),
    isComposing: has('composing'),
    getModifierState: (state) => state === 'AltGraph' && has('altgr'),
  };
}

/** Événement correspondant au raccourci tel qu'il s'écrit (« Ctrl+Maj+Tab »). */
function eventFor(label) {
  const parts = label.split('+');
  const names = { Tab: 'Tab', Espace: ' ', Haut: 'ArrowUp', Bas: 'ArrowDown', Gauche: 'ArrowLeft', Droite: 'ArrowRight' };
  const modifiers = parts.slice(0, -1).map((part) => ({ Ctrl: 'ctrl', Maj: 'shift', Alt: 'alt' })[part]);
  const last = parts.at(-1);
  return key(names[last] ?? (last.length === 1 ? last.toLowerCase() : last), ...modifiers);
}

test('chaque commande a un identifiant, un intitulé et un raccourci uniques', () => {
  assert.ok(COMMANDS.length >= 10);
  assert.equal(new Set(COMMANDS.map((command) => command.id)).size, COMMANDS.length);
  assert.equal(new Set(COMMANDS.map((command) => command.keys)).size, COMMANDS.length);
  for (const command of COMMANDS) {
    assert.match(command.id, /^[a-z]+(-[a-z]+)*$/);
    assert.ok(command.label.length > 10);
    assert.match(command.keys, /^(?:(?:Ctrl|Alt|Maj)\+)*(?:Tab|Espace|Haut|Bas|Gauche|Droite|F\d{1,2}|[A-Z])$/, command.keys);
    assert.equal(shortcutLabel(command.id), command.keys);
  }
  assert.equal(shortcutLabel('inconnue'), '');
  assert.ok(Object.isFrozen(COMMANDS));
});

test('le raccourci écrit pour l’utilisateur est bien celui qui déclenche la commande', () => {
  for (const command of COMMANDS) assert.equal(commandFor(eventFor(command.keys)), command.id, command.keys);
});

test('bascule entre fenêtres, fermeture, nouvelle fenêtre, menu Démarrer', () => {
  assert.equal(commandFor(key('Tab', 'ctrl')), 'switch-next');
  assert.equal(commandFor(key('Tab', 'ctrl', 'shift')), 'switch-previous');
  // Convention des applications à plusieurs fenêtres : Ctrl + F6 aussi.
  assert.equal(commandFor(key('F6', 'ctrl')), 'switch-next');
  assert.equal(commandFor(key('F6', 'ctrl', 'shift')), 'switch-previous');
  assert.equal(commandFor(key('w', 'ctrl')), 'close-window');
  assert.equal(commandFor(key('W', 'ctrl')), 'close-window', 'verrouillage des majuscules');
  assert.equal(commandFor(key('F4', 'ctrl')), 'close-window');
  assert.equal(commandFor(key('n', 'ctrl')), 'new-window');
  assert.equal(commandFor(key(' ', 'ctrl')), 'start-menu');
  assert.equal(commandFor({ ...key('Unidentified', 'ctrl'), code: 'Space' }), 'start-menu');
});

test('Alt + Maj remplace la touche Windows : fenêtre active, bureau, explorateur', () => {
  assert.equal(commandFor(key('ArrowUp', 'alt', 'shift')), 'window-maximize');
  assert.equal(commandFor(key('ArrowDown', 'alt', 'shift')), 'window-restore');
  assert.equal(commandFor(key('ArrowLeft', 'alt', 'shift')), 'window-snap-left');
  assert.equal(commandFor(key('ArrowRight', 'alt', 'shift')), 'window-snap-right');
  // Avec Maj, la touche produit une majuscule.
  assert.equal(commandFor(key('D', 'alt', 'shift')), 'show-desktop');
  assert.equal(commandFor(key('d', 'alt', 'shift')), 'show-desktop');
  assert.equal(commandFor(key('E', 'alt', 'shift')), 'open-explorer');
});

test('F6 passe d’une zone de l’écran à l’autre', () => {
  assert.equal(commandFor(key('F6')), 'next-region');
  assert.equal(commandFor(key('F6', 'shift')), 'previous-region');
  assert.equal(commandFor(key('F6', 'alt')), null);
});

test('les modificateurs doivent correspondre exactement', () => {
  const nothing = [
    // Les raccourcis de l'explorateur et de la saisie ne sont pas pris par le bureau.
    key('n', 'ctrl', 'shift'), // nouveau dossier
    key('ArrowUp', 'alt'), // dossier parent
    key('ArrowLeft', 'alt'), // précédent
    key('ArrowLeft', 'ctrl', 'shift'), // sélection d'un mot
    key('c', 'ctrl'),
    key('v', 'ctrl'),
    key('a', 'ctrl'),
    key('f', 'ctrl'),
    key('F5'),
    key('F2'),
    key('Delete'),
    key('Enter'),
    key('Escape'),
    key('Tab'),
    key('Tab', 'shift'),
    key(' '),
    key('w'),
    key('d'),
    // Combinaisons voisines.
    key('w', 'ctrl', 'shift'),
    key('w', 'ctrl', 'alt'),
    key('Tab', 'ctrl', 'alt'),
    key('Tab', 'alt'),
    key('F4', 'alt'), // quitter Evolve : laissé à Windows
    key(' ', 'ctrl', 'shift'),
    key(' ', 'alt'),
    key('d', 'alt'),
    key('d', 'ctrl', 'alt', 'shift'),
    key('ArrowUp', 'ctrl', 'alt', 'shift'),
    key('ArrowUp', 'shift'),
    key('x', 'alt', 'shift'),
  ];
  for (const event of nothing) assert.equal(commandFor(event), null, JSON.stringify({ key: event.key, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey }));
});

test('la touche Windows, AltGr et la composition d’un caractère ne déclenchent rien', () => {
  // Touche Windows enfoncée : ces combinaisons appartiennent à Windows.
  assert.equal(commandFor(key('Tab', 'ctrl', 'meta')), null);
  assert.equal(commandFor(key('d', 'meta')), null);
  assert.equal(commandFor(key('ArrowUp', 'alt', 'shift', 'meta')), null);
  // AltGr vaut Ctrl + Alt et sert à saisir des caractères (€, @, #…).
  assert.equal(commandFor(key('e', 'ctrl', 'alt', 'altgr')), null);
  assert.equal(commandFor(key('E', 'alt', 'shift', 'altgr')), null);
  assert.equal(commandFor(key('Tab', 'ctrl', 'altgr')), null);
  // Composition en cours (accent circonflexe, saisie asiatique).
  assert.equal(commandFor(key('w', 'ctrl', 'composing')), null);
  assert.equal(commandFor(key('Tab', 'ctrl', 'composing')), null);
});

test('une touche maintenue ne répète que la bascule entre fenêtres', () => {
  assert.equal(commandFor(key('Tab', 'ctrl', 'repeat')), 'switch-next');
  assert.equal(commandFor(key('Tab', 'ctrl', 'shift', 'repeat')), 'switch-previous');
  // Ctrl + W gardé enfoncé ne ferme qu'une fenêtre ; il en va de même de toutes les autres commandes.
  for (const command of COMMANDS) {
    if (command.id.startsWith('switch-')) continue;
    assert.equal(commandFor({ ...eventFor(command.keys), repeat: true }), null, command.keys);
  }
});

test('un événement incomplet ou étranger ne lève pas d’exception', () => {
  for (const event of [null, undefined, {}, { key: 42 }, { key: null, ctrlKey: true }, { ctrlKey: true }]) assert.equal(commandFor(event), null);
  // Sans `getModifierState` (événement fabriqué) : le raccourci reste reconnu.
  assert.equal(commandFor({ key: 'Tab', ctrlKey: true }), 'switch-next');
});

test('les raccourcis laissés à Windows ne sont repris nulle part', () => {
  // Alt + F4 quitte Evolve (Windows ferme la fenêtre de l'application) ; Alt + Tab, la touche Windows
  // et Ctrl + Échap sont traités par Windows avant toute application.
  const source = readText('src/renderer/js/shell/shortcuts.js');
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, ''), /'Alt\+Tab'|'Alt\+F4'|Meta|Super|'Escape'/);
  for (const command of COMMANDS) assert.doesNotMatch(command.keys, /^(Alt\+Tab|Alt\+F4|Ctrl\+Échap|Win)/);
});

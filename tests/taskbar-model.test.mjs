/** Barre des tâches : ce qu'elle montre des fenêtres ouvertes, et ce que fait un clic (shell/taskbar-model.js). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buttonTip, clickAction, taskbarButtons } from '../src/renderer/js/shell/taskbar-model.js';

const win = (id, appId, { minimized = false, title = `${appId} ${id}` } = {}) => ({ id, appId, title, minimized });
const summary = (buttons) => buttons.map((button) => `${button.appId}:${button.windows.length}${button.active ? '*' : ''}${button.pinned ? '' : ' (non épinglée)'}`);

test('aucune fenêtre : seules les applications épinglées figurent, sans témoin', () => {
  const buttons = taskbarButtons({ pinned: ['explorer'], windows: [], activeId: null });
  assert.deepEqual(buttons, [{ appId: 'explorer', pinned: true, running: false, active: false, windows: [] }]);
  assert.deepEqual(taskbarButtons({}), []);
});

test('les boutons reflètent les fenêtres ouvertes : épinglées d’abord, puis les autres applications ouvertes', () => {
  const windows = [win('w1', 'notes'), win('w2', 'explorer'), win('w3', 'notes'), win('w4', 'explorer')];
  const buttons = taskbarButtons({ pinned: ['explorer', 'terminal'], windows, activeId: 'w3' });
  assert.deepEqual(summary(buttons), ['explorer:2', 'terminal:0', 'notes:2* (non épinglée)']);
  // Les fenêtres d'une application sont dans leur ordre d'ouverture, et la fenêtre active est désignée.
  assert.deepEqual(buttons[0].windows.map((item) => item.id), ['w2', 'w4']);
  assert.deepEqual(buttons[2].windows.map((item) => [item.id, item.active]), [['w1', false], ['w3', true]]);
  assert.deepEqual([buttons[0].running, buttons[1].running, buttons[2].running], [true, false, true]);
  // Une application épinglée deux fois ne figure qu'une fois.
  assert.equal(taskbarButtons({ pinned: ['explorer', 'explorer'], windows: [], activeId: null }).length, 1);
});

test('une fenêtre réduite n’est jamais « active », même si son identifiant est celui de la fenêtre active', () => {
  const [button] = taskbarButtons({ pinned: ['explorer'], windows: [win('w1', 'explorer', { minimized: true })], activeId: 'w1' });
  assert.deepEqual([button.running, button.active, button.windows[0].active], [true, false, false]);
});

test('une application dont toutes les fenêtres sont fermées quitte la barre, sauf si elle est épinglée', () => {
  const before = taskbarButtons({ pinned: ['explorer'], windows: [win('w1', 'notes'), win('w2', 'explorer')], activeId: 'w1' });
  assert.deepEqual(summary(before), ['explorer:1', 'notes:1* (non épinglée)']);
  const after = taskbarButtons({ pinned: ['explorer'], windows: [], activeId: null });
  assert.deepEqual(summary(after), ['explorer:0']);
});

test('clic sur un bouton : lancer, activer, réduire, ou choisir parmi plusieurs fenêtres', () => {
  const button = (windows, activeId = null) => taskbarButtons({ pinned: ['explorer'], windows, activeId })[0];
  // Aucune fenêtre : l'application est lancée.
  assert.deepEqual(clickAction(button([])), { type: 'launch' });
  // Une fenêtre, en arrière-plan ou réduite : elle est activée.
  assert.deepEqual(clickAction(button([win('w1', 'explorer')])), { type: 'activate', id: 'w1' });
  assert.deepEqual(clickAction(button([win('w1', 'explorer', { minimized: true })], 'w1')), { type: 'activate', id: 'w1' });
  // Une fenêtre, active : elle est réduite.
  assert.deepEqual(clickAction(button([win('w1', 'explorer')], 'w1')), { type: 'minimize', id: 'w1' });
  // Plusieurs fenêtres : leur liste est proposée, que l'une soit active ou non.
  const several = [win('w1', 'explorer'), win('w2', 'explorer')];
  assert.deepEqual(clickAction(button(several)), { type: 'pick' });
  assert.deepEqual(clickAction(button(several, 'w2')), { type: 'pick' });
});

test('clic avec Maj, ou du bouton du milieu : une fenêtre de plus — ou le lancement, s’il n’y en a aucune', () => {
  const button = (windows, activeId = null) => taskbarButtons({ pinned: ['explorer'], windows, activeId })[0];
  assert.deepEqual(clickAction(button([]), { newWindow: true }), { type: 'launch' });
  assert.deepEqual(clickAction(button([win('w1', 'explorer')], 'w1'), { newWindow: true }), { type: 'new-window' });
  assert.deepEqual(clickAction(button([win('w1', 'explorer'), win('w2', 'explorer')]), { newWindow: true }), { type: 'new-window' });
  // Sans la demande, le comportement habituel.
  assert.deepEqual(clickAction(button([win('w1', 'explorer')], 'w1'), { newWindow: false }), { type: 'minimize', id: 'w1' });
});

test('infobulle : le nom de l’application, le titre de sa fenêtre, ou le nombre de ses fenêtres', () => {
  const button = (windows) => taskbarButtons({ pinned: ['explorer'], windows, activeId: null })[0];
  assert.equal(buttonTip(button([]), 'Explorateur de fichiers'), 'Explorateur de fichiers');
  assert.equal(buttonTip(button([win('w1', 'explorer', { title: 'Documents — Explorateur de fichiers' })]), 'Explorateur de fichiers'), 'Documents — Explorateur de fichiers');
  assert.equal(buttonTip(button([win('w1', 'explorer', { title: '' })]), 'Explorateur de fichiers'), 'Explorateur de fichiers');
  assert.equal(buttonTip(button([win('w1', 'explorer'), win('w2', 'explorer'), win('w3', 'explorer')]), 'Explorateur de fichiers'), 'Explorateur de fichiers — 3 fenêtres');
});

test('les données reçues ne sont pas modifiées', () => {
  const windows = Object.freeze([Object.freeze(win('w1', 'explorer'))]);
  const pinned = Object.freeze(['explorer']);
  const buttons = taskbarButtons({ pinned, windows, activeId: 'w1' });
  assert.notEqual(buttons[0].windows[0], windows[0]);
  assert.equal(Object.hasOwn(windows[0], 'active'), false);
});

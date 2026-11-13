/** Pile des fenêtres : empilement, fenêtre active, réduction, bascule, « afficher le bureau » (wm/stack.js). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WindowStack } from '../src/renderer/js/wm/stack.js';

/** Pile de fenêtres ouvertes l'une après l'autre, chacune activée à son ouverture. */
function stackOf(...ids) {
  const stack = new WindowStack();
  for (const id of ids) {
    stack.add(id);
    stack.activate(id);
  }
  return stack;
}

test('pile vide : aucune fenêtre, aucune fenêtre active', () => {
  const stack = new WindowStack();
  assert.deepEqual([stack.size, stack.active, stack.order, stack.recent, stack.top(), stack.visible()], [0, null, [], [], null, []]);
  assert.equal(stack.cycle(1), null);
  assert.equal(stack.remove('absente'), null);
  assert.equal(stack.minimize('absente'), null);
  assert.equal(stack.activate('absente'), false);
  assert.deepEqual(stack.toggleDesktop(), { action: 'none', ids: [] });
  assert.equal(stack.desktopShown, false);
});

test('chaque fenêtre ouverte passe au premier plan et devient active', () => {
  const stack = stackOf('a', 'b', 'c');
  assert.equal(stack.size, 3);
  assert.deepEqual(stack.order, ['a', 'b', 'c'], 'de l’arrière-plan vers le premier plan');
  assert.deepEqual(stack.recent, ['c', 'b', 'a'], 'de la plus récente à la plus ancienne');
  assert.equal(stack.active, 'c');
  assert.equal(stack.top(), 'c');
  assert.deepEqual([stack.rank('a'), stack.rank('c'), stack.rank('absente')], [0, 2, -1]);
  // Ajouter une fenêtre ne l'active pas : c'est `activate` qui en décide.
  assert.equal(stack.add('d'), true);
  assert.deepEqual([stack.active, stack.order, stack.recent], ['c', ['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a']]);
  // Une fenêtre déjà connue n'est pas ajoutée deux fois.
  assert.equal(stack.add('a'), false);
  assert.equal(stack.size, 4);
  // Les listes rendues sont des copies.
  stack.order.push('intrus');
  stack.recent.push('intrus');
  assert.equal(stack.size, 4);
});

test('activer une fenêtre la place devant les autres, sans changer leur ordre', () => {
  const stack = stackOf('a', 'b', 'c', 'd');
  assert.equal(stack.activate('b'), true);
  assert.deepEqual(stack.order, ['a', 'c', 'd', 'b']);
  assert.deepEqual(stack.recent, ['b', 'd', 'c', 'a']);
  assert.equal(stack.active, 'b');
  // Activer la fenêtre déjà active ne change rien.
  stack.activate('b');
  assert.deepEqual(stack.order, ['a', 'c', 'd', 'b']);
  assert.deepEqual(stack.recent, ['b', 'd', 'c', 'a']);
});

test('clic sur le bureau : plus de fenêtre active, empilement inchangé', () => {
  const stack = stackOf('a', 'b');
  stack.deactivate();
  assert.deepEqual([stack.active, stack.order, stack.top()], [null, ['a', 'b'], 'b']);
  // La fenêtre du dessus redevient active quand on l'active.
  stack.activate('b');
  assert.equal(stack.active, 'b');
});

test('réduire la fenêtre active rend active celle qui était utilisée juste avant', () => {
  const stack = stackOf('a', 'b', 'c');
  stack.activate('a'); // usage : a, c, b
  assert.equal(stack.minimize('a'), 'c');
  assert.equal(stack.active, 'c');
  assert.equal(stack.isMinimized('a'), true);
  assert.deepEqual(stack.visible(), ['b', 'c']);
  assert.equal(stack.top(), 'c');
  // La fenêtre réduite garde sa place dans l'ordre d'usage : la bascule peut la désigner.
  assert.deepEqual(stack.recent, ['a', 'c', 'b']);
  // Réduire une fenêtre qui n'est pas active ne change pas la fenêtre active.
  assert.equal(stack.minimize('b'), 'c');
  assert.equal(stack.active, 'c');
  // Réduire la dernière fenêtre visible : plus aucune fenêtre active.
  assert.equal(stack.minimize('c'), null);
  assert.deepEqual([stack.active, stack.top(), stack.visible()], [null, null, []]);
  // Réduire une fenêtre déjà réduite ne fait rien.
  assert.equal(stack.minimize('c'), null);
});

test('activer une fenêtre réduite la rétablit, devant les autres', () => {
  const stack = stackOf('a', 'b', 'c');
  stack.minimize('c');
  stack.minimize('b');
  assert.equal(stack.active, 'a');
  stack.activate('c');
  assert.deepEqual([stack.active, stack.isMinimized('c'), stack.isMinimized('b')], ['c', false, true]);
  assert.deepEqual(stack.visible(), ['a', 'c']);
});

test('fermer la fenêtre active rend active celle qui était utilisée juste avant, si elle est visible', () => {
  const stack = stackOf('a', 'b', 'c', 'd');
  stack.minimize('c'); // d reste active
  assert.equal(stack.remove('d'), 'b', 'c est réduite : b, utilisée avant elle, devient active');
  assert.deepEqual([stack.active, stack.top(), stack.size], ['b', 'b', 3]);
  assert.deepEqual(stack.order.at(-1), 'b');
  // Fermer une fenêtre d'arrière-plan : la fenêtre active ne change pas.
  assert.equal(stack.remove('a'), 'b');
  assert.deepEqual(stack.order, ['c', 'b']);
  // Fermer une fenêtre réduite : elle disparaît aussi de la liste des fenêtres réduites.
  stack.remove('c');
  assert.equal(stack.isMinimized('c'), false);
  // Fermer la dernière fenêtre.
  assert.equal(stack.remove('b'), null);
  assert.deepEqual([stack.size, stack.active, stack.order, stack.recent], [0, null, [], []]);
});

test('fermer une fenêtre alors qu’aucune n’est active n’en active aucune', () => {
  const stack = stackOf('a', 'b', 'c');
  stack.deactivate();
  assert.equal(stack.remove('b'), null);
  assert.equal(stack.active, null);
  assert.deepEqual(stack.order, ['a', 'c']);
});

test('bascule entre fenêtres : dans l’ordre d’usage, fenêtres réduites comprises, en boucle', () => {
  const stack = stackOf('a', 'b', 'c', 'd'); // usage : d, c, b, a
  assert.equal(stack.cycle(1), 'c', 'un cran : la fenêtre utilisée juste avant');
  assert.equal(stack.cycle(2), 'b');
  assert.equal(stack.cycle(3), 'a');
  assert.equal(stack.cycle(4), 'd', 'la boucle revient à la fenêtre active');
  assert.equal(stack.cycle(-1), 'a', 'en sens inverse : la plus ancienne');
  assert.equal(stack.cycle(0), 'd');
  assert.equal(stack.cycle(9), 'c');
  assert.equal(stack.cycle(-9), 'a');
  // Depuis une autre fenêtre de départ.
  assert.equal(stack.cycle(1, 'b'), 'a');
  assert.equal(stack.cycle(1, 'a'), 'd');
  // Une fenêtre réduite reste proposée.
  stack.minimize('c');
  assert.equal(stack.cycle(1), 'c');
  // Aucune fenêtre active : le premier cran désigne la plus récente, le premier cran inverse la plus ancienne.
  stack.deactivate();
  assert.equal(stack.cycle(1), 'd');
  assert.equal(stack.cycle(-1), 'a');
  assert.equal(stack.cycle(1, 'inconnue'), 'd');
  // Une seule fenêtre : elle-même.
  assert.equal(stackOf('seule').cycle(1), 'seule');
  assert.equal(stackOf('seule').cycle(-1), 'seule');
});

test('afficher le bureau réduit toutes les fenêtres visibles ; le même geste les rétablit à l’identique', () => {
  const stack = stackOf('a', 'b', 'c', 'd');
  stack.minimize('b'); // déjà réduite avant le geste : elle le restera
  stack.activate('a'); // empilement : c, d, a (b réduite)
  assert.deepEqual(stack.toggleDesktop(), { action: 'hide', ids: ['c', 'd', 'a'] });
  assert.deepEqual([stack.active, stack.visible(), stack.desktopShown], [null, [], true]);
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(stack.isMinimized(id), true, id);

  assert.deepEqual(stack.toggleDesktop(), { action: 'show', ids: ['c', 'd', 'a'] });
  assert.deepEqual([stack.active, stack.visible(), stack.desktopShown], ['a', ['c', 'd', 'a'], false]);
  assert.equal(stack.isMinimized('b'), true, 'la fenêtre réduite avant le geste le reste');
  assert.deepEqual(stack.order, ['b', 'c', 'd', 'a']);
});

test('bureau affiché : toute fenêtre touchée entre-temps annule le rétablissement', () => {
  // Une fenêtre rétablie à la main.
  let stack = stackOf('a', 'b', 'c');
  stack.toggleDesktop();
  stack.activate('b');
  assert.equal(stack.desktopShown, false);
  assert.deepEqual(stack.toggleDesktop(), { action: 'hide', ids: ['b'] }, 'le geste suivant réduit de nouveau ce qui est visible');
  assert.deepEqual(stack.toggleDesktop(), { action: 'show', ids: ['b'] });
  assert.deepEqual([stack.isMinimized('a'), stack.isMinimized('c')], [true, true]);

  // Une fenêtre ouverte.
  stack = stackOf('a', 'b');
  stack.toggleDesktop();
  stack.add('c');
  stack.activate('c');
  assert.equal(stack.desktopShown, false);

  // Une fenêtre fermée parmi celles que le geste a réduites : les autres sont rétablies.
  stack = stackOf('a', 'b', 'c');
  stack.toggleDesktop();
  stack.remove('c');
  assert.equal(stack.desktopShown, true);
  assert.deepEqual(stack.toggleDesktop(), { action: 'show', ids: ['a', 'b'] });
  assert.equal(stack.active, 'b', 'la fenêtre active d’avant a été fermée : celle du dessus la remplace');

  // Toutes fermées : plus rien à rétablir.
  stack = stackOf('a');
  stack.toggleDesktop();
  stack.remove('a');
  assert.equal(stack.desktopShown, false);
  assert.deepEqual(stack.toggleDesktop(), { action: 'none', ids: [] });
});

test('afficher le bureau sans fenêtre active : rétablies, aucune ne s’impose devant les autres', () => {
  const stack = stackOf('a', 'b');
  stack.deactivate();
  stack.toggleDesktop();
  assert.deepEqual(stack.toggleDesktop(), { action: 'show', ids: ['a', 'b'] });
  assert.equal(stack.active, 'b', 'la fenêtre du dessus reçoit le clavier');
  assert.deepEqual(stack.order, ['a', 'b']);
});

test('l’état reste cohérent après une longue suite d’opérations', () => {
  const stack = new WindowStack();
  const ids = Array.from({ length: 12 }, (_, index) => `w${index}`);
  let seed = 7;
  const random = (max) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % max;
  };
  const open = new Set();
  for (let step = 0; step < 4000; step += 1) {
    const id = ids[random(ids.length)];
    const action = random(6);
    if (action === 0 && !open.has(id)) {
      stack.add(id);
      stack.activate(id);
      open.add(id);
    } else if (action === 1 && open.has(id)) {
      stack.remove(id);
      open.delete(id);
    } else if (action === 2) stack.activate(id);
    else if (action === 3) stack.minimize(id);
    else if (action === 4) stack.toggleDesktop();
    else stack.deactivate();

    // Les deux ordres contiennent exactement les fenêtres ouvertes, une fois chacune.
    assert.deepEqual([...stack.order].sort(), [...open].sort());
    assert.deepEqual([...stack.recent].sort(), [...open].sort());
    assert.equal(stack.size, open.size);
    // La fenêtre active est ouverte, visible, et au premier plan.
    if (stack.active !== null) {
      assert.ok(open.has(stack.active));
      assert.equal(stack.isMinimized(stack.active), false);
      assert.equal(stack.top(), stack.active);
      assert.equal(stack.order.at(-1), stack.active);
    }
    // Une fenêtre fermée n'est plus réduite, ni désignée par la bascule.
    for (const other of ids) if (!open.has(other)) assert.equal(stack.isMinimized(other), false);
    const pointed = stack.cycle(1);
    assert.ok(pointed === null ? open.size === 0 : open.has(pointed));
  }
});

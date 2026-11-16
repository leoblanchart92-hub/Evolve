'use strict';

/**
 * Evolve — Auto-test : le bureau et les fenêtres.
 *
 * Après les contrôles de l'explorateur, une fenêtre de l'explorateur est
 * ouverte. L'auto-test agit alors sur le bureau comme le ferait
 * l'utilisateur, et constate à chaque fois l'état de la page : position et
 * taille des fenêtres, fenêtre active, élément qui détient le clavier, témoin
 * de la barre des tâches.
 *
 *   - à la souris — de vrais gestes, injectés dans le moteur d'affichage (voir
 *     selftest-input.js) : déplacer une fenêtre par sa barre de titre,
 *     l'abandonner avec Échap, la redimensionner par un coin jusqu'à sa taille
 *     minimale, l'agrandir d'un double-clic, l'ancrer en la glissant contre un
 *     bord de l'écran, activer une fenêtre d'arrière-plan d'un clic ;
 *   - au clavier — de vraies touches : Ctrl + N, Ctrl + Tab, Ctrl + W,
 *     Alt + Maj + Bas, F6 puis les flèches et Entrée sur le bureau,
 *     Ctrl + Espace puis les flèches dans le menu Démarrer, et Tab, qui ne doit
 *     jamais quitter la fenêtre active ;
 *   - par les commandes de l'interface : menu de la fenêtre, liste des
 *     fenêtres dans la barre des tâches, réduction, « Afficher le bureau »,
 *     icônes du bureau, application seulement annoncée (qui ne doit rien
 *     ouvrir), nombre maximal de fenêtres.
 *
 * Si la page ne reçoit pas les gestes injectés (fenêtre restée en
 * arrière-plan sur la machine de compilation), les contrôles qui en dépendent
 * ne sont pas menés : un avertissement le dit, et ils ne comptent pas comme
 * réussis. Les autres le sont toujours.
 *
 * À la fin, toutes les fenêtres sont fermées.
 */

/** Nombre maximal de fenêtres ouvertes à la fois (voir MAX_WINDOWS, src/renderer/js/wm/window-manager.js). */
const MAX_WINDOWS = 12;

/** Commandes du menu d'une fenêtre, dans l'ordre. */
const WINDOW_MENU = Object.freeze(['Restaurer', 'Réduire', 'Agrandir', 'Ancrer à gauche', 'Ancrer à droite', 'Fermer']);

/** Intitulés des contrôles, dans l'ordre du scénario. */
const CHECKS = Object.freeze({
  resize: "une fenêtre se redimensionne par un coin, à la souris, s'arrête à sa taille minimale, puis s'agrandit de nouveau",
  drag: 'une fenêtre se déplace par sa barre de titre, à la souris, de la distance exacte du geste',
  escape: 'Échap pendant un déplacement remet la fenêtre exactement où elle était',
  doubleClick: "un double-clic sur la barre de titre agrandit la fenêtre sur toute la zone de travail ; un second lui rend sa place à l'identique",
  snapDrag: "glissée contre le bord gauche, la fenêtre annonce puis occupe la moitié gauche de l'écran ; glissée ailleurs, elle retrouve sa taille",
  menu: "le menu de la fenêtre (clic droit sur sa barre de titre) propose de la restaurer, la réduire, l'agrandir, l'ancrer ou la fermer ; « Ancrer à droite » l'ancre, puis elle est restaurée",
  second: "une seconde fenêtre de l'explorateur s'ouvre devant la première, décalée, et reçoit le clavier",
  taskbar: 'la barre des tâches indique deux fenêtres ; un clic en propose la liste, et la fenêtre choisie passe au premier plan',
  switcher: "Ctrl + Tab présente les fenêtres ouvertes et active l'autre fenêtre quand Ctrl est relâché ; Échap y renonce sans rien changer",
  sideBySide: "deux fenêtres ancrées, l'une à gauche, l'autre à droite, se partagent la zone de travail sans se recouvrir",
  click: "un clic, à la souris, dans la fenêtre qui n'est pas active la rend active et la place au premier plan",
  minimize: "réduire la fenêtre active rend le clavier à l'autre fenêtre ; la barre des tâches la rétablit",
  showDesktop: '« Afficher le bureau » réduit toutes les fenêtres ; le même bouton les rétablit, dans le même ordre',
  tab: 'la touche Tab parcourt la fenêtre active sans jamais en sortir',
  close: "fermer la fenêtre active la retire et rend le clavier à l'autre fenêtre",
  icon: "une icône du bureau ouvre son emplacement dans une nouvelle fenêtre ; l'ouvrir de nouveau réactive cette fenêtre, sans la doubler",
  desktopKeys: "au clavier : F6 mène au bureau, les flèches, Début et Fin d'une icône à l'autre, Entrée ouvre l'icône",
  startKeys: "Ctrl + Espace ouvre le menu Démarrer, les flèches y mènent d'une application à l'autre, Échap le ferme et rend le clavier à la fenêtre",
  launch: "le menu Démarrer lance l'explorateur : sa fenêtre reçoit le clavier",
  upcoming: "une application seulement annoncée n'ouvre aucune fenêtre : le menu Démarrer le signale",
  limit: `au-delà de ${MAX_WINDOWS} fenêtres, une ouverture de plus est refusée et signalée`,
  closeAll: "toutes les fenêtres se ferment depuis la barre des tâches, qui n'en indique plus aucune",
});

/** Outils exécutés dans la page : état des fenêtres, du clavier, de la barre des tâches et des menus. */
const DESKTOP_TOOLS = `
  const dRect = (el) => { const box = el.getBoundingClientRect(); return { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) }; };
  const dWins = () => [...document.querySelectorAll('.window:not(.is-closing)')];
  const dWin = (id) => dWins().find((el) => el.dataset.window === id) ?? null;
  const dActive = () => document.querySelector('.window.is-focused:not(.is-closing)');
  const dInfo = (el) => (el ? { id: el.dataset.window, titre: el.getAttribute('aria-label'), active: el.classList.contains('is-focused'), reduite: el.hidden,
    agrandie: el.classList.contains('is-maximized'), ancree: el.dataset.snap ?? null, rang: Number(el.style.zIndex),
    page: el.querySelector('.ex-content')?.dataset.page ?? null, dossier: el.querySelector('.ex-content')?.dataset.path ?? null, ...dRect(el) } : null);
  const dArea = () => dRect(document.getElementById('windows'));
  /** Vrai quand la fenêtre est au repos : ni geste en cours, ni transition de sa géométrie. Sa position se lit alors telle qu'elle est. */
  const dIdle = (el) => Boolean(el) && !['is-dragging', 'is-resizing', 'is-morphing'].some((name) => el.classList.contains(name))
    && el.getAnimations().every((animation) => animation.effect?.target !== el || animation.playState !== 'running');
  const dKeyboard = () => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'aucun';
    const win = el.closest('.window');
    if (win) return 'fenêtre ' + win.dataset.window;
    if (el.closest('#taskbar')) return 'barre des tâches';
    if (el.closest('#desktop')) return 'bureau ' + (el.dataset.id ?? '');
    if (el.closest('.start')) return 'menu Démarrer ' + (el.dataset.app ?? el.dataset.place ?? el.tagName.toLowerCase());
    return el.tagName.toLowerCase();
  };
  const dInside = (id) => dKeyboard() === 'fenêtre ' + id;
  const dButton = () => document.querySelector('.tb-app[data-app="explorer"]');
  const dMenuItems = () => [...document.querySelectorAll('#menus .menu:not(.is-closing) .menu__item')];
  const dMenu = () => (document.querySelector('#menus .menu:not(.is-closing)') ? dMenuItems().map((item) => item.querySelector('.menu__label').textContent) : null);
  const dMenuPick = (label, rank = 0) => {
    const item = dMenuItems().filter((el) => el.querySelector('.menu__label').textContent === label)[rank];
    if (item) item.click();
    return Boolean(item);
  };
  const dToasts = () => [...document.querySelectorAll('.toast:not(.is-leaving) .toast__title')].map((el) => el.textContent);
  const dStart = () => document.querySelector('.start').classList.contains('is-open');
  const dState = () => ({ fenetres: dWins().map(dInfo), clavier: dKeyboard(), barre: dButton() ? { fenetres: dButton().dataset.windows, active: dButton().classList.contains('is-active') } : null,
    menu: dMenu(), notifications: dToasts(), demarrer: dStart(), zone: dArea() });
  const near = (a, b, tolerance = 2) => Math.abs(a - b) <= tolerance;
  const sameRect = (a, b, tolerance = 2) => Boolean(a && b) && near(a.x, b.x, tolerance) && near(a.y, b.y, tolerance) && near(a.w, b.w, tolerance) && near(a.h, b.h, tolerance);
  const dContext = (el) => { const box = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 })); };
  const dNewWindow = () => dButton().dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
`;

const js = (value) => JSON.stringify(value);
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * Contrôles du bureau et des fenêtres.
 * @param {object} tools  outils de l'auto-test (voir selftest.js) : `evaluate`, `until`, `record`, `capture`, `report`
 * @param {object} context
 * @param {ReturnType<import('./selftest-input').createInput>} context.input  gestes de la souris et du clavier
 * @param {number} [context.maxWindows]  nombre maximal de fenêtres de l'interface
 */
async function checkDesktop({ evaluate, until, record, capture, report }, { input, maxWindows = MAX_WINDOWS }) {
  const T = DESKTOP_TOOLS;
  /** Valeur d'une expression de page, ou `null` si elle ne peut pas être lue. */
  const read = async (expression) => {
    try {
      return await evaluate(`${T} return (${expression});`);
    } catch {
      return null;
    }
  };
  /** Geste mené par programme dans la page. */
  const run = async (code) => {
    try {
      await evaluate(`${T} ${code}`);
      return true;
    } catch (error) {
      report.errors.push(`geste impossible sur le bureau : ${error?.message}`);
      return false;
    }
  };
  /**
   * Attend l'état décrit par `expression` ; renvoie `true`, ou ce qui est
   * observé — avec le constat de l'expression elle-même, si elle en rend un.
   */
  const expect = (expression) => until(`${T} const seen = (${expression}); return seen === true || (seen && typeof seen === 'object' ? { constat: seen, ...dState() } : dState());`);
  /**
   * Enchaîne des attentes — `[intitulé, geste, état attendu, valeur attendue]` : `true` si toutes
   * aboutissent, sinon l'étape en défaut, ce qui était attendu (s'il est donné) et ce qui est observé.
   */
  const all = async (steps) => {
    for (const [label, action, expression, wanted] of steps) {
      if (action) await action();
      const seen = await expect(expression);
      if (seen !== true) return { etape: label, ...(wanted === undefined ? {} : { attendu: wanted }), obtenu: seen ?? null };
    }
    return true;
  };
  /** État d'une fenêtre, relevé une fois qu'elle est au repos (geste terminé, transition achevée). */
  const info = async (id) => {
    await until(`${T} return dIdle(dWin(${js(id)}));`);
    return read(`dInfo(dWin(${js(id)}))`);
  };
  /** Point de la barre de titre par lequel saisir la fenêtre : ni son icône, ni ses boutons. */
  const grip = (rect) => ({ x: number(rect?.x) + Math.min(number(rect?.w) * 0.4, 260), y: number(rect?.y) + 14 });
  const rectCode = (rect) => js({ x: number(rect?.x), y: number(rect?.y), w: number(rect?.w), h: number(rect?.h) });

  // --- Ce que la page reçoit réellement ---------------------------------------------------
  const available = await input.prepare();
  const mouse = available.mouse === true;
  const keyboard = available.keyboard === true;
  report.input = { souris: mouse, clavier: keyboard, pageActive: available.focused === true };
  if (!mouse) report.warnings.push("gestes à la souris non vérifiés (déplacement, redimensionnement, ancrage, double-clic) : la fenêtre de l'application ne reçoit pas la souris injectée");
  if (!keyboard) report.warnings.push("raccourcis clavier non vérifiés (Ctrl + Tab, Ctrl + N, Ctrl + W, F6, flèches, Tab) : la fenêtre de l'application ne reçoit pas le clavier injecté");

  // Les notifications s'affichent en bas à droite, par-dessus les fenêtres : comme le ferait l'utilisateur
  // avant de saisir le coin d'une fenêtre, l'auto-test les ferme par leur bouton.
  const closeToasts = async () => {
    await run(`document.querySelectorAll('.toast:not(.is-leaving) .toast__close').forEach((button) => button.click());`);
    await until(`return document.querySelectorAll('.toast').length === 0;`);
  };
  await closeToasts();

  const area = await read('dArea()');
  const first = await read('(dActive() ?? dWins()[0])?.dataset.window ?? null');
  const left = { x: 0, y: 0, w: Math.floor(number(area?.w) / 2), h: number(area?.h) };
  const right = { x: left.w, y: 0, w: number(area?.w) - left.w, h: number(area?.h) };
  const whole = { x: 0, y: 0, w: number(area?.w), h: number(area?.h) };

  // --- Une fenêtre, à la souris -------------------------------------------------------------
  if (mouse) {
    const corner = (rect) => ({ x: number(rect?.x) + number(rect?.w) - 2, y: number(rect?.y) + number(rect?.h) - 2 });
    /** Glisse le coin inférieur droit de la fenêtre, de (`dx`, `dy`) ou jusqu'au point `to`. */
    const resizeBy = async (dx, dy, to = null) => {
      const rect = await info(first);
      await input.drag(corner(rect), to ?? { x: corner(rect).x + dx, y: corner(rect).y + dy });
    };
    const still = `!dWin(${js(first)}).classList.contains('is-resizing') && !dWin(${js(first)}).classList.contains('is-dragging')`;

    // 1. Redimensionnement par le coin inférieur droit : plus petite, jusqu'à la taille minimale, puis plus grande.
    //    (D'abord : la fenêtre, ouverte entière dans la zone de travail, a son coin à portée du pointeur.)
    let before = await info(first);
    await resizeBy(-80, -60);
    const smaller = { ...before, w: number(before?.w) - 80, h: number(before?.h) - 60 };
    let resized = await expect(`sameRect(dRect(dWin(${js(first)})), ${rectCode(smaller)}) && ${still}`);
    if (resized !== true) resized = { etape: 'réduite de 80 sur 60', attendu: smaller, obtenu: resized };
    else {
      // Le coin ramené sur le coin opposé : la taille s'arrête à un minimum, que le même geste ne franchit pas.
      await resizeBy(0, 0, { x: number(before?.x) + 2, y: number(before?.y) + 2 });
      await expect(`dRect(dWin(${js(first)})).w < ${number(smaller.w) - 20} && ${still}`);
      const smallest = await info(first);
      await resizeBy(0, 0, { x: number(before?.x) + 2, y: number(before?.y) + 2 });
      resized = await expect(
        `sameRect(dRect(dWin(${js(first)})), ${rectCode(smallest)}, 0) && ${still} && ${number(smallest?.w)} >= 200 && ${number(smallest?.h)} >= 150
           && ${number(smallest?.w)} < ${number(smaller.w)} && ${number(smallest?.h)} < ${number(smaller.h)}
           && ${number(smallest?.x)} === ${number(before?.x)} && ${number(smallest?.y)} === ${number(before?.y)}`,
      );
      if (resized !== true) resized = { etape: 'taille minimale', 'avant le second geste': smallest, obtenu: resized };
      else {
        await resizeBy(240, 120);
        const larger = { ...smallest, w: number(smallest?.w) + 240, h: number(smallest?.h) + 120 };
        resized = await expect(`sameRect(dRect(dWin(${js(first)})), ${rectCode(larger)}) && ${still}`);
        if (resized !== true) resized = { etape: 'agrandie de 240 sur 120', attendu: larger, obtenu: resized };
      }
    }
    record(CHECKS.resize, resized);

    // 2. Déplacement par la barre de titre, de 80 points sur 40 — du côté où la fenêtre reste entière à l'écran.
    before = await info(first);
    const dx = number(before?.x) + number(before?.w) + 80 <= number(area?.w) ? 80 : -80;
    const dy = number(before?.y) + number(before?.h) + 40 <= number(area?.h) ? 40 : 0;
    const moved = { ...before, x: number(before?.x) + dx, y: number(before?.y) + dy };
    await input.drag(grip(before), { x: grip(before).x + dx, y: grip(before).y + dy });
    const dragged = await expect(`sameRect(dRect(dWin(${js(first)})), ${rectCode(moved)}, 0) && ${still}`);
    record(CHECKS.drag, dragged === true || { attendu: moved, obtenu: dragged });

    // 3. Échap pendant un déplacement : la fenêtre revient à sa place ; relâcher le bouton ensuite ne change rien.
    if (keyboard) {
      before = await info(first);
      const away = { x: grip(before).x + 150, y: grip(before).y + 90 };
      await input.press(grip(before), away);
      const abandoned = await all([
        ['la fenêtre suit le pointeur', null, `sameRect(dRect(dWin(${js(first)})), ${rectCode({ ...before, x: number(before?.x) + 150, y: number(before?.y) + 90 })}) && dWin(${js(first)}).classList.contains('is-dragging')`],
        ['Échap la remet en place', () => input.key('Escape'), `sameRect(dRect(dWin(${js(first)})), ${rectCode(before)}, 0) && ${still}`, before],
        ['le bouton relâché ne la déplace plus', () => input.release(away), `sameRect(dRect(dWin(${js(first)})), ${rectCode(before)}, 0) && !document.body.classList.contains('is-window-dragging')`, before],
      ]);
      record(CHECKS.escape, abandoned);
    }

    // 4. Double-clic sur la barre de titre : agrandie, puis restaurée à l'identique.
    before = await info(first);
    const twice = await all([
      ['agrandie', () => input.click(grip(before).x, grip(before).y, { count: 2 }), `dWin(${js(first)}).classList.contains('is-maximized') && sameRect(dRect(dWin(${js(first)})), ${rectCode(whole)})`, whole],
      ['restaurée', () => input.click(grip(whole).x, grip(whole).y, { count: 2 }), `!dWin(${js(first)}).classList.contains('is-maximized') && sameRect(dRect(dWin(${js(first)})), ${rectCode(before)})`, before],
    ]);
    record(CHECKS.doubleClick, twice);

    // 5. Ancrage : glissée contre le bord gauche, la moitié gauche est annoncée, puis occupée ; glissée ailleurs, la taille revient.
    before = await info(first);
    const edge = { x: 3, y: Math.min(grip(before).y + 120, number(area?.h) - 24) };
    const centre = { x: Math.round(number(area?.w) / 2), y: 160 };
    await input.press(grip(before), edge, { steps: 12 });
    const snapped = await all([
      ['aperçu de la moitié gauche pendant le geste', null, `(() => { const preview = document.querySelector('.snap-preview'); return !preview.hidden && preview.classList.contains('is-visible') && sameRect(dRect(preview), ${rectCode(left)}, 3); })()`, left],
      ['ancrée à gauche au relâchement', () => input.release(edge), `dWin(${js(first)}).dataset.snap === 'left' && sameRect(dRect(dWin(${js(first)})), ${rectCode(left)}) && document.querySelector('.snap-preview').hidden`, left],
      [
        'taille retrouvée en la glissant ailleurs',
        () => input.drag(grip(left), centre, { steps: 12 }),
        `(() => { const rect = dRect(dWin(${js(first)})); return !dWin(${js(first)}).dataset.snap && ${still} && rect.w === ${number(before?.w)} && rect.h === ${number(before?.h)} && rect.y === ${centre.y - 14} && rect.x > 12 && rect.x < ${centre.x}; })()`,
        { w: number(before?.w), h: number(before?.h), y: centre.y - 14 },
      ],
    ]);
    record(CHECKS.snapDrag, snapped);
  }

  // --- Menu de la fenêtre -------------------------------------------------------------------
  const before = await info(first);
  const viaMenu = await all([
    ['le menu propose les commandes de la fenêtre', () => run(`dContext(dWin(${js(first)}).querySelector('.window__title-text'));`), `JSON.stringify(dMenu()) === ${js(js(WINDOW_MENU))}`],
    ['« Ancrer à droite »', () => run(`dMenuPick('Ancrer à droite');`), `dWin(${js(first)}).dataset.snap === 'right' && sameRect(dRect(dWin(${js(first)})), ${rectCode(right)}) && dMenu() === null`],
    // Au clavier : Alt + Maj + Bas ; à défaut, la commande « Restaurer » du même menu.
    [
      'restaurée',
      keyboard
        ? () => input.chord('Down', ['alt', 'shift'])
        : async () => {
            await run(`dContext(dWin(${js(first)}).querySelector('.window__title-text'));`);
            await expect('dMenu() !== null');
            await run(`dMenuPick('Restaurer');`);
          },
      `!dWin(${js(first)}).dataset.snap && sameRect(dRect(dWin(${js(first)})), ${rectCode(before)})`,
      before,
    ],
  ]);
  record(CHECKS.menu, viaMenu);

  // --- Deux fenêtres ------------------------------------------------------------------------
  // Ctrl + N, dans la fenêtre active : une fenêtre de plus, au même emplacement. À défaut : clic du milieu sur la barre des tâches.
  if (keyboard) {
    await run(`dWin(${js(first)}).querySelector('.ex-content').focus();`);
    await input.chord('N', ['control']);
  } else {
    await run('dNewWindow();');
  }
  await expect('dWins().length === 2');
  const second = await read(`dWins().find((el) => el.dataset.window !== ${js(first)})?.dataset.window ?? null`);
  record(
    CHECKS.second,
    await expect(
      `(() => { const [a, b] = [dInfo(dWin(${js(first)})), dInfo(dWin(${js(second)}))];
         return dWins().length === 2 && b.active && !a.active && b.rang > a.rang && (b.x !== a.x || b.y !== a.y) && near(b.w, a.w) && near(b.h, a.h) && dInside(${js(second)})
           ${keyboard ? '&& b.page === a.page && b.dossier === a.dossier' : ''}; })()`,
    ),
  );
  await capture('09-fenetres');

  // La barre des tâches : deux fenêtres ; un clic en propose la liste ; la première choisie passe devant.
  const titles = await read(`[${js(first)}, ${js(second)}].map((id) => dWin(id).getAttribute('aria-label'))`);
  const picked = await all([
    ['témoin de deux fenêtres', null, `dButton().dataset.windows === '2' && dButton().classList.contains('is-multiple') && dButton().classList.contains('is-active')`],
    ['la liste des fenêtres', () => run('dButton().click();'), `JSON.stringify(dMenu()) === ${js(js(Array.isArray(titles) ? titles : []))}`],
    ['la fenêtre choisie passe au premier plan', () => run(`dMenuPick(${js(Array.isArray(titles) ? titles[0] : '')}, 0);`), `dWin(${js(first)}).classList.contains('is-focused') && dInfo(dWin(${js(first)})).rang > dInfo(dWin(${js(second)})).rang && dInside(${js(first)}) && dMenu() === null`],
  ]);
  record(CHECKS.taskbar, picked);

  if (keyboard) {
    // Ctrl + Tab : le panneau présente les deux fenêtres et désigne l'autre ; Ctrl relâché, elle est active.
    await input.keyDown('Control', ['control']);
    await input.keyDown('Tab', ['control']);
    const shown = await expect(
      `(() => { const items = [...document.querySelectorAll('.switcher:not(.is-closing) .switcher__item')];
         return items.length === 2 && items.filter((item) => item.classList.contains('is-selected')).map((item) => item.dataset.window).join() === ${js(second)}; })()`,
    );
    if (shown === true) await capture('10-bascule-fenetres');
    await input.keyUp('Tab', ['control']);
    await input.keyUp('Control');
    let switched = shown === true ? await expect(`!document.querySelector('.switcher:not(.is-closing)') && dWin(${js(second)}).classList.contains('is-focused') && dInside(${js(second)})`) : shown;
    if (switched === true) {
      // De nouveau, puis Échap : rien ne change.
      await input.keyDown('Control', ['control']);
      await input.key('Tab', ['control']);
      switched = await all([
        ['le panneau se rouvre', null, `document.querySelectorAll('.switcher:not(.is-closing) .switcher__item.is-selected').length === 1`],
        ['Échap y renonce', () => input.key('Escape', ['control']), `!document.querySelector('.switcher:not(.is-closing)') && dWin(${js(second)}).classList.contains('is-focused')`],
      ]);
      await input.keyUp('Control');
      if (switched === true) switched = await expect(`dWin(${js(second)}).classList.contains('is-focused') && dInside(${js(second)}) && dWins().length === 2`);
    }
    record(CHECKS.switcher, switched);
  }

  // Côte à côte : la première ancrée à gauche, la seconde à droite, par le menu de chacune.
  const snapBy = (id, label) => async () => {
    await run(`dContext(dWin(${js(id)}).querySelector('.window__title-text'));`);
    await expect(`dMenu() !== null && dMenu().includes(${js(label)})`);
    await run(`dMenuPick(${js(label)});`);
  };
  const sideBySide = await all([
    ['la première à gauche', snapBy(first, 'Ancrer à gauche'), `dWin(${js(first)}).dataset.snap === 'left' && sameRect(dRect(dWin(${js(first)})), ${rectCode(left)})`, left],
    [
      'la seconde à droite : elles se touchent sans se recouvrir',
      snapBy(second, 'Ancrer à droite'),
      `(() => { const [a, b] = [dRect(dWin(${js(first)})), dRect(dWin(${js(second)}))];
         return dWin(${js(second)}).dataset.snap === 'right' && sameRect(b, ${rectCode(right)}) && sameRect(a, ${rectCode(left)}) && a.x + a.w === b.x && a.w + b.w === ${number(area?.w)}
           && dWin(${js(second)}).classList.contains('is-focused') && dMenu() === null; })()`,
      right,
    ],
  ]);
  record(CHECKS.sideBySide, sideBySide);

  if (mouse) {
    // Un vrai clic sur la barre de titre de la fenêtre qui n'est pas active (la première, à gauche).
    const behind = await info(first);
    await input.click(number(behind?.x) + number(behind?.w) / 2, number(behind?.y) + 14);
    record(
      CHECKS.click,
      await expect(
        `dWin(${js(first)}).classList.contains('is-focused') && !dWin(${js(second)}).classList.contains('is-focused')
           && dInfo(dWin(${js(first)})).rang > dInfo(dWin(${js(second)})).rang && dWin(${js(first)}).dataset.snap === 'left' && dButton().classList.contains('is-active')`,
      ),
    );
  }

  // Réduire la fenêtre active : l'autre reçoit le clavier ; la barre des tâches la rétablit.
  const front = await read('dActive()?.dataset.window ?? null');
  const other = front === first ? second : first;
  const frontRank = front === first ? 0 : 1;
  const reduced = await all([
    ['réduite, le clavier passe à l’autre fenêtre', () => run(`dWin(${js(front)}).querySelector('.window__control--min').click();`), `dWin(${js(front)}).hidden && dWin(${js(other)}).classList.contains('is-focused') && dInside(${js(other)}) && dButton().dataset.windows === '2'`],
    ['proposée par la barre des tâches', () => run('dButton().click();'), 'dMenu() !== null && dMenu().length === 2'],
    ['rétablie et active', () => run(`dMenuItems()[${frontRank}].click();`), `!dWin(${js(front)}).hidden && dWin(${js(front)}).classList.contains('is-focused') && dInside(${js(front)})`],
  ]);
  record(CHECKS.minimize, reduced);

  // « Afficher le bureau » : tout est réduit ; le même bouton rétablit tout, la même fenêtre devant.
  const peeked = await all([
    ['toutes les fenêtres réduites', () => run(`document.querySelector('.tb-desktop').click();`), `dWins().every((el) => el.hidden) && dActive() === null && document.querySelector('.tb-desktop').getAttribute('aria-pressed') === 'true' && !dKeyboard().startsWith('fenêtre')`],
    [
      'toutes rétablies, dans le même ordre',
      () => run(`document.querySelector('.tb-desktop').click();`),
      `dWins().every((el) => !el.hidden) && dWin(${js(front)}).classList.contains('is-focused') && dInfo(dWin(${js(front)})).rang > dInfo(dWin(${js(other)})).rang
         && document.querySelector('.tb-desktop').getAttribute('aria-pressed') === 'false' && dInside(${js(front)})`,
    ],
  ]);
  record(CHECKS.showDesktop, peeked);

  if (keyboard) {
    // Tab, autant de fois que la fenêtre a d'éléments, et quelques-unes de plus, puis Maj + Tab : après
    // chaque pression, l'élément qui détient le clavier est relevé. Il change, et ne sort jamais de la fenêtre.
    const stops = await read(
      `(() => { const el = dWin(${js(front)});
         el.querySelector('.ex-content').focus();
         window.__evolveStops = [...el.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].filter((node) => node.tabIndex >= 0 && !node.disabled && node.getClientRects().length > 0);
         return window.__evolveStops.length; })()`,
    );
    const presses = Math.min(Math.max(number(stops), 4) + 4, 160);
    const where = `(() => { const el = document.activeElement; const inside = Boolean(el) && dWin(${js(front)}).contains(el); return { lieu: inside ? 'dedans' : dKeyboard(), rang: window.__evolveStops.indexOf(el) }; })()`;
    const trail = [];
    for (let count = 0; count < presses; count += 1) {
      await input.key('Tab');
      trail.push(await read(where));
    }
    const forward = trail.map((entry) => entry?.rang);
    for (let count = 0; count < 6; count += 1) {
      await input.key('Tab', ['shift']);
      trail.push(await read(where));
    }
    const outside = trail.filter((entry) => entry?.lieu !== 'dedans').map((entry) => entry?.lieu ?? 'illisible');
    const visited = new Set(forward.filter((rank) => Number.isInteger(rank) && rank >= 0));
    // Passé le dernier élément de la fenêtre, Tab reprend au premier : le rang retombe du plus grand au plus petit.
    const wrapped = forward.some((rank, index) => index > 0 && rank === Math.min(...visited) && forward[index - 1] === Math.max(...visited));
    // Maj + Tab revient en arrière : chaque pression ramène à l'élément que Tab avait quitté, dans l'ordre inverse de l'aller.
    const backward = trail.slice(presses).map((entry) => entry?.rang);
    const back = backward.length === 6 && backward.every((rank, index) => Number.isInteger(rank) && rank >= 0 && rank === forward[presses - 2 - index]);
    record(
      CHECKS.tab,
      (outside.length === 0 && visited.size >= 3 && wrapped && back) || {
        elements: stops,
        visites: visited.size,
        'retour au premier': wrapped,
        'retour en arrière': back,
        'hors de la fenêtre': [...new Set(outside)],
        parcours: trail.map((entry) => entry?.rang).join(' '),
      },
    );
  }

  // Fermer la fenêtre active : Ctrl + W ; à défaut, son bouton de fermeture.
  if (keyboard) await input.chord('W', ['control']);
  else await run(`dWin(${js(front)}).querySelector('.window__control--close').click();`);
  record(CHECKS.close, await expect(`dWins().length === 1 && dWin(${js(front)}) === null && dWin(${js(other)}).classList.contains('is-focused') && dInside(${js(other)}) && dButton().dataset.windows === '1'`));

  // --- Bureau ---------------------------------------------------------------------------------
  // La fenêtre restante affiche « Ce PC ». Double-clic sur « Documents » : une nouvelle fenêtre ;
  // de nouveau, depuis l'autre fenêtre : la même, réactivée.
  const open = `document.querySelector('.desktop-icon[data-id="documents"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));`;
  const documentsShown = `dWins().length === 2 && dActive() !== null && dActive().dataset.window !== ${js(other)} && dInfo(dActive()).page === 'folder' && dInfo(dActive()).titre.startsWith('Documents') && dInside(dActive().dataset.window)`;
  const viaIcon = await all([
    ['la fenêtre restante affiche « Ce PC »', null, `dWins().length === 1 && dInfo(dWin(${js(other)})).page === 'pc'`],
    ['une nouvelle fenêtre sur « Documents »', () => run(open), documentsShown],
    ['l’autre fenêtre repasse devant', () => run(`dWin(${js(other)}).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));`), `dWin(${js(other)}).classList.contains('is-focused')`],
    ['« Documents » de nouveau : sa fenêtre est réactivée, sans en ouvrir une autre', () => run(open), documentsShown],
  ]);
  record(CHECKS.icon, viaIcon);

  if (keyboard) {
    // F6 (trois fois au plus : fenêtre, barre des tâches, bureau) mène au bureau ; Début, Fin et les flèches
    // mènent d'une icône à l'autre ; Entrée ouvre « Ce PC », que l'autre fenêtre affiche : elle repasse devant.
    let onDesktop = false;
    for (let count = 0; count < 3 && onDesktop !== true; count += 1) {
      await input.key('F6');
      onDesktop = await until(`${T} return dKeyboard().startsWith('bureau ');`, { timeout: 800 });
    }
    const icons = await read(`[...document.querySelectorAll('.desktop-icon')].map((icon) => icon.dataset.id)`);
    const [firstIcon, secondIcon] = Array.isArray(icons) ? icons : [];
    const lastIcon = Array.isArray(icons) ? icons.at(-1) : null;
    const onIcon = (id) => `dKeyboard() === ${js(`bureau ${id}`)} && document.querySelector('.desktop-icon.is-selected')?.dataset.id === ${js(id)}`;
    const viaKeys = await all([
      ['F6 mène à une icône du bureau, plus aucune fenêtre n’est active', null, `dKeyboard().startsWith('bureau ') && dActive() === null && dWins().length === 2`],
      ['Début : première icône', () => input.key('Home'), `${js(firstIcon)} === 'this-pc' && ${onIcon(firstIcon)}`],
      ['flèche bas : icône suivante', () => input.key('Down'), onIcon(secondIcon)],
      ['Fin : dernière icône', () => input.key('End'), onIcon(lastIcon)],
      ['flèche haut : icône précédente', () => input.key('Up'), onIcon(Array.isArray(icons) ? icons.at(-2) : null)],
      ['Début, puis Entrée : la fenêtre qui affiche « Ce PC » repasse devant et reçoit le clavier', async () => { await input.key('Home'); await input.key('Enter'); }, `dWins().length === 2 && dWin(${js(other)}).classList.contains('is-focused') && dInfo(dWin(${js(other)})).page === 'pc' && dInside(${js(other)})`],
    ]);
    record(CHECKS.desktopKeys, viaKeys);

    // Ctrl + Espace : menu Démarrer ; flèches : d'une application à l'autre ; Échap : fermé, clavier rendu.
    const holder = await read('dActive()?.dataset.window ?? null');
    const viaStart = await all([
      ['Ctrl + Espace ouvre le menu', () => input.chord('Space', ['control']), `dStart() && dKeyboard().startsWith('menu Démarrer')`],
      ['flèche bas : première application', () => input.key('Down'), `dKeyboard() === 'menu Démarrer explorer'`],
      ['flèche droite : application suivante', () => input.key('Right'), `dKeyboard().startsWith('menu Démarrer ') && dKeyboard() !== 'menu Démarrer explorer' && document.activeElement.classList.contains('is-upcoming')`],
      ['flèche gauche : retour', () => input.key('Left'), `dKeyboard() === 'menu Démarrer explorer'`],
      ['Échap ferme le menu et rend le clavier à la fenêtre', () => input.key('Escape'), `!dStart() && dInside(${js(holder)}) && dWin(${js(holder)}).classList.contains('is-focused')`],
    ]);
    record(CHECKS.startKeys, viaStart);
  }

  // --- Menu Démarrer : application disponible, application seulement annoncée ----------------------
  const count = await read('dWins().length');
  const launched = await all([
    ['le menu s’ouvre', () => run(`document.querySelector('.tb-start').click();`), `dStart() && document.querySelectorAll('.start-app:not(.is-upcoming)').length >= 1`],
    ['l’explorateur est lancé : sa fenêtre reçoit le clavier', () => run(`document.querySelector('.start-app[data-app="explorer"]').click();`), `!dStart() && dWins().length === ${number(count)} && dActive() !== null && dActive().dataset.app === 'explorer' && dInside(dActive().dataset.window)`],
  ]);
  record(CHECKS.launch, launched);

  const upcoming = await all([
    ['le menu s’ouvre', () => run(`document.querySelector('.tb-start').click();`), `dStart() && document.querySelectorAll('.start-app.is-upcoming[aria-disabled="true"]').length >= 1`],
    ['rien ne s’ouvre, et le menu le dit', () => run(`document.querySelector('.start-app.is-upcoming').click();`), `dStart() && dWins().length === ${number(count)} && dToasts().some((title) => title.endsWith('bientôt disponible')) && document.querySelectorAll('.window').length === ${number(count)}`],
    ['le menu se ferme', () => run(`document.querySelector('.tb-start').click();`), '!dStart()'],
  ]);
  record(CHECKS.upcoming, upcoming);

  // --- Nombre maximal de fenêtres -------------------------------------------------------------------
  let filled = true;
  for (let total = number(count) + 1; total <= maxWindows && filled === true; total += 1) {
    await run('dNewWindow();');
    filled = await expect(`dWins().length === ${total}`);
  }
  if (filled === true) {
    await run('dNewWindow();');
    filled = await expect(`dWins().length === ${maxWindows} && document.querySelectorAll('.window').length === ${maxWindows} && dToasts().includes('Trop de fenêtres ouvertes') && dButton().dataset.windows === '3'`);
  }
  record(CHECKS.limit, filled);

  // --- Tout fermer ------------------------------------------------------------------------------------
  const closed = await all([
    ['le menu de l’application', () => run('dContext(dButton());'), `dMenu() !== null && dMenu().includes('Fermer toutes les fenêtres')`],
    ['plus aucune fenêtre', () => run(`dMenuPick('Fermer toutes les fenêtres');`), `document.querySelectorAll('.window').length === 0 && dButton().dataset.windows === '0' && !dButton().classList.contains('is-running') && !dButton().classList.contains('is-active')`],
  ]);
  record(CHECKS.closeAll, closed);
}

module.exports = { checkDesktop, CHECKS, DESKTOP_TOOLS, MAX_WINDOWS, WINDOW_MENU };

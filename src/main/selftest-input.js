'use strict';

/**
 * Evolve — Auto-test : gestes de la souris et du clavier.
 *
 * Les autres contrôles de l'auto-test agissent sur la page par programme
 * (`élément.click()`), ce qui suffit à un bouton. Déplacer une fenêtre par sa
 * barre de titre, la redimensionner par un coin, passer d'une fenêtre à
 * l'autre au clavier exigent de vrais gestes : ils sont injectés ici dans le
 * moteur d'affichage (`webContents.sendInputEvent`), où ils suivent le même
 * chemin que ceux de l'utilisateur — pointage réel sur l'élément visé, capture
 * du pointeur, élément qui détient le clavier — et parviennent à la page comme
 * des événements authentiques.
 *
 * Le moteur ne transmet ces gestes qu'à une fenêtre qui les reçoit réellement.
 * `prepare()` le constate d'abord, par un mouvement de souris et une pression
 * sur la touche Maj, sans effet sur l'interface : si la page ne les voit pas,
 * les contrôles qui en dépendent ne sont pas menés, et le rapport le signale —
 * ils ne sont jamais tenus pour réussis.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Code de page : compte les mouvements de souris et les touches authentiques reçus. */
const PROBE = `
  if (!window.__evolveInput) {
    window.__evolveInput = { moves: 0, keys: 0 };
    document.addEventListener('pointermove', (event) => { if (event.isTrusted) window.__evolveInput.moves += 1; }, true);
    document.addEventListener('keydown', (event) => { if (event.isTrusted) window.__evolveInput.keys += 1; }, true);
  }`;

/** Modificateurs d'un événement de souris, selon le bouton tenu. */
const HELD = Object.freeze({ left: 'leftButtonDown', right: 'rightButtonDown', middle: 'middleButtonDown' });

/**
 * @param {object} options
 * @param {{ sendInputEvent?: (event: object) => void, focus?: () => void }} options.webContents
 * @param {{ focus?: () => void }} [options.win]
 * @param {(code: string) => Promise<any>} options.evaluate  exécute du code dans la page
 * @param {(code: string, options?: object) => Promise<any>} options.until  attend qu'un état apparaisse dans la page
 * @param {number} [options.pause]  attente entre deux événements, en millisecondes
 * @param {number} [options.probeTimeout]  attente maximale du constat de `prepare`
 */
function createInput({ webContents, win = null, evaluate, until, pause = 16, probeTimeout = 3000 }) {
  const available = { mouse: false, keyboard: false, focused: false };
  const canSend = typeof webContents.sendInputEvent === 'function';
  const point = (value) => Math.round(Number.isFinite(Number(value)) ? Number(value) : 0);
  const send = (event) => {
    if (canSend) webContents.sendInputEvent(event);
  };
  const wait = () => sleep(pause);

  /** Rend la fenêtre de l'application active, pour que le moteur lui transmette le clavier. */
  const focusWindow = () => {
    try {
      win?.focus?.();
      webContents.focus?.();
    } catch {
      /* sans effet sur le constat qui suit */
    }
  };

  return {
    /**
     * Ce que la page reçoit réellement : `{ mouse, keyboard, focused }` — `focused` : la page se tient pour
     * active (elle émet alors les événements « focus »). Faux tant que `prepare` ne l'a pas constaté.
     */
    available,

    /**
     * Constate que la page reçoit les gestes injectés.
     * @returns {Promise<{ mouse: boolean, keyboard: boolean, focused: boolean }>}
     */
    async prepare() {
      if (!canSend) return available;
      try {
        await evaluate(PROBE);
      } catch {
        return available;
      }
      focusWindow();
      for (let step = 0; step < 4; step += 1) {
        send({ type: 'mouseMove', x: 320 + step * 6, y: 240 + step * 4 });
        await wait();
      }
      available.mouse = (await until('return window.__evolveInput.moves > 0;', { timeout: probeTimeout })) === true;
      send({ type: 'keyDown', keyCode: 'Shift', modifiers: ['shift'] });
      await wait();
      send({ type: 'keyUp', keyCode: 'Shift' });
      available.keyboard = (await until('return window.__evolveInput.keys > 0;', { timeout: probeTimeout })) === true;
      try {
        available.focused = (await evaluate('return document.hasFocus();')) === true;
      } catch {
        available.focused = false;
      }
      return available;
    },

    /** Déplace le pointeur, sans bouton enfoncé. */
    async move(x, y) {
      send({ type: 'mouseMove', x: point(x), y: point(y) });
      await wait();
    },

    /**
     * Clic (ou double-clic, avec `count: 2`) à la position donnée.
     * @param {number} x
     * @param {number} y
     * @param {{ count?: number, button?: 'left'|'right'|'middle' }} [options]
     */
    async click(x, y, { count = 1, button = 'left' } = {}) {
      const at = { x: point(x), y: point(y), button };
      send({ type: 'mouseMove', x: at.x, y: at.y });
      await wait();
      for (let clickCount = 1; clickCount <= count; clickCount += 1) {
        send({ type: 'mouseDown', ...at, clickCount, modifiers: [HELD[button]] });
        await wait();
        send({ type: 'mouseUp', ...at, clickCount });
        await wait();
      }
    },

    /**
     * Appuie sur le bouton gauche en `from`, puis glisse jusqu'à `to` par
     * étapes. Le bouton reste enfoncé : `release` le relâche.
     * @param {{ x: number, y: number }} from
     * @param {{ x: number, y: number }} to
     * @param {{ steps?: number }} [options]
     */
    async press(from, to, { steps = 8 } = {}) {
      const start = { x: point(from?.x), y: point(from?.y) };
      const end = { x: point(to?.x), y: point(to?.y) };
      send({ type: 'mouseMove', ...start });
      await wait();
      send({ type: 'mouseDown', ...start, button: 'left', clickCount: 1, modifiers: [HELD.left] });
      await wait();
      for (let step = 1; step <= steps; step += 1) {
        const x = Math.round(start.x + ((end.x - start.x) * step) / steps);
        const y = Math.round(start.y + ((end.y - start.y) * step) / steps);
        send({ type: 'mouseMove', x, y, button: 'left', modifiers: [HELD.left] });
        await wait();
      }
      // Une image de plus : la position donnée à la fenêtre est appliquée à l'affichage.
      await wait();
    },

    /** Relâche le bouton gauche à la position donnée. */
    async release(at) {
      send({ type: 'mouseUp', x: point(at?.x), y: point(at?.y), button: 'left', clickCount: 1 });
      await wait();
    },

    /** Glisse de `from` à `to`, puis relâche. */
    async drag(from, to, options) {
      await this.press(from, to, options);
      await this.release(to);
    },

    /** Enfonce une touche (noms d'Electron : « Tab », « Escape », « Control », « Up », « W »…). */
    async keyDown(keyCode, modifiers = []) {
      send({ type: 'keyDown', keyCode, modifiers });
      await wait();
    },

    /** Relâche une touche. */
    async keyUp(keyCode, modifiers = []) {
      send({ type: 'keyUp', keyCode, modifiers });
      await wait();
    },

    /** Presse une touche — enfoncée, puis relâchée — avec les modificateurs donnés. */
    async key(keyCode, modifiers = []) {
      await this.keyDown(keyCode, modifiers);
      await this.keyUp(keyCode, modifiers);
    },

    /**
     * Presse une touche en tenant des modificateurs, comme le fait la main :
     * les modificateurs sont enfoncés d'abord, relâchés ensuite.
     * @param {string} keyCode
     * @param {('control'|'shift'|'alt')[]} modifiers
     */
    async chord(keyCode, modifiers) {
      const names = { control: 'Control', shift: 'Shift', alt: 'Alt' };
      const held = [];
      for (const modifier of modifiers) {
        held.push(modifier);
        await this.keyDown(names[modifier], [...held]);
      }
      await this.key(keyCode, [...held]);
      for (const modifier of [...modifiers].reverse()) {
        held.pop();
        await this.keyUp(names[modifier], [...held]);
      }
    },
  };
}

module.exports = { createInput, PROBE };

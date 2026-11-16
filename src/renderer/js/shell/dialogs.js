/**
 * Evolve — Fenêtres de dialogue (verre dépoli, clavier, une seule à la fois).
 *
 *   confirm   question à deux réponses (« Envoyer à la Corbeille ? ») ;
 *   choose    question à plusieurs réponses (nom déjà pris : conserver les
 *             deux, ignorer…) ;
 *   prompt    saisie d'un nom (nouveau dossier, renommer) ;
 *   inform    compte rendu à lire (éléments qui n'ont pas pu être traités) ;
 *   progress  avancement d'une opération longue, avec annulation.
 *
 * Une fenêtre de dialogue est modale : tant qu'elle est ouverte, le reste de
 * l'interface ne reçoit ni clic ni raccourci clavier. Échap annule, Tab reste
 * dans la fenêtre, et le clavier retrouve à la fermeture l'élément qu'il
 * avait quitté. Fermer une fenêtre sans répondre équivaut toujours à annuler.
 * Comme sous Windows, la réponse principale est à gauche, « Annuler » à droite.
 */

import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';

/** Teintes de la tuile d'icône et du bouton principal. */
const TONES = Object.freeze({
  accent: ['#d3b0ff', '#7c3aed'],
  danger: ['#ffb3c7', '#e0245e'],
  warning: ['#ffe2a6', '#f08c2e'],
});

/** Durée de l'animation de fermeture (voir dialogs.css). */
const CLOSE_MS = 160;

/** Délai avant l'affichage d'une fenêtre d'avancement : une opération plus brève n'en montre aucune. */
const PROGRESS_DELAY_MS = 350;

let sequence = 0;

export class Dialogs {
  #layer;
  #onOpen;
  /** Fenêtre ouverte : { el, backdrop, cancel, submit, returnFocus }. */
  #current = null;

  /**
   * @param {HTMLElement} layer  calque qui reçoit les fenêtres de dialogue
   * @param {object} [options]
   * @param {() => void} [options.onOpen]  appelée à chaque ouverture (fermer les menus…)
   */
  constructor(layer, { onOpen = () => {} } = {}) {
    this.#layer = layer;
    this.#onOpen = onOpen;
    // Phase de capture : le clavier appartient à la fenêtre de dialogue, avant tout raccourci de l'interface.
    document.addEventListener('keydown', (event) => this.#onKeyDown(event), true);
  }

  get isOpen() {
    return this.#current !== null;
  }

  /**
   * Question à deux réponses.
   * @param {object} options
   * @param {string} options.title
   * @param {string} [options.message]
   * @param {string[]} [options.details]  lignes d'une liste (noms d'éléments…)
   * @param {string} [options.note]       précision affichée sous la liste
   * @param {string} [options.glyph]
   * @param {'accent'|'danger'|'warning'} [options.tone]
   * @param {string} [options.confirmLabel]
   * @param {string} [options.cancelLabel]
   * @param {'confirm'|'cancel'} [options.focus]  bouton qui reçoit le clavier
   * @returns {Promise<boolean>} vrai si l'utilisateur a confirmé
   */
  confirm({ confirmLabel = 'Continuer', cancelLabel = 'Annuler', tone = 'accent', focus = 'confirm', ...content }) {
    return this.choose({ ...content, tone, cancelLabel, focus: focus === 'cancel' ? 'cancel' : 'confirm', actions: [{ id: 'confirm', label: confirmLabel, tone }] }).then((answer) => answer === 'confirm');
  }

  /**
   * Question à plusieurs réponses.
   * @param {object} options  comme `confirm`, avec :
   * @param {{ id: string, label: string, tone?: string }[]} options.actions  réponses proposées
   * @param {string} [options.focus]  identifiant de la réponse qui reçoit le clavier (« cancel » : Annuler)
   * @returns {Promise<string|null>} identifiant de la réponse, ou `null` si l'utilisateur a annulé
   */
  choose({ title, message, details, note, glyph = 'question', tone = 'accent', actions, cancelLabel = 'Annuler', focus }) {
    return new Promise((resolve) => {
      const cancel = this.#button('cancel', cancelLabel, 'ghost');
      const buttons = actions.map((action, index) => this.#button(action.id, action.label, action.tone ?? (index === 0 ? tone : 'plain')));
      const dialog = this.#open({
        kind: actions.length > 1 ? 'choose' : 'confirm',
        role: 'alertdialog',
        title,
        glyph,
        tone,
        body: this.#content({ message, details, note }),
        actions: [...buttons, cancel],
        initialFocus: buttons.find((button) => button.dataset.action === focus) ?? (focus === 'cancel' ? cancel : buttons[0]),
        onCancel: () => resolve(null),
      });
      cancel.addEventListener('click', () => dialog.close(() => resolve(null)));
      for (const button of buttons) button.addEventListener('click', () => dialog.close(() => resolve(button.dataset.action)));
    });
  }

  /**
   * Compte rendu à lire, avec un seul bouton.
   * @returns {Promise<void>}
   */
  inform({ title, message, details, note, glyph = 'info', tone = 'accent', closeLabel = 'Fermer' }) {
    return new Promise((resolve) => {
      const close = this.#button('close', closeLabel, 'accent');
      const dialog = this.#open({
        kind: 'inform',
        role: 'alertdialog',
        title,
        glyph,
        tone,
        body: this.#content({ message, details, note }),
        actions: [close],
        initialFocus: close,
        onCancel: () => resolve(),
      });
      close.addEventListener('click', () => dialog.close(() => resolve()));
    });
  }

  /**
   * Saisie d'un nom.
   * @param {object} options
   * @param {string} options.title
   * @param {string} [options.message]
   * @param {string} options.label   intitulé du champ
   * @param {string} [options.value] texte proposé
   * @param {number} [options.selectTo]  nombre de caractères sélectionnés à l'ouverture (par défaut : tout)
   * @param {string} [options.confirmLabel]
   * @param {(value: string) => (string|null|Promise<string|null>)} [options.onSubmit]
   *        appelée à la validation ; renvoie `null` si la valeur est acceptée
   *        (la fenêtre se ferme), ou le texte de l'erreur à afficher sous le
   *        champ (la fenêtre reste ouverte)
   * @returns {Promise<string|null>} la valeur acceptée, ou `null` si l'utilisateur a annulé
   */
  prompt({ title, message, label, value = '', selectTo, glyph = 'pencil-simple-line', tone = 'accent', confirmLabel = 'Valider', cancelLabel = 'Annuler', onSubmit = () => null }) {
    return new Promise((resolve) => {
      const id = `dialog-field-${(sequence += 1)}`;
      const input = h('input', { class: 'dialog__input', id, type: 'text', value, autocomplete: 'off', spellcheck: 'false', maxlength: '255', 'aria-describedby': `${id}-error` });
      input.value = value;
      const error = h('p', { class: 'dialog__error', id: `${id}-error`, role: 'alert' });
      const cancel = this.#button('cancel', cancelLabel, 'ghost');
      const confirm = this.#button('confirm', confirmLabel, tone);
      let busy = false;

      const dialog = this.#open({
        kind: 'prompt',
        role: 'dialog',
        title,
        glyph,
        tone,
        body: [...this.#content({ message }), h('div', { class: 'dialog__field' }, h('label', { class: 'dialog__label', for: id, text: label }), input, error)],
        actions: [confirm, cancel],
        initialFocus: input,
        onCancel: () => resolve(null),
        onSubmit: () => submit(),
        // Pendant le contrôle du nom, la fenêtre attend la réponse : elle ne se ferme pas.
        canCancel: () => !busy,
      });

      const setBusy = (state) => {
        busy = state;
        if (state) dialog.el.setAttribute('aria-busy', 'true');
        else dialog.el.removeAttribute('aria-busy');
        input.readOnly = state;
        confirm.setAttribute('aria-disabled', String(state));
      };
      const submit = async () => {
        if (busy) return;
        setBusy(true);
        let problem;
        try {
          problem = await onSubmit(input.value);
        } catch (failure) {
          problem = failure?.message || "L'opération a échoué.";
        }
        if (!dialog.isCurrent) return; // fermée entre-temps
        if (problem) {
          setBusy(false);
          error.textContent = problem;
          input.setAttribute('aria-invalid', 'true');
          input.focus({ preventScroll: true });
          input.select();
          return;
        }
        dialog.close(() => resolve(input.value));
      };

      input.addEventListener('input', () => {
        error.textContent = '';
        input.removeAttribute('aria-invalid');
      });
      confirm.addEventListener('click', submit);
      cancel.addEventListener('click', () => {
        if (!busy) dialog.close(() => resolve(null));
      });
      input.setSelectionRange(0, typeof selectTo === 'number' ? Math.max(0, Math.min(selectTo, value.length)) : value.length);
    });
  }

  /**
   * Avancement d'une opération longue.
   * @param {object} options
   * @param {string} options.title
   * @param {string} [options.message]
   * @param {() => void} [options.onCancel]  appelée une fois, quand l'utilisateur demande l'arrêt
   * @returns {{ update(state: { message?: string, done?: number, total?: number|null, current?: string }): void, close(): void }}
   */
  progress({ title, message = '', glyph = 'arrows-clockwise', cancelLabel = 'Annuler', onCancel = null }) {
    const text = h('p', { class: 'dialog__message', text: message });
    const fill = h('span');
    const bar = h('div', { class: 'dialog__bar is-indeterminate', role: 'progressbar', 'aria-label': title, 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
    const count = h('p', { class: 'dialog__count tabular' });
    const current = h('p', { class: 'dialog__current truncate' });
    const cancel = onCancel ? this.#button('cancel', cancelLabel, 'plain') : null;
    let asked = false;
    const ask = () => {
      if (asked || !cancel) return;
      asked = true;
      cancel.setAttribute('aria-disabled', 'true');
      cancel.textContent = 'Annulation…';
      onCancel();
    };
    const dialog = this.#open({
      kind: 'progress',
      role: 'dialog',
      title,
      glyph,
      tone: 'accent',
      body: [text, h('div', { class: 'dialog__progress' }, bar, count, current)],
      actions: cancel ? [cancel] : [],
      initialFocus: cancel,
      // Échap demande l'arrêt ; la fenêtre reste ouverte jusqu'à la fin réelle de l'opération.
      onCancel: ask,
      keepOpenOnCancel: true,
    });
    cancel?.addEventListener('click', ask);
    // Opération très brève : la fenêtre retient déjà les clics, mais ne s'affiche qu'après un court délai.
    dialog.backdrop.classList.add('is-pending');
    const reveal = setTimeout(() => {
      dialog.backdrop.classList.remove('is-pending');
      if (dialog.isCurrent) (cancel ?? dialog.el).focus({ preventScroll: true });
    }, PROGRESS_DELAY_MS);

    return {
      update: ({ message: nextMessage, done, total, current: name } = {}) => {
        if (typeof nextMessage === 'string') text.textContent = nextMessage;
        if (typeof name === 'string') current.textContent = name;
        if (typeof done !== 'number') return;
        if (typeof total === 'number' && total > 0) {
          const percent = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
          bar.classList.remove('is-indeterminate');
          bar.setAttribute('aria-valuenow', String(percent));
          fill.style.setProperty('--pct', `${percent}%`);
          count.textContent = `${done.toLocaleString('fr-FR')} sur ${total.toLocaleString('fr-FR')}`;
        } else {
          bar.classList.add('is-indeterminate');
          bar.removeAttribute('aria-valuenow');
          count.textContent = `${done.toLocaleString('fr-FR')} ${done > 1 ? 'éléments traités' : 'élément traité'}`;
        }
      },
      close: () => {
        clearTimeout(reveal);
        // Jamais affichée : retirée sans animation.
        if (dialog.backdrop.classList.contains('is-pending')) dialog.backdrop.hidden = true;
        dialog.close();
      },
    };
  }

  /** Ferme la fenêtre ouverte, comme si l'utilisateur avait annulé. */
  dismiss() {
    this.#current?.cancel({ force: true });
  }

  // --- Construction ----------------------------------------------------------------

  #button(action, label, tone) {
    const style = tone === 'ghost' ? ' btn--ghost' : tone === 'danger' ? ' btn--danger' : tone === 'plain' ? '' : ' btn--accent';
    return h('button', { class: `btn${style} dialog__button`, type: 'button', dataset: { action } }, h('span', { class: 'btn__label', text: label }));
  }

  #content({ message, details, note }) {
    return [
      message ? h('p', { class: 'dialog__message', text: message }) : null,
      details?.length ? h('ul', { class: 'dialog__list scroll' }, details.map((line) => h('li', { text: line }))) : null,
      note ? h('p', { class: 'dialog__note', text: note }) : null,
    ].filter(Boolean);
  }

  #open({ kind, role, title, glyph, tone, body, actions, initialFocus, onCancel, onSubmit = null, keepOpenOnCancel = false, canCancel = null }) {
    // Une seule fenêtre à la fois : la précédente est annulée.
    this.#current?.cancel({ force: true });
    this.#onOpen();

    const id = `dialog-${(sequence += 1)}`;
    const colors = TONES[tone] ?? TONES.accent;
    const el = h(
      'section',
      { class: 'dialog glass glass--menu glass--neon', role, 'aria-modal': 'true', 'aria-labelledby': `${id}-title`, tabindex: '-1', dataset: { kind, tone } },
      h(
        'header',
        { class: 'dialog__head' },
        h('span', { class: 'app-icon', style: { '--g1': colors[0], '--g2': colors[1] } }, icon(glyph, 'fill')),
        h('h2', { class: 'dialog__title', id: `${id}-title`, text: title }),
      ),
      h('div', { class: 'dialog__body' }, body),
      actions.length ? h('footer', { class: 'dialog__actions' }, actions) : null,
    );
    const backdrop = h('div', { class: 'dialog-backdrop' }, el);
    // Un clic à côté de la fenêtre ne lui retire pas le clavier.
    backdrop.addEventListener('pointerdown', (event) => {
      if (event.target === backdrop) event.preventDefault();
    });

    const entry = { el, backdrop, onSubmit, returnFocus: document.activeElement, closed: false };
    const remove = () => {
      if (entry.closed) return;
      entry.closed = true;
      if (this.#current === entry) this.#current = null;
      backdrop.classList.add('is-closing');
      backdrop.addEventListener('animationend', (event) => event.target === backdrop && backdrop.remove());
      setTimeout(() => backdrop.remove(), CLOSE_MS + 120); // filet de sécurité
      // Le clavier retourne où il était, sauf si une autre fenêtre de dialogue l'a pris.
      if (!this.#current && entry.returnFocus?.isConnected) entry.returnFocus.focus({ preventScroll: true });
    };
    /** Annulation : par l'utilisateur (Échap), ou forcée quand une autre fenêtre prend la place. */
    entry.cancel = ({ force = false } = {}) => {
      if (entry.closed) return;
      if (!force && canCancel && !canCancel()) return;
      if (keepOpenOnCancel && !force) {
        onCancel();
        return;
      }
      remove();
      if (!keepOpenOnCancel) onCancel();
    };

    this.#current = entry;
    this.#layer.append(backdrop);
    (initialFocus ?? el).focus({ preventScroll: true });

    return {
      el,
      backdrop,
      get isCurrent() {
        return !entry.closed;
      },
      /** Ferme la fenêtre, puis appelle `then` (la réponse de l'utilisateur). */
      close: (then) => {
        if (entry.closed) return;
        remove();
        then?.();
      },
    };
  }

  // --- Clavier -----------------------------------------------------------------------

  #onKeyDown(event) {
    const current = this.#current;
    if (!current) return;
    // Aucun raccourci de l'interface ne s'applique sous une fenêtre de dialogue.
    event.stopPropagation();
    const { el } = current;
    const active = document.activeElement;
    const inside = el.contains(active);

    if (event.key === 'Escape') {
      event.preventDefault();
      current.cancel();
    } else if (event.key === 'Tab') {
      const stops = [...el.querySelectorAll('button, input')].filter((item) => item.getAttribute('aria-disabled') !== 'true' && !item.disabled);
      if (stops.length === 0) {
        event.preventDefault();
        el.focus({ preventScroll: true });
        return;
      }
      const index = stops.indexOf(active);
      const next = event.shiftKey ? (index <= 0 ? stops.length - 1 : index - 1) : index < 0 || index === stops.length - 1 ? 0 : index + 1;
      event.preventDefault();
      stops[next].focus({ preventScroll: true });
    } else if (event.key === 'Enter') {
      if (inside && active.tagName === 'BUTTON') {
        // Bouton choisi au clavier : activé ici, puisque l'événement ne lui parvient pas.
        event.preventDefault();
        if (active.getAttribute('aria-disabled') !== 'true') active.click();
      } else if (current.onSubmit) {
        event.preventDefault();
        current.onSubmit();
      } else {
        event.preventDefault();
      }
    } else if (!inside) {
      // Le clavier s'est échappé (fenêtre du système revenue au premier plan…) : il revient ici.
      event.preventDefault();
      el.focus({ preventScroll: true });
    }
  }
}

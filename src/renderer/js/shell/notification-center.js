/**
 * Evolve — Centre de notifications et calendrier.
 * Les notifications affichées sont des exemples (data/demo-content.js) qui
 * décrivent l'état de cet aperçu de l'interface.
 */

import { h, animate } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { onTick } from '../core/clock.js';
import { WEEKDAY_LABELS, monthGrid, shiftMonth } from '../core/calendar.js';
import { formatDayMonth, formatMonthYear, formatRelative } from '../core/format.js';
import { getApp } from '../data/apps.js';
import { createDemoNotifications } from '../data/demo-content.js';
import { Flyout } from './flyouts.js';
import { ui } from './ui-state.js';

export class NotificationCenter extends Flyout {
  #list;
  #clearAll;
  /** @type {{ data: object, el: HTMLElement, time: HTMLElement }[]} */
  #items = [];
  #today = new Date();
  #shown = { year: 0, month: 0 };
  #todayLabel;
  #monthButton;
  #grid;

  constructor() {
    const el = h('section', {
      class: 'side-flyout nc glass glass--neon',
      role: 'dialog',
      'aria-label': 'Notifications et calendrier',
      tabindex: '-1',
    });
    super('notifications', el);

    this.#clearAll = h('button', { class: 'btn btn--ghost', type: 'button', text: 'Tout effacer' });
    this.#clearAll.addEventListener('click', () => this.#dismissAll());

    const dnd = h(
      'p',
      { class: 'nc__dnd', hidden: true },
      icon('bell-slash', 'fill'),
      h('span', { text: 'Ne pas déranger est activé.' }),
    );
    ui.subscribe('doNotDisturb', (enabled) => {
      dnd.hidden = !enabled;
    });

    this.#list = h('div', { class: 'nc__list scroll', role: 'list' });

    el.append(
      h('header', { class: 'nc__head' }, h('h2', { class: 'flyout__title', text: 'Notifications' }), this.#clearAll),
      dnd,
      this.#list,
      this.#buildCalendar(),
    );

    for (const data of createDemoNotifications()) this.#add(data);
    this.#sync();

    // Suit le changement de jour (minuit) et rafraîchit les durées relatives.
    onTick((now) => {
      if (now.getDate() !== this.#today.getDate() || now.getMonth() !== this.#today.getMonth()) {
        this.#today = now;
        this.#showMonth(now.getFullYear(), now.getMonth());
      }
      if (this.isOpen && now.getSeconds() === 0) this.#refreshTimes();
    });
  }

  onOpen() {
    this.#today = new Date();
    this.#showMonth(this.#today.getFullYear(), this.#today.getMonth());
    this.#refreshTimes();
    this.el.focus({ preventScroll: true });
  }

  onClose() {
    if (this.el.contains(document.activeElement)) document.activeElement.blur();
  }

  // --- Notifications ---------------------------------------------------------

  #add(data) {
    const app = data.app ? getApp(data.app) : null;
    const colors = app?.colors ?? data.colors;
    const time = h('span', { class: 'notif__time' });
    const close = h(
      'button',
      { class: 'icon-btn notif__close', type: 'button', 'aria-label': 'Effacer cette notification' },
      icon('x'),
    );
    const el = h(
      'article',
      { class: 'notif', role: 'listitem', style: { '--i': String(this.#items.length) } },
      h('span', { class: 'app-icon', style: { '--g1': colors[0], '--g2': colors[1] } }, icon(app?.glyph ?? data.glyph, 'fill')),
      h(
        'p',
        { class: 'notif__meta' },
        h('span', { class: 'notif__source truncate', text: app?.name ?? data.source }),
        h('span', { text: '·' }),
        time,
      ),
      close,
      h('h3', { class: 'notif__title', text: data.title }),
      h('p', { class: 'notif__body', text: data.body }),
    );
    const item = { data, el, time };
    close.addEventListener('click', () => this.#dismiss(item));
    this.#items.push(item);
    this.#list.append(el);
  }

  async #dismiss(item, delay = 0) {
    if (!this.#items.includes(item)) return;
    this.#items = this.#items.filter((other) => other !== item);
    ui.set('notificationCount', this.#items.length);
    this.#clearAll.hidden = this.#items.length === 0;

    const { el } = item;
    el.style.pointerEvents = 'none';
    const height = el.offsetHeight;
    const margin = parseFloat(getComputedStyle(el).marginBottom) || 0;
    // Glisse vers la droite, puis l'espace se referme.
    await animate(
      el,
      [
        { opacity: 1, transform: 'translateX(0)' },
        { opacity: 0, transform: 'translateX(60%)' },
      ],
      { duration: 240, delay, easing: 'cubic-bezier(0.6, 0, 0.9, 0.3)', fill: 'both' },
    );
    await animate(
      el,
      [
        { height: `${height}px`, marginBottom: `${margin}px`, paddingTop: getComputedStyle(el).paddingTop, paddingBottom: getComputedStyle(el).paddingBottom },
        { height: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px' },
      ],
      { duration: 220, fill: 'both' },
    );
    el.remove();
    this.#sync();
  }

  #dismissAll() {
    [...this.#items].forEach((item, index) => this.#dismiss(item, index * 60));
  }

  #sync() {
    const count = this.#items.length;
    ui.set('notificationCount', count);
    this.#clearAll.hidden = count === 0;
    const empty = this.#list.querySelector('.nc__empty');
    if (count === 0 && !empty && !this.#list.querySelector('.notif')) {
      this.#list.append(
        h(
          'div',
          { class: 'nc__empty' },
          icon('bell', 'duotone'),
          h('strong', { text: 'Aucune nouvelle notification' }),
          h('span', { text: 'Vous êtes à jour.' }),
        ),
      );
    }
  }

  #refreshTimes() {
    const now = new Date();
    for (const { data, time } of this.#items) time.textContent = formatRelative(data.time, now);
  }

  // --- Calendrier ------------------------------------------------------------

  #buildCalendar() {
    this.#todayLabel = h('p', { class: 'cal__today' });
    this.#monthButton = h('button', { class: 'cal__month', type: 'button', 'data-tip': "Revenir à aujourd'hui" });
    this.#monthButton.addEventListener('click', () => this.#showMonth(this.#today.getFullYear(), this.#today.getMonth()));

    const previous = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Mois précédent', 'data-tip': 'Mois précédent' }, icon('caret-up'));
    const next = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Mois suivant', 'data-tip': 'Mois suivant' }, icon('caret-down'));
    previous.addEventListener('click', () => this.#stepMonth(-1));
    next.addEventListener('click', () => this.#stepMonth(1));

    this.#grid = h('div', { class: 'cal__grid' });
    const viewport = h('div', { class: 'cal__viewport' }, this.#grid);
    // La molette fait défiler les mois.
    viewport.addEventListener(
      'wheel',
      (event) => {
        if (Math.abs(event.deltaY) < 4) return;
        event.preventDefault();
        this.#stepMonth(event.deltaY > 0 ? 1 : -1);
      },
      { passive: false },
    );

    return h(
      'section',
      { class: 'cal', 'aria-label': 'Calendrier' },
      this.#todayLabel,
      h('header', { class: 'cal__head' }, this.#monthButton, previous, next),
      h('div', { class: 'cal__weekdays', 'aria-hidden': 'true' }, WEEKDAY_LABELS.map((label) => h('span', { text: label }))),
      viewport,
    );
  }

  #stepMonth(delta) {
    const { year, month } = shiftMonth(this.#shown.year, this.#shown.month, delta);
    this.#showMonth(year, month);
  }

  #showMonth(year, month) {
    const before = this.#shown.year * 12 + this.#shown.month;
    const after = year * 12 + month;
    this.#shown = { year, month };

    this.#todayLabel.textContent = formatDayMonth(this.#today);
    this.#monthButton.textContent = formatMonthYear(new Date(year, month, 1));

    this.#grid.replaceChildren(
      ...monthGrid(year, month, this.#today).map((cell) =>
        h('span', {
          class: `cal__day tabular${cell.inMonth ? '' : ' is-outside'}${cell.isToday ? ' is-today' : ''}`,
          'aria-current': cell.isToday ? 'date' : null,
          text: String(cell.day),
        }),
      ),
    );

    // Animation de glissement selon le sens de navigation.
    this.#grid.classList.remove('is-next', 'is-prev');
    if (after !== before && before !== 0) {
      void this.#grid.offsetWidth;
      this.#grid.classList.add(after > before ? 'is-next' : 'is-prev');
    }
  }
}

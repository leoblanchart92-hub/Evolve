/**
 * Evolve Browser — interface de navigation personnalisée.
 * Version initiale : recherche Google et ouverture des pages dans le navigateur externe.
 */
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';

const shortcuts = [
  { label: 'Google', url: 'https://www.google.com', glyph: 'magnifying-glass' },
  { label: 'YouTube', url: 'https://www.youtube.com', glyph: 'film-slate' },
  { label: 'GitHub', url: 'https://github.com', glyph: 'terminal-window' },
  { label: 'Wikipedia', url: 'https://fr.wikipedia.org', glyph: 'file-text' },
];

function destination(value) {
  const text = value.trim();
  if (!text) return null;
  if (/^(https?:\/\/)/i.test(text)) return text;
  if (/^[\w-]+\.[a-z]{2,}(?:\/.*)?$/i.test(text)) return 'https://' + text;
  return 'https://www.google.com/search?q=' + encodeURIComponent(text);
}

export function mountBrowser(win) {
  const root = h('section', { class: 'ev-browser' });
  const tabs = h('div', { class: 'ev-browser__tabs' },
    h('div', { class: 'ev-browser__tab active' }, icon('compass'), h('span', { text: 'Nouvel onglet' })),
    h('button', { class: 'ev-browser__add', type: 'button', 'aria-label': 'Nouvel onglet', text: '+' }),
  );
  const nav = h('div', { class: 'ev-browser__nav' },
    h('button', { class: 'ev-browser__navbtn', type: 'button', 'aria-label': 'Retour', disabled: true }, icon('arrow-left')),
    h('button', { class: 'ev-browser__navbtn', type: 'button', 'aria-label': 'Avancer', disabled: true }, icon('arrow-right')),
    h('button', { class: 'ev-browser__navbtn', type: 'button', 'aria-label': 'Actualiser', disabled: true }, icon('arrow-clockwise')),
  );
  const address = h('input', { class: 'ev-browser__address', type: 'text', placeholder: 'Rechercher sur Google ou saisir une adresse', autocomplete: 'off', spellcheck: 'false' });
  const go = h('button', { class: 'ev-browser__go', type: 'button', title: 'Rechercher' }, icon('magnifying-glass'));
  nav.append(address, go, h('button', { class: 'ev-browser__bookmark', type: 'button', title: 'Favori (bientôt)' }, icon('sparkle')));
  const hero = h('div', { class: 'ev-browser__hero' },
    h('div', { class: 'ev-browser__logo' }, h('span', { text: 'E' })),
    h('h1', { text: 'Evolve Browser' }),
    h('p', { text: 'Votre espace web. Votre style.' }),
    h('div', { class: 'ev-browser__search' }, address.cloneNode(true)),
  );
  const searchBox = hero.querySelector('input');
  const submit = (input) => {
    const url = destination(input.value);
    if (!url) { input.focus(); return; }
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  address.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(address); });
  go.addEventListener('click', () => submit(address));
  const heroInput = hero.querySelector('input');
  heroInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(heroInput); });
  const shortcutsEl = h('div', { class: 'ev-browser__shortcuts' },
    h('h2', { text: 'Accès rapide' }),
    h('div', { class: 'ev-browser__shortcutgrid' }, shortcuts.map((item) => {
      const button = h('button', { class: 'ev-browser__shortcut', type: 'button' },
        h('span', { class: 'ev-browser__shortcuticon' }, icon(item.glyph)),
        h('span', { text: item.label }),
      );
      button.addEventListener('click', () => window.open(item.url, '_blank', 'noopener,noreferrer'));
      return button;
    })),
  );
  const note = h('p', { class: 'ev-browser__note', text: 'La recherche et les sites s’ouvrent dans le navigateur web de votre ordinateur pour cette première version.' });
  root.append(tabs, nav, hero, shortcutsEl, note);
  win.body.append(root);
  address.focus();
  return null;
}

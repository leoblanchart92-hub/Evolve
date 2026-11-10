/**
 * Evolve — Fenêtre d'attente.
 *
 * Cette étape du projet ne porte que sur l'interface de l'environnement. Les
 * applications autres que l'explorateur s'ouvrent donc dans une vraie fenêtre
 * (déplaçable, redimensionnable…) dont le contenu annonce honnêtement que
 * l'application elle-même reste à développer.
 */

import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';

export function mountPlaceholder(win) {
  const { app } = win;
  win.body.append(
    h(
      'div',
      { class: 'placeholder', style: { '--g1': app.colors[0], '--g2': app.colors[1] } },
      h(
        'div',
        { class: 'placeholder__halo' },
        h('span', { class: 'app-icon', style: { '--g1': app.colors[0], '--g2': app.colors[1] } }, icon(app.glyph, 'fill')),
      ),
      h('h2', { class: 'placeholder__title', text: app.name }),
      h('p', {
        class: 'placeholder__text',
        text: "Cette application fera l'objet d'une prochaine étape. Sa fenêtre est déjà fonctionnelle : déplacez-la, redimensionnez-la, agrandissez-la ou réduisez-la.",
      }),
      h('span', { class: 'chip chip--accent', text: "Aperçu de l'interface" }),
    ),
  );
  return null;
}

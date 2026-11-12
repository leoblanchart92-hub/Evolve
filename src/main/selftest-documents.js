'use strict';

/**
 * Evolve — Auto-test : un dossier Documents absent est annoncé, jamais recréé.
 *
 * Scénario « documents-missing ». Il s'exécute sur une machine dont le dossier
 * Documents a été mis de côté (voir scripts/check-documents.mjs) : pour le
 * système, ce dossier n'existe plus. L'application l'ouvre alors comme le
 * ferait l'utilisateur — tuile de l'accueil, volet latéral, icône du bureau —
 * et doit afficher chaque fois le même message, sans bloquer la navigation
 * ni gêner la consultation des autres dossiers.
 *
 * Que le dossier soit toujours absent du disque après ce parcours, c'est le
 * script qui le constate lui-même : la preuve ne repose pas sur ce que
 * l'application dit d'elle-même.
 */

const { PAGE_TOOLS } = require('./selftest-explorer');

/** Nom du scénario (`--self-test-scenario=documents-missing`). */
const SCENARIO = 'documents-missing';

/** Titre du message attendu, et phrase qui précise que rien n'a été créé (voir apps/explorer-nav.js). */
const MESSAGE_TITLE = 'Dossier « Documents » introuvable';
const NOTHING_CREATED = 'Evolve ne crée jamais de dossier à votre place';

/** Intitulés des contrôles, dans l'ordre du scénario. */
const CHECKS = Object.freeze({
  absent: 'le service de fichiers signale le dossier Documents comme introuvable, sans emplacement',
  home: "l'explorateur s'ouvre : le dossier Documents figure à l'accueil, estompé",
  tile: 'ouvrir Documents depuis l’accueil affiche « Dossier « Documents » introuvable », sans rien créer',
  back: '« Précédent » ramène à l’accueil : la navigation continue',
  sidebar: 'le volet latéral mène au même message',
  desktop: "l'icône « Documents » du bureau mène au même message",
  refresh: 'après « Actualiser », le dossier est toujours signalé comme introuvable',
  others: 'les autres dossiers personnels restent consultables',
});

const js = (value) => JSON.stringify(value);

/**
 * Code de page : `missing()` vaut `true` si l'explorateur affiche le message
 * du dossier Documents introuvable — et rien d'autre ; sinon, ce qu'il affiche.
 */
const MISSING_PAGE = `
  const exText = () => exWin().querySelector('.ex-empty span')?.textContent ?? null;
  const missing = () => {
    const state = exState();
    const text = exText();
    const crumbs = exCrumbs();
    return (state.page === 'error' && state.code === 'place-unavailable' && state.message === ${js(MESSAGE_TITLE)}
      && typeof text === 'string' && text.includes(${js(NOTHING_CREATED)}) && exItems().length === 0
      && crumbs.join(' > ') === 'Ce PC > Documents'
      && exWin().querySelector('.window__title').textContent.startsWith('Documents')
      && exWin().querySelector('.ex-side.is-current')?.dataset.id === 'place:documents') || { ...state, texte: text, fil: crumbs };
  };`;

/**
 * @param {object} tools  outils de l'auto-test (voir selftest.js)
 * @returns {Record<string, () => Promise<void>>} scénarios, par nom
 */
function documentsScenarios({ begin, check, act, until, evaluate, record, capture, report }) {
  return {
    [SCENARIO]: async () => {
      if (!(await begin())) return;

      // 1. Ce que le service de fichiers a trouvé sur cette machine.
      let found;
      try {
        found = await evaluate(
          `const reply = await window.evolve.services.call('files', 'places');
           return reply.ok ? { places: reply.value.places, drives: reply.value.drives.map((drive) => drive.id) } : { refus: reply.code ?? null };`,
        );
      } catch (error) {
        found = { exception: error?.message };
      }
      const places = Array.isArray(found?.places) ? found.places : [];
      const documents = places.find((place) => place?.id === 'documents') ?? null;
      if (places.length) {
        report.explorer = { places: places.filter((place) => place?.available === true).map((place) => place.id), drives: found.drives };
      }
      if (documents?.available === true) {
        // Le dossier existe : soit il n'avait pas été mis de côté, soit il vient d'être recréé.
        record(CHECKS.absent, { dossier: documents.path });
        report.errors.push(
          `le dossier Documents existe sur cette machine (${documents.path}) : s'il avait été mis de côté avant ce lancement ` +
            "(scripts/check-documents.mjs), c'est qu'il vient d'être recréé ; sinon, ce scénario n'a rien à vérifier ici",
        );
        return;
      }
      // Seule réponse admise : un emplacement « documents » sans chemin, signalé indisponible.
      const absent = documents !== null && documents.path === null && documents.available === false;
      if (!record(CHECKS.absent, absent || { documents, reponse: places.length ? undefined : (found ?? null) })) return;

      // 2. L'explorateur s'ouvre ; le dossier absent y figure, estompé.
      await act(`document.querySelector('.tb-app[data-app="explorer"]').click();`);
      await check(
        CHECKS.home,
        `${PAGE_TOOLS}
         if (!exWin()) return 'fenêtre absente';
         const tile = exItems().find((item) => item.dataset.id === 'place:documents');
         return (exContent().dataset.page === 'home' && !exBusy() && exItems().length === 6 && Boolean(tile) && tile.classList.contains('is-dimmed'))
           || { ...exState(), estompe: tile ? tile.classList.contains('is-dimmed') : null };`,
      );

      // 3. Double-clic sur la tuile : un message, et rien d'autre.
      await act(`${PAGE_TOOLS} if (!exOpen('place:documents')) throw new Error('tuile « Documents » absente de l’accueil');`);
      await check(CHECKS.tile, `${PAGE_TOOLS}${MISSING_PAGE} return missing();`);
      await capture('01-documents-absent');

      // 4. La navigation continue.
      await act(`${PAGE_TOOLS} exButton('Précédent').click();`);
      await check(
        CHECKS.back,
        `${PAGE_TOOLS}
         return (exContent().dataset.page === 'home' && !exBusy() && exItems().length === 6
           && exButton('Suivant').getAttribute('aria-disabled') === 'false') || exState();`,
      );

      // 5. Volet latéral.
      await act(`${PAGE_TOOLS} exWin().querySelector('.ex-side[data-id="place:documents"]').click();`);
      await check(CHECKS.sidebar, `${PAGE_TOOLS}${MISSING_PAGE} return missing();`);

      // 6. Icône du bureau, depuis une autre page de l'explorateur.
      await act(`${PAGE_TOOLS} exWin().querySelector('.ex-side[data-id="pc"]').click();`);
      await until(`${PAGE_TOOLS} return (exContent().dataset.page === 'pc' && !exBusy()) || exState();`);
      await act(`document.querySelector('.desktop-icon[data-id="documents"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));`);
      await check(
        CHECKS.desktop,
        `${PAGE_TOOLS}${MISSING_PAGE}
         const shown = missing();
         if (shown !== true) return shown;
         const windows = document.querySelectorAll('.window[data-app="explorer"]').length;
         return (windows === 1 && exWin().classList.contains('is-focused')) || { fenetres: windows };`,
      );

      // 7. Actualiser : nouvelle recherche des emplacements, même constat.
      await act(`${PAGE_TOOLS} exButton('Actualiser').click();`);
      await check(
        CHECKS.refresh,
        `${PAGE_TOOLS}${MISSING_PAGE}
         if (exBusy()) return 'lecture en cours';
         const shown = missing();
         if (shown !== true) return shown;
         const reply = await files('places');
         const place = reply.ok ? reply.value.places.find((item) => item.id === 'documents') : { refus: reply.code ?? null };
         return (Boolean(place) && place.path === null && place.available === false) || (place ?? null);`,
      );

      // 8. Les autres dossiers personnels ne sont pas affectés.
      const others = places.filter((place) => place?.available === true && typeof place.path === 'string' && /^[a-z]+$/.test(place.id));
      if (others.length === 0) {
        report.warnings.push('aucun autre dossier personnel sur cette machine : leur consultation n’a pas été vérifiée');
        return;
      }
      const [first] = others;
      await act(`${PAGE_TOOLS} exWin().querySelector('.ex-side[data-id="place:${first.id}"]').click();`);
      await check(
        CHECKS.others,
        `${PAGE_TOOLS}
         const refused = [];
         for (const place of ${js(others.map((place) => ({ id: place.id, path: place.path })))}) {
           const reply = await files('list', place.path);
           if (!reply.ok || reply.value.root.kind !== 'place') refused.push({ dossier: place.id, code: reply.code ?? null });
         }
         if (refused.length) return refused;
         return (exContent().dataset.page === 'folder' && exContent().dataset.path === ${js(first.path)} && !exBusy()
           && exWin().querySelector('.ex-side.is-current')?.dataset.id === 'place:${first.id}') || exState();`,
      );
    },
  };
}

module.exports = { documentsScenarios, SCENARIO, CHECKS, MESSAGE_TITLE, NOTHING_CREATED };

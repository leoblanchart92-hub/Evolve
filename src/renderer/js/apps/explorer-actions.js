/**
 * Evolve — Explorateur de fichiers : opérations sur les fichiers (sans affichage).
 *
 * Nouveau dossier, renommer, couper, copier, coller, envoyer à la Corbeille et
 * ouvrir un fichier. Ce module décide QUAND une commande est utilisable,
 * enchaîne les questions posées à l'utilisateur (nom, confirmation, nom déjà
 * pris), suit l'avancement et rédige les comptes rendus. Il ne touche jamais
 * au disque : chaque opération est demandée à l'application de bureau
 * (src/services/file-operations.js), qui contrôle tout et seule agit.
 *
 * Trois règles, appliquées ici comme dans l'application de bureau :
 *   - rien n'est supprimé définitivement : « supprimer » envoie à la Corbeille
 *     de Windows, après confirmation ;
 *   - rien n'est remplacé : devant un nom déjà pris, l'utilisateur choisit de
 *     conserver les deux éléments ou d'ignorer ceux qui gênent ;
 *   - déplacer, envoyer à la Corbeille et ouvrir un programme — ou tout
 *     fichier qui n'est pas d'un type connu pour n'être qu'un contenu — sont
 *     confirmés par l'utilisateur avant d'être demandés.
 *
 * Module sans DOM : il se teste directement avec Node.
 */

import { plural } from '../core/format.js';

/** Nombre de noms cités dans une fenêtre de dialogue ; au-delà, le reste est compté. */
const LISTED_NAMES = 12;

/** Éléments qu'une même demande peut désigner (limite de l'application de bureau). */
export const MAX_ITEMS = 1000;

/** Teinte des notifications d'échec. */
const ERROR_COLORS = Object.freeze(['#ffb3c7', '#e0245e']);

const quote = (name) => `« ${name} »`;

/** Vocabulaire de chaque opération longue. */
const WORDS = Object.freeze({
  copy: {
    progress: 'Copie en cours',
    done: 'Copie terminée',
    partial: 'Copie incomplète',
    cancelled: 'Copie annulée',
    failed: 'Copie impossible',
    none: 'Aucun élément copié',
    one: (name, where) => `${quote(name)} a été copié dans ${quote(where)}.`,
    many: (count, where) => `${plural(count, 'élément')} ont été copiés dans ${quote(where)}.`,
    count: (count) => (count > 1 ? `${plural(count, 'élément')} copiés` : '1 élément copié'),
  },
  move: {
    progress: 'Déplacement en cours',
    done: 'Déplacement terminé',
    partial: 'Déplacement incomplet',
    cancelled: 'Déplacement annulé',
    failed: 'Déplacement impossible',
    none: 'Aucun élément déplacé',
    one: (name, where) => `${quote(name)} a été déplacé vers ${quote(where)}.`,
    many: (count, where) => `${plural(count, 'élément')} ont été déplacés vers ${quote(where)}.`,
    count: (count) => (count > 1 ? `${plural(count, 'élément')} déplacés` : '1 élément déplacé'),
  },
  trash: {
    progress: 'Envoi à la Corbeille',
    done: 'Envoyé à la Corbeille',
    partial: 'Envoi à la Corbeille incomplet',
    cancelled: 'Envoi à la Corbeille annulé',
    failed: 'Envoi à la Corbeille impossible',
    none: 'Aucun élément envoyé à la Corbeille',
    one: (name) => `${quote(name)} a été envoyé à la Corbeille de Windows.`,
    many: (count) => `${plural(count, 'élément')} ont été envoyés à la Corbeille de Windows.`,
    count: (count) => (count > 1 ? `${plural(count, 'élément')} envoyés à la Corbeille` : '1 élément envoyé à la Corbeille'),
  },
});

let sequence = 0;

/**
 * Identifiant d'une opération : il relie une demande à son avancement et
 * permet de l'interrompre. Lettres, chiffres et tirets seulement.
 */
export function newOperationId() {
  sequence += 1;
  return `op-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

/**
 * Dossier réel affiché par une page — là où l'on peut créer et coller —, ou
 * `null` : accueil, « Ce PC », message d'erreur, aperçu dans un navigateur.
 */
export function folderOf(page) {
  if (!page || page.kind !== 'folder' || page.message) return null;
  return typeof page.location?.path === 'string' && page.location.path !== '' ? page.location.path : null;
}

/**
 * Vrai pour un élément sur lequel une opération peut être demandée : un
 * fichier ou un dossier lu dans un dossier réel. Ni un lecteur, ni un dossier
 * personnel (Bureau, Documents…), ni un lien, ni un élément du système.
 */
export function isOperable(node) {
  return Boolean(node) && typeof node.path === 'string' && node.path !== '' && (node.kind === 'file' || node.kind === 'folder') && !node.place;
}

/**
 * Commandes utilisables, d'après la page affichée, la sélection et le
 * presse-papiers. Une commande inutilisable est désactivée dans l'interface ;
 * l'application de bureau reste seule juge de chaque demande.
 * @param {object} state
 * @param {boolean} state.available  les opérations existent (application de bureau)
 * @param {boolean} state.busy       une opération est en cours
 * @param {object|null} state.page   page affichée
 * @param {object[]} state.selection éléments sélectionnés
 * @param {number} state.clipboard   nombre d'éléments du presse-papiers
 */
export function availableCommands({ available, busy, page, selection, clipboard }) {
  const ready = available && !busy;
  const folder = folderOf(page);
  const operable = ready && folder !== null && selection.length > 0 && selection.every(isOperable);
  const single = selection.length === 1 ? selection[0] : null;
  return {
    /** Ouvrir : un dossier, un lecteur ou un lien se parcourt ; un fichier est confié à Windows. */
    open: Boolean(single) && (Boolean(single.location) || (ready && single.kind === 'file' && typeof single.path === 'string')),
    cut: operable,
    copy: operable,
    rename: operable && selection.length === 1,
    trash: operable,
    paste: ready && folder !== null && clipboard > 0,
    newFolder: ready && folder !== null,
  };
}

/**
 * Presse-papiers de fichiers, interne à Evolve : les éléments coupés ou copiés
 * dans l'explorateur, en attente d'être collés. Il ne contient que des
 * chemins ; le presse-papiers de Windows n'est ni lu ni modifié.
 */
export function createFileClipboard() {
  /** @type {{ mode: 'copy'|'cut', items: { path: string, name: string, kind: string }[] } | null} */
  let content = null;
  const listeners = new Set();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  return {
    /** « copy », « cut », ou `null` s'il est vide. */
    get mode() {
      return content?.mode ?? null;
    },
    get size() {
      return content?.items.length ?? 0;
    },
    get items() {
      return content ? content.items.map((item) => ({ ...item })) : [];
    },
    /** Vrai si l'élément `path` attend d'être déplacé (il est affiché estompé). */
    isCut(path) {
      return content?.mode === 'cut' && content.items.some((item) => item.path === path);
    },
    /** Retient des éléments à copier (`copy`) ou à déplacer (`cut`). */
    set(mode, nodes) {
      const items = nodes.filter(isOperable).map((node) => ({ path: node.path, name: node.name, kind: node.kind }));
      content = items.length && (mode === 'copy' || mode === 'cut') ? { mode, items } : null;
      notify();
    },
    clear() {
      if (!content) return;
      content = null;
      notify();
    },
    /** Abonne `listener()` aux changements ; renvoie une fonction de désabonnement. */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Premier nom libre parmi « Nouveau dossier », « Nouveau dossier (2) »… (casse indifférente, comme Windows). */
export function freeFolderName(existing, base = 'Nouveau dossier') {
  const taken = new Set([...existing].map((name) => String(name).toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base} (${index})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

/** Longueur du nom sans son extension : la partie sélectionnée quand on renomme un fichier. */
export function baseLength(node) {
  if (node.kind !== 'file') return node.name.length;
  const dot = node.name.lastIndexOf('.');
  return dot > 0 ? dot : node.name.length;
}

/** Noms à citer dans une fenêtre de dialogue : les premiers, puis le compte des autres. */
export function listNames(names, limit = LISTED_NAMES) {
  if (names.length <= limit) return [...names];
  const rest = names.length - (limit - 1);
  return [...names.slice(0, limit - 1), `… et ${plural(rest, 'autre élément', 'autres éléments')}`];
}

/** Ce qu'il est advenu d'un élément qui n'a pas été traité, en une ligne. */
function problemLine(entry) {
  const name = quote(entry.name);
  // Dossier dont la copie s'est arrêtée en chemin : ce qui a été copié reste, sous un nom qui le dit.
  const kept = entry.partial
    ? entry.complete
      ? ` La copie est complète, mais elle a gardé son nom provisoire : ${quote(entry.partial)}.`
      : ` Ce qui avait déjà été copié est conservé sous le nom ${quote(entry.partial)}.`
    : '';
  if (entry.reason === 'collision') return `${name} : ignoré, un élément porte déjà ce nom.`;
  if (entry.reason === 'same-location') return `${name} : déjà dans ce dossier.`;
  if (entry.reason === 'cancelled') return `${name} : non traité, l'opération a été annulée.${kept}`;
  const where = entry.at ? ` (dans ${quote(entry.at)})` : '';
  return `${name}${where} : ${entry.message ?? "l'opération a échoué."}${kept}`;
}

/** Éléments écartés sans surprise : déjà à leur place, ou ignorés à la demande de l'utilisateur. */
function chosenNote(chosen) {
  if (!chosen.length) return '';
  const many = chosen.length > 1;
  if (chosen.every((entry) => entry.reason === 'same-location')) {
    return many ? `${plural(chosen.length, 'élément')} se trouvaient déjà dans ce dossier.` : 'Cet élément se trouve déjà dans ce dossier.';
  }
  return many ? `${plural(chosen.length, 'élément')} ont été ignorés : leur nom était déjà pris.` : 'Un élément a été ignoré : son nom était déjà pris.';
}

/**
 * Compte rendu d'une opération longue (copie, déplacement, envoi à la
 * Corbeille), à partir du rapport de l'application de bureau.
 *
 * `quiet` : tout s'est passé comme l'utilisateur l'a demandé — une simple
 * notification suffit. Sinon, une fenêtre détaille ce qui n'a pas été traité.
 * @param {'copy'|'move'|'trash'} kind
 * @param {object} report  rapport `{ done, skipped, failed, cancelled, links, others }`
 * @param {string} [where] nom du dossier de destination
 * @returns {{ quiet: boolean, success: boolean, title: string, message: string, details: string[], note: string }}
 */
export function describeReport(kind, report, where = '') {
  const words = WORDS[kind];
  const done = report.done ?? [];
  const failed = report.failed ?? [];
  const skipped = report.skipped ?? [];
  const chosen = skipped.filter((entry) => entry.reason === 'collision' || entry.reason === 'same-location');
  const interrupted = skipped.filter((entry) => entry.reason === 'cancelled');
  const links = report.links ?? 0;
  const others = report.others ?? 0;

  // Ce que l'utilisateur doit savoir, au-delà du décompte.
  const notes = [];
  const trashed = done.filter((entry) => entry.original === 'trashed').length;
  if (trashed) {
    notes.push(
      trashed > 1
        ? `Ces éléments ont changé de lecteur : ils ont été copiés, puis les originaux ont été envoyés à la Corbeille de Windows.`
        : `Cet élément a changé de lecteur : il a été copié, puis l'original a été envoyé à la Corbeille de Windows.`,
    );
  }
  if (links) {
    notes.push(
      `${plural(links, 'lien')} (${links > 1 ? 'liens symboliques ou jonctions' : 'lien symbolique ou jonction'}) ${links > 1 ? "n'ont pas été copiés" : "n'a pas été copié"} : Evolve ne copie pas les liens.`,
    );
  }
  if (others) notes.push(`${plural(others, 'élément spécial', 'éléments spéciaux')} ${others > 1 ? "n'ont pas été copiés" : "n'a pas été copié"}.`);

  const renamed = done.length === 1 && done[0].name !== undefined && done[0].name !== (done[0].source ?? '').split(/[\\/]/).pop();
  let summary;
  if (done.length === 0) summary = '';
  else if (done.length === 1) summary = renamed && kind === 'copy' ? `${quote(done[0].name)} a été créé dans ${quote(where)}.` : words.one(done[0].name, where);
  else summary = words.many(done.length, where);

  const unexpected = failed.length > 0 || interrupted.length > 0 || links > 0 || others > 0;
  if (!unexpected) {
    // Rien d'imprévu : seuls des éléments écartés par l'utilisateur, ou déjà à leur place.
    return {
      quiet: true,
      success: done.length > 0,
      title: done.length ? words.done : words.none,
      message: [summary, chosenNote(chosen), ...notes].filter(Boolean).join(' '),
      details: [],
      note: '',
    };
  }

  const lines = [...failed, ...interrupted, ...chosen].map(problemLine);
  const parts = [];
  if (summary) parts.push(summary);
  if (failed.length) parts.push(failed.length > 1 ? `${plural(failed.length, 'élément')} n'ont pas pu être traités :` : "Un élément n'a pas pu être traité :");
  else if (interrupted.length) parts.push(interrupted.length > 1 ? `${plural(interrupted.length, 'élément')} n'ont pas été traités :` : "Un élément n'a pas été traité :");
  return {
    quiet: false,
    success: done.length > 0,
    title: report.cancelled ? words.cancelled : done.length ? words.partial : failed.length ? words.failed : words.done,
    message: parts.join(' '),
    details: lines,
    note: notes.join(' '),
  };
}

/**
 * Opérations sur les fichiers de l'explorateur.
 */
export class FileActions {
  #operations;
  #dialogs;
  #toasts;
  #clipboard;
  #view;
  #busy = false;
  /** Opération longue en cours : { id, view } (fenêtre d'avancement). */
  #progress = null;
  #unsubscribe;

  /**
   * @param {object} deps
   * @param {object} deps.operations  demandes à l'application de bureau (core/file-operations.js)
   * @param {object} deps.dialogs     fenêtres de dialogue (shell/dialogs.js)
   * @param {object} deps.toasts      notifications éphémères (shell/toasts.js)
   * @param {object} deps.clipboard   presse-papiers de fichiers (voir createFileClipboard)
   * @param {object} deps.view        ce que l'explorateur affiche :
   *        `page()` page courante, `reload()` relit le dossier affiché,
   *        `select(chemins)` sélectionne des éléments, `changed()` signale que
   *        l'état des commandes a changé
   */
  constructor({ operations, dialogs, toasts, clipboard, view }) {
    this.#operations = operations;
    this.#dialogs = dialogs;
    this.#toasts = toasts;
    this.#clipboard = clipboard;
    this.#view = view;
    this.#unsubscribe = operations.onProgress((event) => this.#onProgress(event));
  }

  /** Vrai tant qu'une opération est en cours : les commandes sont désactivées. */
  get busy() {
    return this.#busy;
  }

  /** Commandes utilisables pour la sélection `selection` (voir availableCommands). */
  commands(selection) {
    return availableCommands({
      available: this.#operations.available,
      busy: this.#busy,
      page: this.#view.page(),
      selection,
      clipboard: this.#clipboard.size,
    });
  }

  /** Cesse d'écouter l'avancement des opérations (fenêtre de l'explorateur fermée). */
  dispose() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  // --- Commandes -------------------------------------------------------------------

  /** Crée un dossier dans le dossier affiché, après en avoir demandé le nom. */
  newFolder() {
    if (!this.commands([]).newFolder) return Promise.resolve();
    return this.#exclusive(async () => {
      const page = this.#view.page();
      const folder = folderOf(page);
      const existing = page.sections.flatMap((section) => section.nodes).map((node) => node.name);

      let created = null;
      const name = await this.#dialogs.prompt({
        title: 'Nouveau dossier',
        message: `Le dossier sera créé dans ${quote(page.title)}.`,
        label: 'Nom du dossier',
        value: freeFolderName(existing),
        glyph: 'folder-plus',
        confirmLabel: 'Créer',
        // Le nom est contrôlé par l'application de bureau : son refus s'affiche sous le champ.
        onSubmit: async (value) => {
          try {
            created = await this.#operations.createFolder(folder, value.trim());
            return null;
          } catch (error) {
            return this.#messageOf(error);
          }
        },
      });
      if (name === null || !created) return;

      await this.#reveal([created.path]);
      this.#toasts.show({ key: 'explorer-files', title: 'Dossier créé', message: `${quote(created.name)} a été créé dans ${quote(page.title)}.`, glyph: 'folder-plus' });
    });
  }

  /** Renomme un élément, après avoir demandé son nouveau nom. */
  rename(node) {
    if (!this.commands([node]).rename) return Promise.resolve();
    return this.#exclusive(async () => {
      let renamed = null;
      const name = await this.#dialogs.prompt({
        title: 'Renommer',
        message: `Nouveau nom de ${quote(node.name)}.`,
        label: 'Nouveau nom',
        value: node.name,
        // Le nom d'un fichier est proposé sans son extension : la saisie la laisse en place.
        selectTo: baseLength(node),
        glyph: 'pencil-simple-line',
        confirmLabel: 'Renommer',
        onSubmit: async (value) => {
          try {
            renamed = await this.#operations.rename(node.path, value.trim());
            return null;
          } catch (error) {
            return this.#messageOf(error);
          }
        },
      });
      if (name === null || !renamed || renamed.unchanged) return;

      await this.#reveal([renamed.path]);
      this.#toasts.show({ key: 'explorer-files', title: 'Élément renommé', message: `${quote(node.name)} s'appelle maintenant ${quote(renamed.name)}.`, glyph: 'pencil-simple-line' });
    });
  }

  /** Retient des éléments à copier : rien n'est modifié avant « Coller ». */
  copy(nodes) {
    if (!this.commands(nodes).copy || this.#tooMany(nodes.length)) return;
    this.#clipboard.set('copy', nodes);
  }

  /** Retient des éléments à déplacer : rien n'est modifié avant « Coller ». */
  cut(nodes) {
    if (!this.commands(nodes).cut || this.#tooMany(nodes.length)) return;
    this.#clipboard.set('cut', nodes);
  }

  /** Colle le presse-papiers dans le dossier affiché : copie, ou déplacement des éléments coupés. */
  paste() {
    if (!this.commands([]).paste) return Promise.resolve();
    return this.#exclusive(async () => {
      const page = this.#view.page();
      const folder = folderOf(page);
      const kind = this.#clipboard.mode === 'cut' ? 'move' : 'copy';
      const items = this.#clipboard.items;
      const names = items.map((item) => item.name);

      if (kind === 'move') {
        // Un déplacement retire les éléments de leur dossier : il est confirmé.
        const confirmed = await this.#dialogs.confirm({
          title: items.length > 1 ? `Déplacer ${plural(items.length, 'élément')} ?` : `Déplacer ${quote(names[0])} ?`,
          message:
            items.length > 1
              ? `Ces éléments quitteront leur dossier actuel pour ${quote(page.title)}.`
              : `Cet élément quittera son dossier actuel pour ${quote(page.title)}.`,
          details: items.length > 1 ? listNames(names) : [],
          glyph: 'scissors',
          confirmLabel: 'Déplacer',
        });
        if (!confirmed) return;
      }

      const report = await this.#transfer(kind, items, folder, page.title);
      if (!report) return; // annulé devant un nom déjà pris : rien n'a été modifié
      // Les éléments coupés ont été traités : ils ne sont plus en attente.
      if (kind === 'move') this.#clipboard.clear();
      await this.#reveal(report.done.map((entry) => entry.path));
      await this.#announce(kind, report, page.title);
    });
  }

  /** Envoie des éléments à la Corbeille de Windows, après confirmation. Rien n'est supprimé définitivement. */
  trash(nodes) {
    if (!this.commands(nodes).trash || this.#tooMany(nodes.length)) return Promise.resolve();
    return this.#exclusive(async () => {
      const names = nodes.map((node) => node.name);
      const single = nodes.length === 1 ? nodes[0] : null;
      const confirmed = await this.#dialogs.confirm({
        title: single ? `Envoyer ${quote(single.name)} à la Corbeille ?` : `Envoyer ${plural(nodes.length, 'élément')} à la Corbeille ?`,
        message: single
          ? single.kind === 'folder'
            ? 'Ce dossier et tout son contenu seront envoyés à la Corbeille de Windows.'
            : 'Ce fichier sera envoyé à la Corbeille de Windows.'
          : 'Ces éléments seront envoyés à la Corbeille de Windows :',
        details: single ? [] : listNames(names),
        note: `Rien n'est supprimé définitivement : vous pourrez ${single ? 'le' : 'les'} restaurer depuis la Corbeille de Windows.`,
        glyph: 'trash',
        tone: 'danger',
        confirmLabel: 'Envoyer à la Corbeille',
      });
      if (!confirmed) return;

      let report;
      try {
        report = await this.#long({
          kind: 'trash',
          message: single ? `Envoi de ${quote(single.name)} à la Corbeille…` : `Envoi de ${plural(nodes.length, 'élément')} à la Corbeille…`,
          request: (operation) => this.#operations.trash(nodes.map((node) => node.path), { confirmed: true, operation }),
        });
      } catch (error) {
        this.#fail(WORDS.trash.failed, error);
        return;
      }
      await this.#view.reload();
      await this.#announce('trash', report, '');
    });
  }

  /**
   * Ouvre un fichier avec l'application que Windows lui associe. L'application
   * de bureau décide seule de ce qui demande une confirmation : tout fichier
   * qui n'est pas d'un type connu pour n'être qu'un contenu — programme,
   * script, raccourci, type inconnu.
   */
  open(node) {
    if (this.#busy || !this.#operations.available || node.kind !== 'file' || typeof node.path !== 'string') return Promise.resolve();
    return this.#exclusive(async () => {
      try {
        await this.#operations.open(node.path);
        return;
      } catch (error) {
        if (error?.code !== 'needs-confirmation') {
          this.#fail('Ouverture impossible', error, node.name);
          return;
        }
        const confirmed = await this.#dialogs.confirm({
          title: `Ouvrir ${quote(node.name)} ?`,
          message: this.#messageOf(error),
          note: "N'ouvrez ce fichier que si vous savez d'où il vient.",
          glyph: 'warning-circle',
          tone: 'warning',
          confirmLabel: 'Ouvrir',
          // Par défaut, la touche Entrée n'exécute rien.
          focus: 'cancel',
        });
        if (!confirmed) return;
      }
      try {
        await this.#operations.open(node.path, { confirmed: true });
      } catch (error) {
        this.#fail('Ouverture impossible', error, node.name);
      }
    });
  }

  // --- Déroulement -----------------------------------------------------------------

  /** Une seule commande à la fois ; une erreur imprévue est annoncée, jamais passée sous silence. */
  async #exclusive(task) {
    if (this.#busy) return;
    this.#busy = true;
    this.#view.changed();
    try {
      await task();
    } catch (error) {
      // Erreur de l'interface elle-même : son détail va au journal, l'utilisateur est prévenu.
      console.error(error);
      this.#fail('Opération impossible', error);
    } finally {
      this.#busy = false;
      this.#view.changed();
    }
  }

  /** Copie ou déplace `items` vers `folder` ; `null` si l'utilisateur a renoncé devant un nom déjà pris. */
  async #transfer(kind, items, folder, where) {
    const words = WORDS[kind];
    const sources = items.map((item) => item.path);
    const message =
      items.length > 1
        ? `${kind === 'move' ? 'Déplacement' : 'Copie'} de ${plural(items.length, 'élément')} vers ${quote(where)}…`
        : `${kind === 'move' ? 'Déplacement' : 'Copie'} de ${quote(items[0].name)} vers ${quote(where)}…`;
    // Premier essai : devant un nom déjà pris, rien n'est modifié et la question est posée.
    let onCollision = 'ask';
    for (;;) {
      let result;
      try {
        result = await this.#long({
          kind,
          message,
          request: (operation) => this.#operations[kind](sources, folder, { operation, onCollision, ...(kind === 'move' ? { confirmed: true } : {}) }),
        });
      } catch (error) {
        this.#fail(words.failed, error);
        return null;
      }
      if (result?.status !== 'collisions') return result;

      const taken = result.collisions.map((entry) => entry.name);
      const choice = await this.#dialogs.choose({
        title: taken.length > 1 ? `${plural(taken.length, 'élément')} portent déjà ce nom` : `${quote(taken[0])} existe déjà`,
        message:
          taken.length > 1
            ? `Le dossier ${quote(where)} contient déjà des éléments du même nom. Evolve ne remplace jamais un élément existant.`
            : `Le dossier ${quote(where)} contient déjà un élément de ce nom. Evolve ne remplace jamais un élément existant.`,
        details: taken.length > 1 ? listNames(taken) : [],
        note: `Conserver les deux : ${kind === 'move' ? "l'élément déplacé" : 'la copie'} reçoit un nouveau nom (« nom - Copie »). Ignorer : ${taken.length > 1 ? 'ces éléments ne sont pas traités' : "cet élément n'est pas traité"}.`,
        glyph: 'copy',
        actions: [
          { id: 'keep-both', label: 'Conserver les deux' },
          { id: 'skip', label: 'Ignorer', tone: 'plain' },
        ],
      });
      if (choice !== 'keep-both' && choice !== 'skip') return null;
      onCollision = choice;
    }
  }

  /** Demande une opération longue : fenêtre d'avancement, annulation possible. */
  async #long({ kind, message, request }) {
    const id = newOperationId();
    const view = this.#dialogs.progress({
      title: WORDS[kind].progress,
      message,
      glyph: kind === 'trash' ? 'trash' : kind === 'move' ? 'scissors' : 'copy',
      // L'opération s'arrête après l'élément en cours ; ce qui est fait reste fait.
      onCancel: () => {
        this.#operations.cancel(id);
      },
    });
    this.#progress = { id, view };
    try {
      return await request(id);
    } finally {
      this.#progress = null;
      view.close();
    }
  }

  #onProgress(event) {
    if (!this.#progress || !event || event.operation !== this.#progress.id || event.state !== 'running') return;
    this.#progress.view.update({ done: event.done, total: event.total, current: typeof event.current === 'string' ? event.current : '' });
  }

  /** Relit le dossier affiché, puis sélectionne les éléments créés, renommés ou collés. */
  async #reveal(paths) {
    await this.#view.reload();
    if (paths.length) this.#view.select(paths);
  }

  /** Annonce le résultat d'une opération longue : notification, ou fenêtre détaillée s'il reste des éléments non traités. */
  async #announce(kind, report, where) {
    const outcome = describeReport(kind, report, where);
    if (outcome.quiet) {
      this.#toasts.show({
        key: 'explorer-files',
        title: outcome.title,
        message: outcome.message,
        glyph: outcome.success ? (kind === 'trash' ? 'trash' : 'check') : 'info',
        timeout: 6000,
      });
      return;
    }
    await this.#dialogs.inform({
      title: outcome.title,
      message: outcome.message,
      details: outcome.details,
      note: outcome.note,
      glyph: 'warning-circle',
      tone: 'warning',
    });
  }

  /** Sélection trop vaste pour une seule demande : annoncée, rien n'est fait. */
  #tooMany(count) {
    if (count <= MAX_ITEMS) return false;
    this.#toasts.show({
      key: 'explorer-files',
      title: 'Sélection trop importante',
      message: `Une opération porte sur ${plural(MAX_ITEMS, 'élément')} au plus : réduisez la sélection, ou traitez le dossier qui contient ces éléments.`,
      glyph: 'info',
      timeout: 8000,
    });
    return true;
  }

  /** Message à afficher : celui de l'application de bureau, rédigé pour l'utilisateur ; jamais un détail interne. */
  #messageOf(error) {
    return error?.name === 'ServiceError' && typeof error.message === 'string' && error.message ? error.message : "L'opération a échoué.";
  }

  #fail(title, error, subject = '') {
    this.#toasts.show({
      key: 'explorer-files',
      title: subject ? `${title} : ${subject}` : title,
      message: this.#messageOf(error),
      glyph: 'warning-circle',
      colors: [...ERROR_COLORS],
      timeout: 8000,
    });
  }
}

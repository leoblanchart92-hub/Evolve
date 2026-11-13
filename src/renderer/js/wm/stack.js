/**
 * Evolve — Pile des fenêtres : qui est devant qui, laquelle est active.
 *
 * Module sans affichage (testé directement avec Node). Il tient, pour des
 * fenêtres désignées par un identifiant :
 *   - l'ordre d'empilement, de l'arrière-plan vers le premier plan ;
 *   - l'ordre d'usage, de la plus récemment activée à la plus ancienne — celui
 *     que parcourt la bascule entre fenêtres (Ctrl + Tab) ;
 *   - les fenêtres réduites, qui gardent leur place dans les deux ordres ;
 *   - la fenêtre active : au premier plan, non réduite — ou aucune, quand le
 *     bureau a été cliqué ou que tout est réduit ;
 *   - l'état « bureau affiché » : toutes les fenêtres réduites d'un geste, et
 *     rétablies par le même geste tant qu'aucune n'a été touchée depuis.
 *
 * Le gestionnaire de fenêtres (window-manager.js) applique cet état à
 * l'affichage ; il n'y a ici ni élément de page, ni animation.
 */

export class WindowStack {
  /** Identifiants, de l'arrière-plan vers le premier plan. */
  #order = [];
  /** Identifiants, de la fenêtre la plus récemment activée à la plus ancienne. */
  #recent = [];
  #minimized = new Set();
  #active = null;
  /** Fenêtres masquées par « afficher le bureau » : { ids, active } ou `null`. */
  #peek = null;

  /** Nombre de fenêtres. */
  get size() {
    return this.#order.length;
  }

  /** Fenêtre active, ou `null`. */
  get active() {
    return this.#active;
  }

  /** Ordre d'empilement (copie), de l'arrière-plan vers le premier plan. */
  get order() {
    return [...this.#order];
  }

  /** Ordre d'usage (copie), de la plus récemment activée à la plus ancienne. */
  get recent() {
    return [...this.#recent];
  }

  /** Vrai tant que « afficher le bureau » peut rétablir les fenêtres qu'il a réduites. */
  get desktopShown() {
    return this.#peek !== null;
  }

  has(id) {
    return this.#order.includes(id);
  }

  isMinimized(id) {
    return this.#minimized.has(id);
  }

  /** Rang d'une fenêtre dans l'empilement (0 : tout au fond), ou -1. */
  rank(id) {
    return this.#order.indexOf(id);
  }

  /** Fenêtres visibles (non réduites), de l'arrière-plan vers le premier plan. */
  visible() {
    return this.#order.filter((id) => !this.#minimized.has(id));
  }

  /** Fenêtre visible la plus en avant, ou `null`. */
  top() {
    return this.visible().at(-1) ?? null;
  }

  /**
   * Ajoute une fenêtre, au premier plan. Elle n'est pas active pour autant :
   * `activate` en décide.
   * @returns {boolean} faux si elle était déjà connue
   */
  add(id) {
    if (this.has(id)) return false;
    this.#order.push(id);
    this.#recent.unshift(id);
    this.#peek = null;
    return true;
  }

  /**
   * Retire une fenêtre (fermeture). Si elle était active, la fenêtre visible
   * la plus en avant le devient.
   * @returns {string|null} la fenêtre active après le retrait
   */
  remove(id) {
    if (!this.has(id)) return this.#active;
    this.#order = this.#order.filter((other) => other !== id);
    this.#recent = this.#recent.filter((other) => other !== id);
    this.#minimized.delete(id);
    if (this.#peek) {
      this.#peek.ids = this.#peek.ids.filter((other) => other !== id);
      if (this.#peek.active === id) this.#peek.active = null;
      if (this.#peek.ids.length === 0) this.#peek = null;
    }
    if (this.#active === id) this.#active = this.#recentVisible();
    if (this.#active) this.#raise(this.#active);
    return this.#active;
  }

  /**
   * Active une fenêtre : elle passe au premier plan, en tête de l'ordre
   * d'usage, et cesse d'être réduite.
   * @returns {boolean} faux si la fenêtre est inconnue
   */
  activate(id) {
    if (!this.has(id)) return false;
    this.#minimized.delete(id);
    this.#raise(id);
    this.#recent = [id, ...this.#recent.filter((other) => other !== id)];
    this.#active = id;
    this.#peek = null;
    return true;
  }

  /** Plus aucune fenêtre n'est active (clic sur le bureau) ; l'empilement ne change pas. */
  deactivate() {
    this.#active = null;
  }

  /**
   * Réduit une fenêtre. Si elle était active, la fenêtre visible utilisée le
   * plus récemment le devient et passe au premier plan.
   * @returns {string|null} la fenêtre active après la réduction
   */
  minimize(id) {
    if (!this.has(id) || this.#minimized.has(id)) return this.#active;
    this.#minimized.add(id);
    this.#peek = null;
    if (this.#active === id) {
      this.#active = this.#recentVisible();
      if (this.#active) this.#raise(this.#active);
    }
    return this.#active;
  }

  /**
   * Bascule « afficher le bureau ». Si des fenêtres sont visibles, toutes sont
   * réduites d'un geste ; sinon, celles que le geste précédent avait réduites
   * sont rétablies, dans le même empilement, avec la même fenêtre active.
   * @returns {{ action: 'hide', ids: string[] } | { action: 'show', ids: string[] } | { action: 'none', ids: [] }}
   *          les fenêtres dont l'état vient de changer
   */
  toggleDesktop() {
    const visible = this.visible();
    if (visible.length > 0) {
      const peek = { ids: visible, active: this.#active };
      for (const id of visible) this.#minimized.add(id);
      this.#active = null;
      this.#peek = peek;
      return { action: 'hide', ids: visible };
    }
    if (this.#peek) {
      const { ids, active } = this.#peek;
      this.#peek = null;
      const restored = ids.filter((id) => this.has(id) && this.#minimized.has(id));
      for (const id of restored) this.#minimized.delete(id);
      this.#active = active && restored.includes(active) ? active : (restored.at(-1) ?? null);
      if (this.#active) this.#raise(this.#active);
      return { action: 'show', ids: restored };
    }
    return { action: 'none', ids: [] };
  }

  /**
   * Fenêtre que désigne la bascule entre fenêtres, `steps` crans après la
   * fenêtre de départ dans l'ordre d'usage (négatif : en sens inverse). Les
   * fenêtres réduites en font partie : les désigner les rétablit. Sans fenêtre
   * de départ (aucune n'est active), le premier cran désigne la plus récente.
   * @param {number} steps
   * @param {string|null} [from]  fenêtre de départ (par défaut : la fenêtre active)
   * @returns {string|null} `null` s'il n'y a aucune fenêtre
   */
  cycle(steps, from = this.#active) {
    const count = this.#recent.length;
    if (count === 0) return null;
    const known = from !== null && this.#recent.includes(from);
    const start = known ? this.#recent.indexOf(from) : steps > 0 ? -1 : 0;
    const index = (((start + steps) % count) + count) % count;
    return this.#recent[index];
  }

  #raise(id) {
    this.#order = [...this.#order.filter((other) => other !== id), id];
  }

  #recentVisible() {
    return this.#recent.find((id) => !this.#minimized.has(id)) ?? null;
  }
}

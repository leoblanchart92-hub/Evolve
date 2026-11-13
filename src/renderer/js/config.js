/**
 * Evolve — Configuration générale de l'interface.
 * Le nom du produit est centralisé ici : il suffit de le modifier à un seul
 * endroit pour renommer l'environnement dans toute l'interface.
 */

export const PRODUCT = Object.freeze({
  name: 'Evolve',
  version: '0.4.1',
  stage: "Aperçu de l'interface",
  userName: 'Utilisateur',
});

/** Durées (ms) partagées entre le CSS et le JavaScript. */
export const TIMING = Object.freeze({
  bootMin: 1100,
  toast: 4200,
  tooltipDelay: 450,
  hardwareTick: 1000,
});

/**
 * Fond d'écran officiel du projet (image fournie, jamais modifiée).
 * L'adresse est résolue par rapport à ce module : elle fonctionne aussi bien
 * dans l'application de bureau que dans l'aperçu navigateur.
 */
export const WALLPAPER_URL = new URL(
  '../../../assets/wallpapers/panorama-cosmique-violet-sur-lac-miroir.png',
  import.meta.url,
).href;

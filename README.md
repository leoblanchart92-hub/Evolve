# Evolve

**Evolve** est un environnement de bureau au style néon violet : bureau, barre des tâches, menu Démarrer, fenêtres, explorateur de fichiers.

Cette version 0.2.0 est un **aperçu de l'interface graphique**, qui retient désormais vos réglages d'un lancement à l'autre. Elle prend la forme d'un simple fichier `.exe` portable pour Windows : il s'ouvre comme une application ordinaire, sans installation, et ne modifie aucun réglage de Windows. Ce qu'il écrit sur le PC se limite à un petit fichier de réglages et à des fichiers temporaires, [détaillés plus bas](#ce-quevolve-fait--et-ne-fait-pas--sur-votre-pc).

![Le bureau d'Evolve : fond d'écran, icônes, widgets et barre des tâches](docs/captures/bureau.jpg)

| Menu Démarrer | Fenêtres et explorateur de fichiers |
| :---: | :---: |
| ![Le menu Démarrer d'Evolve](docs/captures/menu-demarrer.jpg) | ![Deux fenêtres ouvertes dans Evolve](docs/captures/fenetres.jpg) |

## Sommaire

- [Télécharger et lancer Evolve](#télécharger-et-lancer-evolve)
- [Ce qu'Evolve fait — et ne fait pas — sur votre PC](#ce-quevolve-fait--et-ne-fait-pas--sur-votre-pc)
- [Vos réglages](#vos-réglages)
- [Ce que contient cet aperçu](#ce-que-contient-cet-aperçu)
- [Raccourcis utiles](#raccourcis-utiles)
- [Vérifications automatiques](#vérifications-automatiques)
- [Limites connues](#limites-connues)
- [Développement](#développement)
- [Crédits et licences](#crédits-et-licences)

## Télécharger et lancer Evolve

L'exécutable est fabriqué automatiquement par GitHub à chaque modification du code.

1. Connectez-vous à GitHub, puis ouvrez la page **[Actions → Exécutable Windows](https://github.com/leoblanchart92-hub/Evolve/actions/workflows/build-windows.yml)**.
2. Cliquez sur l'exécution la plus récente marquée d'une coche verte.
3. En bas de la page, dans la rubrique **Artifacts**, cliquez sur **`Evolve-0.2.0-portable.exe`** : le fichier (environ 140 Mo) se télécharge tel quel, sans archive à décompresser.
4. Double-cliquez sur le fichier téléchargé. Evolve s'ouvre en plein écran.

À savoir :

- **Avertissement de Windows.** Le fichier n'est pas signé numériquement (une signature est payante). Le navigateur peut donc signaler un fichier « rarement téléchargé », et Windows afficher « Windows a protégé votre ordinateur » : cliquez sur *Informations complémentaires*, puis sur *Exécuter quand même*.
- **Démarrage.** Au lancement, le fichier se décompresse dans le dossier temporaire avant d'afficher quoi que ce soit : comptez quelques secondes sans rien à l'écran. Il est inutile de le lancer une seconde fois.
- **Quitter.** Menu Démarrer → bouton d'alimentation (en bas à droite du menu) → *Quitter Evolve*, ou `Alt` + `F4`.
- **Durée de disponibilité.** GitHub conserve chaque exécutable 90 jours. Passé ce délai, il suffit d'une nouvelle compilation pour en obtenir un autre.

Configuration requise : Windows 10 ou 11, 64 bits.

## Ce qu'Evolve fait — et ne fait pas — sur votre PC

| Engagement | En pratique |
| --- | --- |
| **Aucune installation** | Rien n'est ajouté au menu Démarrer de Windows, au bureau, à la liste des programmes ni au démarrage de l'ordinateur. Pour « désinstaller » Evolve, supprimez le fichier `.exe` et, si vous avez modifié des réglages, le dossier `%APPDATA%\Evolve`. |
| **Aucun droit administrateur** | Evolve s'exécute avec les droits de l'utilisateur et ne déclenche jamais la demande d'élévation de Windows. Ce point est contrôlé à chaque compilation. |
| **Aucun fichier personnel lu ou modifié** | L'explorateur de fichiers présente un contenu d'exemple, fictif. Vos documents ne sont ni parcourus, ni affichés, ni modifiés. |
| **Aucun réglage de Windows modifié** | Les paramètres rapides (Wi-Fi, Bluetooth, volume, luminosité…) sont purement visuels : ils n'agissent que sur l'interface d'Evolve, qui retient leur position sans rien changer à Windows. |
| **Un seul dossier dans votre profil** | Evolve n'y range que vos réglages : le fichier `%APPDATA%\Evolve\settings.json` (voir [Vos réglages](#vos-réglages)). Il n'est créé qu'au premier réglage modifié : tant que vous ne changez rien, Evolve n'écrit rien dans votre profil. Ces deux points sont contrôlés à chaque compilation. |
| **Aucune mesure réelle du matériel** | Les widgets processeur, mémoire et carte graphique affichent des valeurs simulées, signalées par la mention « DÉMO ». |
| **Aucune connexion réseau** | L'interface est entièrement locale ; toute requête vers Internet y est bloquée. |

**Fichiers temporaires.** En dehors du fichier de réglages décrit ci-dessous, Evolve n'utilise que le dossier temporaire de Windows (`%TEMP%`) :

| Dossier dans `%TEMP%` | Contenu | Taille | Durée de vie |
| --- | --- | --- | --- |
| `Evolve-portable` | l'application décompressée | environ 315 Mo | créé au lancement, supprimé à la fermeture |
| `ns….tmp` (nom variable) | dossier de travail du lanceur | moins de 1 Mo | créé au lancement, supprimé à la fermeture |
| `Evolve` | cache technique du moteur d'affichage | environ 3 Mo | conservé d'un lancement à l'autre |

Ces dossiers peuvent être supprimés sans risque lorsqu'Evolve est fermé. Leur taille et leur suppression à la fermeture sont relevées à chaque compilation (voir [Vérifications automatiques](#vérifications-automatiques)).

## Vos réglages

Evolve retient d'un lancement à l'autre :

- l'affichage des **widgets** et des **icônes du bureau** (affichés ou masqués) ;
- la position des **paramètres rapides** : Wi-Fi, Bluetooth, mode avion, économie d'énergie, éclairage nocturne, « Ne pas déranger », luminosité, volume et son coupé.

Ils sont rangés dans le dossier `%APPDATA%\Evolve` — c'est-à-dire `C:\Users\<votre nom>\AppData\Roaming\Evolve` ; pour l'ouvrir, collez `%APPDATA%\Evolve` dans la barre d'adresse de l'explorateur de Windows.

| Fichier dans `%APPDATA%\Evolve` | Contenu | Durée de vie |
| --- | --- | --- |
| `settings.json` | les réglages que vous avez modifiés, en texte lisible (moins de 1 Ko) | créé au premier réglage modifié, conservé ensuite |
| `settings.corrupt.json` | copie d'un fichier de réglages devenu inutilisable | n'existe qu'après un incident (voir ci-dessous) |
| `settings.json.tmp` | enregistrement en cours | un instant, pendant l'enregistrement |

À savoir :

- **Enregistrement.** Un réglage modifié est enregistré dans la seconde qui suit ; un changement encore en attente l'est à la fermeture d'Evolve ou à l'extinction de Windows. Le fichier est remplacé en une seule opération, pour qu'une coupure de courant laisse soit l'ancienne version, soit la nouvelle, et non un fichier tronqué.
- **Revenir aux réglages d'origine.** Fermez Evolve, puis supprimez `settings.json` (ou le dossier `%APPDATA%\Evolve` entier).
- **Fichier endommagé.** Si `settings.json` est devenu inutilisable (modification à la main, disque défaillant), Evolve démarre avec les réglages d'origine, vous en informe, et met le fichier de côté sous le nom `settings.corrupt.json` au lieu de le perdre. Une valeur isolée invalide reprend simplement sa valeur d'origine.
- **Fichier inaccessible.** Si le fichier ne peut pas être lu ou écrit (droits insuffisants, disque plein), Evolve fonctionne normalement et vous prévient que vos changements risquent de ne pas être conservés. Un fichier qu'il n'a pas pu lire n'est jamais écrasé.
- **Changement de version.** Les réglages enregistrés par une version plus récente d'Evolve ne sont pas perdus si vous relancez une version plus ancienne : ceux qu'elle ne connaît pas sont conservés tels quels.

Avec l'option `--settings-dir=DOSSIER` (voir [Raccourcis utiles](#raccourcis-utiles)), les réglages sont rangés dans le dossier de votre choix plutôt que dans votre profil. Un chemin relatif part du dossier où se trouve le fichier `.exe` : `--settings-dir=reglages` range ainsi les réglages à côté de lui, par exemple sur une clé USB.

## Ce que contient cet aperçu

- **Bureau** — fond d'écran officiel du projet, icônes (double-clic pour ouvrir), menu contextuel au clic droit.
- **Barre des tâches** — bouton Démarrer, recherche, applications épinglées avec témoin d'activité, zone de notification, horloge ; clic droit sur une application pour la réduire ou la fermer.
- **Menu Démarrer** — applications épinglées, liste de toutes les applications, éléments recommandés et recherche instantanée (applications, fichiers d'exemple, paramètres).
- **Paramètres rapides** et **centre de notifications** avec calendrier.
- **Widgets** — horloge, processeur, mémoire et carte graphique (valeurs de démonstration), masquables depuis le bouton *Widgets*.
- **Fenêtres** — déplacement, redimensionnement par les bords et les coins, agrandissement, réduction dans la barre des tâches, superposition de plusieurs fenêtres.
- **Explorateur de fichiers** — navigation dans une arborescence d'exemple, volet latéral, affichage en grille ou en liste, tri, filtre, sélection multiple, navigation au clavier.
- **Adaptation à l'écran** — de 1024 × 768 à la 4K ; les animations sont réduites si Windows est réglé pour les limiter.

Les autres applications (Navigateur, Paramètres, Terminal…) ouvrent pour l'instant une fenêtre d'attente : elles feront l'objet des prochaines étapes.

## Raccourcis utiles

| Action | Raccourci |
| --- | --- |
| Quitter Evolve | `Alt` + `F4` |
| Basculer le plein écran | `F11` |
| Fermer un menu ou un panneau | `Échap` |
| Chercher depuis le menu Démarrer | ouvrir le menu, puis taper directement |
| Agrandir ou restaurer une fenêtre | double-clic sur sa barre de titre |
| Explorateur : précédent, suivant, dossier parent | `Alt` + `←`, `Alt` + `→`, `Alt` + `↑` |

Le fichier `.exe` accepte aussi des options, à ajouter après son nom dans une invite de commandes ou dans un raccourci :

| Option | Effet |
| --- | --- |
| `--windowed` | démarre dans une fenêtre plutôt qu'en plein écran |
| `--devtools` | autorise les outils de développement (touche `F12`) |
| `--settings-dir=DOSSIER` | range les réglages dans `DOSSIER` au lieu de `%APPDATA%\Evolve` ; le dossier est créé au premier réglage modifié (voir [Vos réglages](#vos-réglages)) |
| `--self-test` | lance l'auto-test décrit ci-dessous, puis quitte ; le rapport est enregistré dans un dossier `self-test-output` créé à côté du fichier `.exe`. Pendant l'auto-test, les réglages restent en mémoire : vos réglages ne sont ni lus ni modifiés |
| `--self-test-scenario=NOM` | avec `--self-test`, choisit ce qui est contrôlé : `full` (par défaut, le contrôle complet), ou `settings-write` puis `settings-read`, les deux lancements de la vérification des réglages décrite ci-dessous (ils exigent `--settings-dir`) |
| `--status-file=FICHIER` | une fois l'interface démarrée, écrit dans `FICHIER` l'état de la fenêtre et enregistre à côté l'image affichée ; sert à la vérification du lancement décrite ci-dessous |

## Vérifications automatiques

Evolve ne pouvant pas être essayé à la main à chaque modification, la compilation ([`.github/workflows/build-windows.yml`](.github/workflows/build-windows.yml)) contrôle elle-même le résultat, sur une machine Windows de GitHub :

1. **Tests automatiques** du code (`npm test`).
2. **Fabrication** du fichier `.exe` portable.
3. **Droits demandés** : lecture du manifeste de l'exécutable, qui doit indiquer le niveau `asInvoker` (aucun droit administrateur).
4. **Auto-test** : le `.exe` est réellement lancé avec l'option `--self-test`. L'application vérifie alors son propre affichage — fond d'écran identique à l'image d'origine, polices, barre des tâches, menu Démarrer, recherche, panneaux, fenêtres, explorateur, services joignables depuis l'interface, absence d'erreur — et enregistre un rapport accompagné de captures d'écran.
5. **Lancement normal** : le `.exe` est lancé une seconde fois, sans option d'essai, comme par un double-clic. Un contrôle extérieur vérifie que la fenêtre s'ouvre en plein écran et couvre tout l'écran, compare une capture de l'écran à l'image dessinée par l'application, puis demande la fermeture comme le ferait `Alt` + `F4` : l'application doit se fermer sans erreur. Il vérifie aussi que les réglages sont bien destinés à `%APPDATA%\Evolve\settings.json` et que ce lancement, où aucun réglage n'est modifié, n'a rien écrit dans le profil de l'utilisateur : ni fichier, ni dossier. L'espace occupé dans le dossier temporaire, et ce qu'il en reste après la fermeture, sont relevés.
6. **Réglages et redémarrage** : le `.exe` est lancé deux fois de suite sur le véritable dossier `%APPDATA%\Evolve` de la machine. Au premier lancement, l'application modifie cinq réglages depuis son interface, par les mêmes boutons et curseurs qu'un utilisateur, puis se ferme. Le contrôle lit alors lui-même `settings.json` : le fichier doit exister, être seul dans son dossier et contenir exactement ces cinq réglages. Au second lancement, l'interface doit les afficher sans aucune action — widgets masqués, éclairage nocturne et « Ne pas déranger » activés, luminosité et volume réglés —, et relire le fichier ne doit pas le modifier. Le fichier est ensuite retiré de la machine.

Le fichier `.exe` n'est publié que si toutes ces étapes réussissent. Les rapports et les captures d'écran sont joints à chaque exécution, dans l'artefact `auto-test` ; l'essentiel est résumé en tête de la page de l'exécution.

## Limites connues

- Cet aperçu est une application qui *ressemble* à un environnement de bureau : il ne remplace pas le bureau de Windows et ne lance pas de vrais programmes.
- Seul l'explorateur de fichiers est fonctionnel, sur un contenu d'exemple ; ses actions sur les fichiers (nouveau, renommer, supprimer…) ne sont pas encore disponibles.
- Les paramètres rapides sont retenus, mais restent visuels : ils ne règlent ni le Wi-Fi, ni le son, ni la luminosité de Windows.
- Si Evolve est fermé en mode avion, quitter ce mode après le redémarrage réactive le Wi-Fi et le Bluetooth tous les deux, même si l'un d'eux était désactivé avant le mode avion : cet état antérieur n'est pas retenu.
- Les fenêtres ouvertes, leur position et le dossier affiché par l'explorateur ne sont pas retenus d'un lancement à l'autre.
- L'interface est en français uniquement.
- L'exécutable n'est pas signé (voir l'avertissement de Windows ci-dessus) et n'existe que pour Windows 64 bits.
- Si Evolve est interrompu brutalement (gestionnaire des tâches, coupure de courant), des fichiers temporaires peuvent subsister dans `%TEMP%` (dossiers `Evolve-portable` et `ns….tmp`). Ils peuvent être supprimés à la main. Un réglage modifié dans la seconde qui précède l'interruption peut ne pas avoir été enregistré.

## Développement

Prérequis : [Node.js](https://nodejs.org) 22.12 ou plus récent.

```bash
npm ci                 # installe les dépendances (Electron, electron-builder)
npm start              # lance Evolve en plein écran
npm run start:windowed # lance Evolve dans une fenêtre
npm run preview        # aperçu de l'interface dans un navigateur (http://localhost:4173)
npm test               # tests automatiques
npm run build:win      # fabrique dist/Evolve-<version>-portable.exe (sous Windows)
npm run check:manifest # vérifie que l'exécutable ne demande aucun droit administrateur
npm run check:exe      # lance l'auto-test de l'exécutable fabriqué
npm run check:launch   # lance l'exécutable normalement et vérifie plein écran, affichage et fermeture
npm run check:settings # lance l'exécutable deux fois et vérifie que les réglages sont conservés
npm run check:dev      # lance l'auto-test de la version de développement
npm run icons          # régénère la planche de pictogrammes
```

L'interface est écrite en HTML, CSS et JavaScript, sans bibliothèque ni étape de compilation ; [Electron](https://www.electronjs.org) l'affiche dans une fenêtre de bureau.

Tout ce qui touche à l'ordinateur passe par une **couche de services** (`src/services/`), indépendante d'Electron comme de l'interface. Chaque service s'inscrit auprès d'un point d'accès unique (`hub.js`) en déclarant ses méthodes publiques et ses événements ; l'interface, isolée dans un bac à sable, ne peut qu'appeler ces méthodes par leur nom (`services.call('settings', 'set', …)`) et recevoir ces événements — elle n'a accès ni aux fichiers ni au système. Le premier service est celui des réglages ; les suivants s'ajouteront de la même façon, sans modifier ni la passerelle ni la fenêtre.

```text
assets/          fond d'écran, polices, icône de l'application
src/main/        application de bureau (Electron) : fenêtre, sécurité, auto-test
src/services/    services : point d'accès, réglages (schéma, fichier, emplacement)
src/renderer/    interface : page, feuilles de style et modules JavaScript
  js/core/       outils communs (DOM, formats, horloge, pictogrammes, accès aux services)
  js/shell/      bureau, barre des tâches, menu Démarrer, panneaux
  js/wm/         gestionnaire de fenêtres
  js/widgets/    widgets matériels (processeur, mémoire, carte graphique)
  js/apps/       applications (explorateur de fichiers)
  js/data/       applications et contenus de démonstration
scripts/         outils : aperçu, pictogrammes, vérifications de l'exécutable
tests/           tests automatiques
packaging/       icône de l'exécutable
```

Le nom du produit et son numéro de version affichés dans l'interface sont définis dans [`src/renderer/js/config.js`](src/renderer/js/config.js).

## Crédits et licences

- Fond d'écran : image fournie par l'auteur du projet, intégrée sans aucune modification.
- Pictogrammes : [Phosphor Icons](https://phosphoricons.com) (licence MIT).
- Polices : [Inter](https://github.com/rsms/inter) et [Outfit](https://github.com/Outfitio/Outfit-Fonts) (SIL Open Font License 1.1).
- Moteur : [Electron](https://www.electronjs.org) ; exécutable portable fabriqué avec [electron-builder](https://www.electron.build).

Le détail des licences figure dans [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

# Evolve

**Evolve** est un environnement de bureau au style néon violet : bureau, barre des tâches, menu Démarrer, fenêtres, explorateur de fichiers.

Cette version 0.3.1 reste un **aperçu de l'interface graphique**, avec une première fonction réelle : son **explorateur de fichiers affiche désormais les vrais dossiers de votre ordinateur, en lecture seule** — il ne crée, ne modifie, ne déplace, ne supprime et n'ouvre aucun fichier. Evolve prend la forme d'un simple fichier `.exe` portable pour Windows : il s'ouvre comme une application ordinaire, sans installation, et ne modifie aucun réglage de Windows. Ce qu'il écrit sur le PC se limite à un petit fichier de réglages et à des fichiers temporaires, [détaillés plus bas](#ce-quevolve-fait--et-ne-fait-pas--sur-votre-pc).

![Le bureau d'Evolve : fond d'écran, icônes, widgets et barre des tâches](docs/captures/bureau.jpg)

| Menu Démarrer | Explorateur de fichiers |
| :---: | :---: |
| ![Le menu Démarrer d'Evolve](docs/captures/menu-demarrer.jpg) | ![L'explorateur de fichiers d'Evolve, en vue « Détails »](docs/captures/explorateur.jpg) |

*Captures réalisées sur un disque de démonstration.*

## Sommaire

- [Télécharger et lancer Evolve](#télécharger-et-lancer-evolve)
- [Ce qu'Evolve fait — et ne fait pas — sur votre PC](#ce-quevolve-fait--et-ne-fait-pas--sur-votre-pc)
- [L'explorateur de fichiers](#lexplorateur-de-fichiers)
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
3. En bas de la page, dans la rubrique **Artifacts**, cliquez sur **`Evolve-0.3.1-portable.exe`** : le fichier (environ 140 Mo) se télécharge tel quel, sans archive à décompresser.
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
| **Vos fichiers : consultés, jamais modifiés** | L'explorateur affiche le contenu des dossiers que vous ouvrez — noms, types, tailles, dates — sans jamais lire le contenu d'un fichier. Il ne crée, ne modifie, ne déplace, ne supprime et n'ouvre rien : ces opérations n'existent pas dans le programme. Un dossier personnel absent — Documents compris — est annoncé comme introuvable, jamais recréé. Ce que vous consultez n'est ni enregistré ni transmis (voir [L'explorateur de fichiers](#lexplorateur-de-fichiers)). Ces points sont contrôlés à chaque compilation. |
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

## L'explorateur de fichiers

L'explorateur d'Evolve parcourt les vrais dossiers de l'ordinateur, **en lecture seule**.

Ce qu'il affiche :

- **Accueil** et **Ce PC** — vos six dossiers personnels (Bureau, Documents, Téléchargements, Images, Musique, Vidéos), là où Windows les range réellement, même déplacés vers OneDrive, et les lecteurs locaux avec leur espace libre.
- **Le contenu de chaque dossier** — nom, type, taille et date de modification, en grandes icônes ou en vue « Détails », triable par colonne.
- **La navigation habituelle** — double-clic, fil d'Ariane cliquable (les premiers dossiers d'un long chemin se replient dans « … »), précédent, suivant, dossier parent, actualisation, recherche dans le dossier affiché, sélection et déplacement au clavier.
- **Les éléments masqués** — fichiers du système, `AppData`, `desktop.ini`… restent cachés, comme dans l'Explorateur de Windows ; *Affichage → Éléments masqués* les montre, estompés.

Ce qu'il ne fait pas, par construction :

- **Aucune opération sur les fichiers.** Les boutons *Nouveau*, *Couper*, *Copier*, *Renommer*, *Supprimer*… sont présents, mais annoncent seulement que l'opération arrivera dans une prochaine étape. Un double-clic sur un fichier ne l'ouvre pas.
- **Aucune lecture du contenu des fichiers.** Le service qui lit les dossiers ([`src/services/files.js`](src/services/files.js)) ne répond qu'à deux demandes — la liste des emplacements et le contenu d'un dossier — et n'utilise que quatre fonctions de lecture du système : ouvrir un dossier, lire les propriétés d'un élément, résoudre un chemin, lire la capacité d'un lecteur.
- **Rien en dehors des emplacements autorisés** : les six dossiers personnels et les lecteurs locaux. Chaque chemin demandé est contrôlé avant tout accès au disque : chemins relatifs, remontées (`..`), partages réseau (`\\serveur\…`) et chemins spéciaux de Windows sont refusés. Un lien ou une jonction qui mène hors de ces emplacements n'est pas suivi.
- **Aucune création de dossier.** Si l'un de vos dossiers personnels n'existe pas, ou plus — Documents, par exemple, supprimé ou resté sur un disque débranché —, sa tuile est estompée et son ouverture affiche « Dossier « Documents » introuvable », en précisant que rien n'a été modifié. Evolve ne le recrée pas : un dossier absent reste absent. Si vous le remettez en place, *Actualiser* le fait réapparaître — à défaut, fermez puis rouvrez Evolve.
- **Aucune demande de droits.** Un dossier protégé par Windows affiche « Accès refusé » ; un dossier supprimé entre-temps ou un lecteur retiré, « Dossier introuvable » ou « Emplacement indisponible ». Dans tous les cas, la navigation continue.

Ce qui le distingue encore de l'Explorateur de Windows est détaillé dans les [limites connues](#limites-connues).

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
- **Menu Démarrer** — applications épinglées, liste de toutes les applications, éléments recommandés (des exemples) et recherche instantanée : applications, dossiers personnels, fichiers d'exemple, paramètres.
- **Paramètres rapides** et **centre de notifications** avec calendrier.
- **Widgets** — horloge, processeur, mémoire et carte graphique (valeurs de démonstration), masquables depuis le bouton *Widgets*.
- **Fenêtres** — déplacement, redimensionnement par les bords et les coins, agrandissement, réduction dans la barre des tâches, superposition de plusieurs fenêtres.
- **Explorateur de fichiers** — vos vrais dossiers, en lecture seule : dossiers personnels et lecteurs, volet latéral, grandes icônes ou vue « Détails », tri, recherche dans le dossier, sélection multiple, navigation au clavier (voir [L'explorateur de fichiers](#lexplorateur-de-fichiers)).
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
| Explorateur : actualiser le dossier affiché | `F5` |
| Explorateur : rechercher dans le dossier affiché | `Ctrl` + `F` |

Le fichier `.exe` accepte aussi des options, à ajouter après son nom dans une invite de commandes ou dans un raccourci :

| Option | Effet |
| --- | --- |
| `--windowed` | démarre dans une fenêtre plutôt qu'en plein écran |
| `--devtools` | autorise les outils de développement (touche `F12`) |
| `--settings-dir=DOSSIER` | range les réglages dans `DOSSIER` au lieu de `%APPDATA%\Evolve` ; le dossier est créé au premier réglage modifié (voir [Vos réglages](#vos-réglages)) |
| `--self-test` | lance l'auto-test décrit ci-dessous, puis quitte ; le rapport, les captures d'écran et le petit dossier d'essai de l'explorateur sont enregistrés dans un dossier `self-test-output` créé à côté du fichier `.exe`. Pendant l'auto-test, les réglages restent en mémoire : vos réglages ne sont ni lus ni modifiés |
| `--self-test-scenario=NOM` | avec `--self-test`, choisit ce qui est contrôlé : `full` (par défaut, le contrôle complet), ou `settings-write` puis `settings-read`, les deux lancements de la vérification des réglages décrite ci-dessous (ils exigent `--settings-dir`) |
| `--status-file=FICHIER` | une fois l'interface démarrée, écrit dans `FICHIER` l'état de la fenêtre et enregistre à côté l'image affichée ; sert à la vérification du lancement décrite ci-dessous |

## Vérifications automatiques

Evolve ne pouvant pas être essayé à la main à chaque modification, la compilation ([`.github/workflows/build-windows.yml`](.github/workflows/build-windows.yml)) contrôle elle-même le résultat, sur une machine Windows de GitHub :

1. **Tests automatiques** du code (`npm test`).
2. **Fabrication** du fichier `.exe` portable.
3. **Droits demandés** : lecture du manifeste de l'exécutable, qui doit indiquer le niveau `asInvoker` (aucun droit administrateur).
4. **Auto-test** : le `.exe` est réellement lancé avec l'option `--self-test`. L'application vérifie alors son propre affichage — fond d'écran identique à l'image d'origine, polices, barre des tâches, menu Démarrer, recherche, panneaux, fenêtres, services joignables depuis l'interface, absence d'erreur — et enregistre un rapport accompagné de captures d'écran. Elle met aussi l'**explorateur** à l'épreuve sur de vrais dossiers : elle crée un petit dossier d'essai dans son dossier de résultats, s'y rend comme le ferait un utilisateur (« Ce PC », le lecteur, puis chaque dossier au double-clic) et contrôle les noms, les types, les tailles et les dates affichés, la navigation, l'actualisation, puis le message « Dossier introuvable » devant un dossier supprimé entre-temps. Devant un dossier protégé de Windows, elle attend « Accès refusé » ; sur la machine de GitHub, dont le compte peut tout lire, aucun dossier ne refuse l'accès : ce contrôle-là y est omis (un avertissement le signale dans le rapport), et le refus d'accès n'est vérifié que par les tests automatiques, sur un disque simulé. Elle présente ensuite au service de fichiers des chemins interdits et des demandes d'écriture, qui doivent tous être refusés, et vérifie pour finir que rien n'a changé dans le dossier parcouru.
5. **Lancement normal** : le `.exe` est lancé une seconde fois, sans option d'essai, comme par un double-clic. Un contrôle extérieur vérifie que la fenêtre s'ouvre en plein écran et couvre tout l'écran, compare une capture de l'écran à l'image dessinée par l'application, puis demande la fermeture comme le ferait `Alt` + `F4` : l'application doit se fermer sans erreur. Il vérifie aussi que les réglages sont bien destinés à `%APPDATA%\Evolve\settings.json` et que ce lancement, où aucun réglage n'est modifié, n'a rien écrit dans le profil de l'utilisateur : ni fichier, ni dossier. L'espace occupé dans le dossier temporaire, et ce qu'il en reste après la fermeture, sont relevés.
6. **Réglages et redémarrage** : le `.exe` est lancé deux fois de suite sur le véritable dossier `%APPDATA%\Evolve` de la machine. Au premier lancement, l'application modifie cinq réglages depuis son interface, par les mêmes boutons et curseurs qu'un utilisateur, puis se ferme. Le contrôle lit alors lui-même `settings.json` : le fichier doit exister, être seul dans son dossier et contenir exactement ces cinq réglages. Au second lancement, l'interface doit les afficher sans aucune action — widgets masqués, éclairage nocturne et « Ne pas déranger » activés, luminosité et volume réglés —, et relire le fichier ne doit pas le modifier. Le fichier est ensuite retiré de la machine.
7. **Dossier Documents absent** : le dossier Documents du compte de la machine est mis de côté — renommé, sans que son contenu soit touché —, de sorte que Windows n'en connaît plus aucun. Le `.exe` est alors lancé et ouvre ce dossier comme le ferait un utilisateur, depuis l'accueil de l'explorateur, le volet latéral puis l'icône du bureau : il doit afficher chaque fois « Dossier « Documents » introuvable », y compris après *Actualiser*, et la navigation doit continuer. Le contrôle constate ensuite lui-même, sur le disque, que le dossier est toujours absent, que rien n'est apparu à côté de lui et que le contenu mis de côté est intact, puis il remet le dossier en place.

Le fichier `.exe` n'est publié que si toutes ces étapes réussissent. Les rapports et les captures d'écran sont joints à chaque exécution, dans l'artefact `auto-test` ; l'essentiel est résumé en tête de la page de l'exécution.

## Limites connues

- Cet aperçu est une application qui *ressemble* à un environnement de bureau : il ne remplace pas le bureau de Windows et ne lance pas de vrais programmes.
- Seul l'explorateur de fichiers est fonctionnel, et **en lecture seule** : il n'ouvre aucun fichier et n'effectue aucune opération (nouveau, copier, renommer, supprimer…).
- L'explorateur diffère encore de celui de Windows :
  - les dossiers portent leur nom réel sur le disque (« Users », « Program Files ») et non leur nom traduit (« Utilisateurs », « Programmes ») ; seuls les six dossiers personnels sont présentés sous leur nom français ;
  - les éléments masqués sont reconnus à leur nom et à leur emplacement, l'attribut « caché » de Windows n'étant pas lisible ici : un fichier que vous avez masqué vous-même reste affiché ;
  - les lecteurs réseau, les partages (`\\serveur\…`), les lecteurs virtuels (`subst`), les lecteurs amovibles vides et les volumes verrouillés ne sont pas listés ; « Réseau » et « Corbeille » sont annoncés comme non disponibles ;
  - un dossier de plus de 5 000 éléments n'affiche que les 5 000 premiers, et le signale ;
  - la recherche ne porte que sur le dossier affiché, pas sur ses sous-dossiers ; il n'y a ni miniatures d'images, ni saisie d'un chemin au clavier ;
  - un lecteur qui met plus de deux secondes à répondre n'apparaît qu'après *Actualiser* ; si plusieurs lettres de lecteur désignent des serveurs injoignables, les lecteurs des lettres suivantes n'apparaissent qu'une fois que Windows a renoncé à joindre ces serveurs ;
  - un dossier personnel absent, puis remis en place pendant qu'Evolve fonctionne, doit réapparaître après *Actualiser* : ce retour est contrôlé par les tests automatiques, mais il ne l'est pas sur une vraie machine Windows, contrairement à l'absence de toute création de dossier ; s'il n'apparaît pas, fermez puis rouvrez Evolve.
- Les fichiers « recommandés » du menu Démarrer et ceux que propose sa recherche restent des exemples fictifs, signalés comme tels ; seuls les dossiers personnels y mènent à un vrai dossier.
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
npm run check:documents # vérifie qu'un dossier Documents absent n'est pas recréé (machine de compilation uniquement)
npm run check:dev      # lance l'auto-test de la version de développement
npm run icons          # régénère la planche de pictogrammes
```

L'interface est écrite en HTML, CSS et JavaScript, sans bibliothèque ni étape de compilation ; [Electron](https://www.electronjs.org) l'affiche dans une fenêtre de bureau.

Tout ce qui touche à l'ordinateur passe par une **couche de services** (`src/services/`), indépendante d'Electron comme de l'interface. Chaque service s'inscrit auprès d'un point d'accès unique (`hub.js`) en déclarant ses méthodes publiques et ses événements ; l'interface, isolée dans un bac à sable, ne peut qu'appeler ces méthodes par leur nom (`services.call('settings', 'set', …)`) et recevoir ces événements — elle n'a accès ni aux fichiers ni au système. Deux services existent : les réglages (`settings`) et la consultation des dossiers, en lecture seule (`files`) ; les suivants s'ajouteront de la même façon, sans modifier ni la passerelle ni la fenêtre.

L'emplacement des dossiers personnels est demandé au moteur par [`src/main/personal-folders.js`](src/main/personal-folders.js), qui ne lui pose que des questions sans effet sur le disque. Le moteur crée en effet le dossier Documents absent dès qu'il en obtient le chemin. Sous Windows, il ne l'obtient pas : le système vérifie d'abord que le dossier existe, et répond par une erreur s'il est absent. Sur les autres systèmes (développement), le chemin lui est donné sans vérification : la question n'est donc jamais posée, et Evolve désigne lui-même le dossier `Documents` du compte. Un emplacement obtenu n'est plus redemandé de la session ; seul un dossier resté introuvable l'est de nouveau, à chaque actualisation.

```text
assets/          fond d'écran, polices, icône de l'application
src/main/        application de bureau (Electron) : fenêtre, sécurité, auto-test
src/services/    services : point d'accès, réglages (schéma, fichier, emplacement), consultation des dossiers
src/renderer/    interface : page, feuilles de style et modules JavaScript
  js/core/       outils communs (DOM, formats, horloge, pictogrammes, accès aux services)
  js/shell/      bureau, barre des tâches, menu Démarrer, panneaux
  js/wm/         gestionnaire de fenêtres
  js/widgets/    widgets matériels (processeur, mémoire, carte graphique)
  js/apps/       applications (explorateur de fichiers : affichage, navigation)
  js/data/       applications et contenus de démonstration (menu Démarrer, notifications)
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

# Composants tiers

Evolve intègre ou utilise les composants ci-dessous. Chacun reste soumis à sa
propre licence, reproduite ou référencée ici.

| Composant | Rôle dans Evolve | Licence | Présent dans l'exécutable |
| --- | --- | --- | --- |
| [Phosphor Icons](https://phosphoricons.com) 2.1.1 | Pictogrammes de l'interface | MIT | Oui (`src/renderer/js/core/icons.data.js`) |
| [Inter](https://github.com/rsms/inter) | Police des textes | SIL Open Font License 1.1 | Oui (`assets/fonts/inter/`) |
| [Outfit](https://github.com/Outfitio/Outfit-Fonts) | Police des titres et des chiffres | SIL Open Font License 1.1 | Oui (`assets/fonts/outfit/`) |
| [Electron](https://www.electronjs.org) 45 (Chromium, Node.js) | Moteur de l'application de bureau | MIT, BSD et autres | Oui |
| [electron-builder](https://www.electron.build) 26 | Fabrication de l'exécutable portable | MIT | Non (outil de compilation) |
| [NSIS](https://nsis.sourceforge.io) et ses modules System et [StdUtils](https://github.com/lordmulder/stdutils) | Lanceur du fichier `.exe` : décompresse l'application puis la démarre | zlib/libpng (NSIS, System), GNU LGPL 2.1 (StdUtils, copie non modifiée) | Oui (ajoutés par electron-builder) |

Le fond d'écran (`assets/wallpapers/panorama-cosmique-violet-sur-lac-miroir.png`)
est l'image fournie par l'auteur du projet ; elle est intégrée sans aucune
modification. Le logo et l'icône d'Evolve (`assets/icons/`) ont été dessinés
pour le projet.

---

## Phosphor Icons — licence MIT

Les pictogrammes proviennent du paquet `@phosphor-icons/core`. Seuls ceux que
l'interface utilise sont repris, sans modification de leur tracé, dans
`src/renderer/js/core/icons.data.js` (fichier généré par
`scripts/build-icons.mjs`).

```
MIT License

Copyright (c) 2023 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Inter — SIL Open Font License 1.1

Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)

Fichiers repris du paquet `@fontsource-variable/inter` 5.3.0 (sous-ensembles
latin et latin étendu, non modifiés). Texte complet de la licence :
[`assets/fonts/inter/LICENSE.txt`](assets/fonts/inter/LICENSE.txt).

## Outfit — SIL Open Font License 1.1

Copyright 2021 The Outfit Project Authors (https://github.com/Outfitio/Outfit-Fonts)

Fichiers repris du paquet `@fontsource-variable/outfit` 5.3.0 (sous-ensembles
latin et latin étendu, non modifiés). Texte complet de la licence :
[`assets/fonts/outfit/LICENSE.txt`](assets/fonts/outfit/LICENSE.txt).

## Electron, Chromium et Node.js

L'exécutable embarque Electron, qui réunit Chromium et Node.js. Leurs licences
accompagnent l'application : les fichiers `LICENSE.electron.txt` et
`LICENSES.chromium.html` sont placés à côté du programme lorsque l'exécutable
portable se décompresse.

- Electron — licence MIT — Copyright (c) Electron contributors, Copyright (c) 2013-2020 GitHub Inc.
- Chromium — licence BSD à 3 clauses et licences de ses propres composants
  (détail dans `LICENSES.chromium.html`).
- Node.js — licence MIT et licences de ses propres composants.

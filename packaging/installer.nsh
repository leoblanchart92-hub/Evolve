; Evolve — Compléments de l'installateur fabriqué par electron-builder (NSIS).
;
; L'installation est celle du compte Windows en cours, et de lui seul : aucun
; droit d'administrateur n'est demandé, et rien n'est écrit hors de son profil.
; Ce fichier est inclus par l'installateur comme par le désinstallateur.

; Jamais « pour tous les utilisateurs » : le choix n'est pas proposé, et aucune
; élévation de droits n'est donc demandée.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Première page : ce que l'installateur va faire, avant qu'il ne fasse rien.
; Une mise à jour, demandée depuis Evolve, s'installe sans aucune page.
!macro customWelcomePage
  Function evolveSkipWelcomeIfUpdated
    ${if} ${isUpdated}
      Abort
    ${endif}
  FunctionEnd

  !define MUI_WELCOMEPAGE_TITLE "Installation d'Evolve ${VERSION}"
  !define MUI_WELCOMEPAGE_TEXT "Evolve va être installé pour votre compte Windows seulement, sans droits d'administrateur.$\r$\n$\r$\nLe programme est copié dans votre profil :$\r$\n$LOCALAPPDATA\Programs\${APP_FILENAME}$\r$\n$\r$\nUn raccourci est ajouté au menu Démarrer et au bureau. Rien n'est lancé au démarrage de Windows.$\r$\n$\r$\nEvolve se désinstalle comme tout programme, depuis les paramètres de Windows."
  !define MUI_PAGE_CUSTOMFUNCTION_PRE evolveSkipWelcomeIfUpdated
  !insertmacro MUI_PAGE_WELCOME
!macroend

; L'installateur d'electron-builder garde dans le profil une copie de lui-même
; (une centaine de mégaoctets), pour un mode de mise à jour qu'Evolve n'emploie
; pas. Elle est retirée aussitôt : il ne reste que le programme installé.
!define EVOLVE_INSTALLER_COPY_DIR "evolve-updater"
!define EVOLVE_INSTALLER_COPY "${EVOLVE_INSTALLER_COPY_DIR}\installer.exe"

!macro customInstall
  !ifdef APP_INSTALLER_STORE_FILE
    !if "${APP_INSTALLER_STORE_FILE}" != "${EVOLVE_INSTALLER_COPY}"
      !error "Copie de l'installateur à un emplacement inattendu : ${APP_INSTALLER_STORE_FILE}"
    !endif
    Delete "$LOCALAPPDATA\${EVOLVE_INSTALLER_COPY}"
    RMDir "$LOCALAPPDATA\${EVOLVE_INSTALLER_COPY_DIR}"
  !endif
!macroend

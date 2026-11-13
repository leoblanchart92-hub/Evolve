/*
 * Evolve — Module natif « evolve_fs » : déplacer ou renommer un élément SANS
 * JAMAIS RIEN REMPLACER.
 *
 * Pourquoi un module natif. Node.js ne sait renommer qu'en remplaçant : sous
 * Windows, `fs.rename` appelle MoveFileExW avec l'option
 * MOVEFILE_REPLACE_EXISTING, et le fichier qui porterait déjà le nom
 * d'arrivée est écrasé. Vérifier d'abord que ce nom est libre ne suffit pas :
 * un autre programme peut le prendre entre la vérification et le renommage.
 *
 * Ce module demande donc au système lui-même de ne déplacer que si le nom
 * d'arrivée est libre. La vérification et le déplacement ne font alors
 * qu'une seule opération, menée par le système de fichiers : aucun autre
 * programme ne peut s'intercaler entre les deux.
 *
 *   Windows : MoveFileExW, sans aucune option — en particulier sans
 *             MOVEFILE_REPLACE_EXISTING (rien n'est remplacé) ni
 *             MOVEFILE_COPY_ALLOWED (aucune copie, donc aucune suppression) ;
 *   Linux   : renameat2 avec RENAME_NOREPLACE (pour les essais des
 *             développeurs : Evolve n'est distribué que pour Windows).
 *
 * Une seule fonction est exportée :
 *
 *   moveNoReplace(from, to) → Promise<number>
 *
 *     La promesse donne 0 si l'élément porte désormais le nom `to` ; sinon,
 *     le code d'erreur du système (GetLastError sous Windows, errno
 *     ailleurs), et rien n'a été modifié. Si quoi que ce soit porte déjà le
 *     nom `to` — fichier, dossier ou lien —, le système refuse :
 *     ERROR_ALREADY_EXISTS ou ERROR_FILE_EXISTS sous Windows, EEXIST ailleurs.
 *
 * Le module ne fait rien d'autre : il ne lit, ne copie et ne supprime rien.
 * Les textes qu'il renvoie sont en ASCII ; les messages destinés à
 * l'utilisateur sont composés par l'application (src/main/atomic-move.js).
 */

#if !defined(_WIN32) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE /* syscall() */
#endif

#ifndef NAPI_VERSION
#define NAPI_VERSION 8
#endif
#include <node_api.h>

#include <stdint.h>
#include <stdlib.h>

#if defined(_WIN32)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

/* Les textes de JavaScript et les chemins de Windows sont tous deux en UTF-16. */
typedef wchar_t path_char;
typedef char wchar_t_must_be_16_bits[sizeof(wchar_t) == sizeof(char16_t) ? 1 : -1];

#else

#include <errno.h>
#include <fcntl.h>
#include <unistd.h>

#if defined(__linux__)
#include <sys/syscall.h>
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif
#endif

typedef char path_char;

#endif

/* Code renvoyé si le système n'a donné aucun code d'erreur, ou si la demande n'a pas pu être menée. */
#define EVOLVE_UNKNOWN_FAILURE 0xFFFFFFFFu

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  path_char* from;
  path_char* to;
  uint32_t error; /* 0 : l'élément a été déplacé */
} move_request;

static void free_request(move_request* request) {
  if (request == NULL) return;
  free(request->from);
  free(request->to);
  free(request);
}

/*
 * Copie un texte JavaScript sous la forme attendue par le système. Renvoie
 * NULL si la valeur n'est pas un texte, si le texte est vide ou s'il contient
 * un caractère nul (qui couperait le chemin en deux).
 */
static path_char* read_path(napi_env env, napi_value value) {
  napi_valuetype type;
  size_t length = 0;
  size_t written = 0;
  size_t index;
#if defined(_WIN32)
  char16_t* text;
#else
  char* text;
#endif

  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return NULL;

#if defined(_WIN32)
  if (napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok || length == 0) return NULL;
  text = (char16_t*)malloc((length + 1) * sizeof(char16_t));
  if (text == NULL) return NULL;
  if (napi_get_value_string_utf16(env, value, text, length + 1, &written) != napi_ok || written != length) {
    free(text);
    return NULL;
  }
#else
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length == 0) return NULL;
  text = (char*)malloc(length + 1);
  if (text == NULL) return NULL;
  if (napi_get_value_string_utf8(env, value, text, length + 1, &written) != napi_ok || written != length) {
    free(text);
    return NULL;
  }
#endif

  for (index = 0; index < length; index += 1) {
    if (text[index] == 0) {
      free(text);
      return NULL;
    }
  }
  text[length] = 0;
  return (path_char*)text;
}

/* Exécutée hors du fil principal : le seul appel au système de tout le module. */
static void execute_move(napi_env env, void* data) {
  move_request* request = (move_request*)data;
  (void)env;

#if defined(_WIN32)
  if (MoveFileExW(request->from, request->to, 0)) {
    request->error = 0;
  } else {
    DWORD code = GetLastError();
    request->error = code != 0 ? (uint32_t)code : EVOLVE_UNKNOWN_FAILURE;
  }
#elif defined(__linux__)
  if (syscall(SYS_renameat2, AT_FDCWD, request->from, AT_FDCWD, request->to, RENAME_NOREPLACE) == 0) {
    request->error = 0;
  } else {
    request->error = errno != 0 ? (uint32_t)errno : EVOLVE_UNKNOWN_FAILURE;
  }
#else
  /* Aucun déplacement sans remplacement connu sur ce système : rien n'est tenté. */
  request->error = (uint32_t)ENOTSUP;
#endif
}

/* De retour sur le fil principal : la promesse reçoit le résultat. */
static void complete_move(napi_env env, napi_status status, void* data) {
  move_request* request = (move_request*)data;
  napi_value result;

  /* Demande abandonnée avant d'avoir été menée (arrêt du programme) : rien n'a été déplacé. */
  if (status != napi_ok) request->error = EVOLVE_UNKNOWN_FAILURE;

  if (napi_create_uint32(env, request->error, &result) == napi_ok) {
    napi_resolve_deferred(env, request->deferred, result);
  }
  napi_delete_async_work(env, request->work);
  free_request(request);
}

static napi_value move_no_replace(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_value promise;
  napi_value name;
  move_request* request;

  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) {
    napi_throw_type_error(env, NULL, "moveNoReplace(from, to): two paths expected");
    return NULL;
  }

  request = (move_request*)calloc(1, sizeof(move_request));
  if (request == NULL) {
    napi_throw_error(env, NULL, "moveNoReplace: out of memory");
    return NULL;
  }
  request->error = EVOLVE_UNKNOWN_FAILURE;
  request->from = read_path(env, argv[0]);
  request->to = read_path(env, argv[1]);
  if (request->from == NULL || request->to == NULL) {
    free_request(request);
    napi_throw_type_error(env, NULL, "moveNoReplace(from, to): each path must be a non-empty string without null character");
    return NULL;
  }

  if (napi_create_promise(env, &request->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "evolve_fs.moveNoReplace", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, NULL, name, execute_move, complete_move, request, &request->work) != napi_ok) {
    free_request(request);
    napi_throw_error(env, NULL, "moveNoReplace: the request could not be prepared");
    return NULL;
  }
  if (napi_queue_async_work(env, request->work) != napi_ok) {
    napi_delete_async_work(env, request->work);
    free_request(request);
    napi_throw_error(env, NULL, "moveNoReplace: the request could not be queued");
    return NULL;
  }
  return promise;
}

NAPI_MODULE_INIT() {
  napi_value function;

  if (napi_create_function(env, "moveNoReplace", NAPI_AUTO_LENGTH, move_no_replace, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "moveNoReplace", function) != napi_ok) {
    napi_throw_error(env, NULL, "evolve_fs: initialisation failed");
    return NULL;
  }
  return exports;
}

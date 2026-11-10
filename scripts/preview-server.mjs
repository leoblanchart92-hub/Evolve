#!/usr/bin/env node
/**
 * Evolve — Serveur d'aperçu (développement uniquement).
 *
 * Sert l'interface dans un navigateur, sans Electron, pour travailler sur le
 * design : `npm run preview` puis ouvrir http://localhost:4173.
 * Seuls les dossiers embarqués dans l'application (src/renderer et assets)
 * sont exposés. Aucune dépendance : uniquement les modules de Node.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 4173;
const host = process.env.HOST || '0.0.0.0';

const ENTRY = '/src/renderer/index.html';
const PUBLIC_DIRS = ['src/renderer', 'assets'].map((dir) => join(root, dir) + sep);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  response.end(body);
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return send(response, 405, 'Méthode non autorisée', { Allow: 'GET, HEAD' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    return send(response, 400, 'Requête invalide');
  }

  if (pathname === '/') return send(response, 302, '', { Location: ENTRY });

  // Résolution sûre : le fichier doit rester dans un dossier public.
  const file = normalize(join(root, pathname));
  if (!PUBLIC_DIRS.some((dir) => file.startsWith(dir))) return send(response, 404, 'Introuvable');

  try {
    const info = await stat(file);
    if (!info.isFile()) return send(response, 404, 'Introuvable');
    response.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') return response.end();
    return createReadStream(file).pipe(response);
  } catch {
    return send(response, 404, 'Introuvable');
  }
});

server.listen(port, host, () => {
  console.log(`Evolve — aperçu disponible sur http://localhost:${port}${ENTRY}`);
});

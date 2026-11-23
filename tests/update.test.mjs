import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { checkAsset } = require('../src/main/update.js');

test('détecte l’installateur Setup publié parmi les assets de la release', () => {
  const setup = {
    name: 'Evolve-0.3.96-Setup.exe',
    browser_download_url: 'https://github.com/leoblanchart92-hub/Evolve/releases/download/v0.3.96/Evolve-0.3.96-Setup.exe',
  };
  const release = {
    tag_name: 'v0.3.96',
    assets: [
      { name: 'Evolve-0.3.96-portable.exe', browser_download_url: 'https://github.com/leoblanchart92-hub/Evolve/releases/download/v0.3.96/Evolve-0.3.96-portable.exe' },
      setup,
    ],
  };

  assert.equal(checkAsset(release), setup);
});

test('ignore les assets qui ne sont pas l’installateur officiel Evolve', () => {
  assert.equal(checkAsset({ tag_name: 'v0.3.96', assets: [
    null,
    { name: 'Evolve-0.3.96-portable.exe', browser_download_url: 'https://github.com/leoblanchart92-hub/Evolve/releases/download/v0.3.96/Evolve-0.3.96-portable.exe' },
    { name: 'Evolve-0.3.96-Setup.exe', browser_download_url: 'https://example.com/Evolve-0.3.96-Setup.exe' },
    { name: 'other-Setup.exe', browser_download_url: 'https://github.com/leoblanchart92-hub/Evolve/releases/download/v0.3.96/other-Setup.exe' },
  ] }), undefined);
  assert.equal(checkAsset({ tag_name: 'v0.3.96', assets: 'invalid' }), undefined);
});

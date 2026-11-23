import { readFileSync, writeFileSync } from 'node:fs';

const runNumber = Number(process.env.GITHUB_RUN_NUMBER);
if (!Number.isSafeInteger(runNumber) || runNumber < 1) throw new Error('GITHUB_RUN_NUMBER must be a positive integer.');

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const [major, minor] = packageJson.version.split('.');
const version = `${major}.${minor}.${runNumber}`;
packageJson.version = version;
writeFileSync('package.json', `${JSON.stringify(packageJson, null, 2)}\n`);

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
lock.version = version;
lock.packages[''].version = version;
writeFileSync('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);

const configPath = 'src/renderer/js/config.js';
writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(/version: '[^']+'/, `version: '${version}'`));

const demoPath = 'src/renderer/js/data/demo-files.js';
writeFileSync(demoPath, readFileSync(demoPath, 'utf8').replace(/Evolve-\d+\.\d+\.\d+-portable\.exe/g, `Evolve-${version}-portable.exe`));

console.log(`Version: ${version}`);

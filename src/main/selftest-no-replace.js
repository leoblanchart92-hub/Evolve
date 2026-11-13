'use strict';

/**
 * Evolve — Vérification : renommer ou déplacer ne remplace jamais rien.
 *
 * Evolve confie chaque renommage et chaque déplacement à une fonction qui
 * demande au système de ne déplacer un élément que si le nom d'arrivée est
 * libre, d'un seul geste (module natif native/evolve_fs.c, chargé par
 * atomic-move.js). Ce fichier éprouve une telle fonction sur un vrai disque,
 * dans un dossier d'essai que l'appelant lui confie :
 *
 *   1. nom libre : l'élément est déplacé (noms accentués, autre dossier et,
 *      sauf demande contraire, chemin de plus de 260 caractères) ;
 *   2. nom déjà pris — par un fichier, un dossier vide, un dossier non vide ou
 *      un lien : le système refuse, et rien ne change ;
 *   3. seule la casse du nom change : accepté ;
 *   4. concurrence : plusieurs déplacements visent au même instant le même
 *      nom libre, puis un déplacement et une création se disputent un nom.
 *      Un seul doit aboutir ; les autres sont refusés, et aucun élément n'est
 *      remplacé ni perdu ;
 *   5. d'un lecteur à un autre, si l'appelant en désigne un : refusé sans
 *      rien copier — l'application copie alors elle-même, puis envoie
 *      l'original à la Corbeille.
 *
 * La même vérification sert deux fois : à la compilation, sur le module qui
 * vient d'être compilé (scripts/check-native.mjs) ; puis dans l'application
 * elle-même, pendant son auto-test (selftest-explorer.js), sur la fonction
 * qu'elle emploie réellement.
 *
 * Rien n'est supprimé ici : les éléments d'essai restent dans le dossier
 * confié, que l'appelant retire s'il le souhaite.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Intitulé du contrôle, dans l'auto-test de l'application. */
const CHECK =
  "renommer ou déplacer ne remplace jamais rien : le système refuse lui-même un nom déjà pris et, de plusieurs déplacements simultanés vers un même nom, un seul aboutit";

/** Dossier d'essai de ce contrôle, dans le dossier de l'essai de l'auto-test. */
const FOLDER_NAME = 'Déplacements sans remplacement';

/** Nombre de courses de chaque sorte, et de déplacements simultanés par course. */
const DEFAULT_ROUNDS = 40;
const DEFAULT_MOVERS = 8;

/**
 * Refus passagers de Windows (élément examiné un instant par un antivirus…) :
 * la demande est renouvelée, comme le fait l'application. Un refus pour nom
 * déjà pris (« EEXIST ») n'en fait pas partie : il est définitif.
 */
const TRANSIENT = Object.freeze(['EBUSY', 'EPERM', 'EACCES']);

/** Nombre maximal de problèmes rapportés (les suivants n'apprendraient rien de plus). */
const MAX_PROBLEMS = 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const present = (location) => {
  try {
    fs.lstatSync(location);
    return true;
  } catch {
    return false;
  }
};

const textOf = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** État d'un dossier : une ligne par élément, contenu des fichiers compris. Les liens ne sont pas suivis. */
function snapshot(folder) {
  const lines = [];
  (function walk(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const relative = path.relative(folder, full);
      const info = fs.lstatSync(full);
      if (info.isSymbolicLink()) lines.push(`${relative} -> lien`);
      else if (info.isDirectory()) {
        lines.push(`${relative}${path.sep}`);
        walk(full);
      } else lines.push(`${relative} = ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16)}`);
    }
  })(folder);
  return lines.join('\n');
}

/** Les deux sortes d'éléments : chacun porte un texte qui permet de le reconnaître. */
const FILE = Object.freeze({
  label: 'fichiers',
  one: 'un fichier',
  make: (location, content) => fs.writeFileSync(location, content),
  read: (location) => textOf(location),
  /** Création par « un autre programme » : refusée par le système si le nom existe. */
  create: (location, content) => fs.promises.writeFile(location, content, { flag: 'wx' }),
  created: (location) => textOf(location),
});
const FOLDER = Object.freeze({
  label: 'dossiers',
  one: 'un dossier',
  make: (location, content) => {
    fs.mkdirSync(location);
    fs.writeFileSync(path.join(location, 'contenu.txt'), content);
  },
  read: (location) => textOf(path.join(location, 'contenu.txt')),
  create: async (location, content) => {
    await fs.promises.mkdir(location);
    await fs.promises.writeFile(path.join(location, 'créé.txt'), content, { flag: 'wx' });
  },
  created: (location) => textOf(path.join(location, 'créé.txt')),
});

/**
 * Éprouve un déplacement sans remplacement sur un vrai disque.
 *
 * @param {(from: string, to: string) => Promise<void>} move  fonction à éprouver : elle doit échouer
 *        avec le code « EEXIST », sans rien modifier, si le nom d'arrivée est pris
 * @param {object} options
 * @param {string} options.base  dossier d'essai, existant et vide (chemin réel), où tout se passe
 * @param {number} [options.rounds]  nombre de courses de chaque sorte
 * @param {number} [options.movers]  déplacements simultanés par course
 * @param {boolean} [options.longPath]  éprouver aussi un chemin de plus de 260 caractères, la limite
 *        historique de Windows (à éviter quand le dossier d'essai est conservé : bien des outils ne
 *        savent ni l'archiver ni l'extraire)
 * @param {string|null} [options.otherVolume]  dossier existant et vide situé sur un autre lecteur, ou `null`
 * @returns {Promise<{ ok: boolean, problems: string[], facts: object }>}
 */
async function verifyNoReplace(move, { base, rounds = DEFAULT_ROUNDS, movers = DEFAULT_MOVERS, longPath = true, otherVolume = null } = {}) {
  const problems = [];
  const problem = (message) => {
    if (problems.length < MAX_PROBLEMS) problems.push(message);
    else if (problems.length === MAX_PROBLEMS) problems.push('… (problèmes suivants non rapportés)');
  };
  const facts = {
    /** Déplacements aboutis vers un nom libre ; vrai si l'un d'eux éprouve un chemin de plus de 260 caractères. */
    free: 0,
    longPath: longPath === true,
    /** Refus devant un nom déjà pris : nombre de cas, codes d'erreur donnés par le système. */
    taken: { cases: 0, numbers: [] },
    /** Faux si aucun lien n'a pu être créé sur cette machine (cas non vérifié). */
    link: true,
    /** Changements de casse acceptés. */
    caseOnly: 0,
    /** Courses : demandes simultanées, déplacements aboutis, refus, éléments remplacés ou perdus. */
    races: { rounds: 0, requests: 0, moved: 0, refused: 0, lost: 0 },
    /** Courses entre un déplacement et une création : qui a pris le nom. */
    contests: { rounds: 0, creator: 0, mover: 0 },
    /** D'un lecteur à l'autre : `null` si aucun autre lecteur n'a été désigné. */
    crossVolume: null,
    /** Refus passagers rencontrés (demandes renouvelées). */
    transient: 0,
  };
  if (typeof move !== 'function') return { ok: false, problems: ['fonction de déplacement sans remplacement absente'], facts };
  const at = (...names) => path.join(base, ...names);

  /** Demande un déplacement ; un refus passager est renouvelé quelques instants. */
  const attempt = async (from, to, retries = 30) => {
    for (let turn = 0; ; turn += 1) {
      try {
        await move(from, to);
        return { ok: true };
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
        if (!TRANSIENT.includes(code) || turn >= retries) return { ok: false, code, number: Number.isInteger(error?.errno) ? error.errno : null };
        facts.transient += 1;
        await sleep(10);
      }
    }
  };

  /** Une partie de la vérification : une panne inattendue y est rapportée comme un problème. */
  const section = async (name, run) => {
    try {
      await run();
    } catch (error) {
      problem(`${name} : vérification interrompue — ${error?.message ?? error}`);
    }
  };

  // --- 1. Nom libre ----------------------------------------------------------------
  await section('nom libre', async () => {
    const dir = at('1 - nom libre');
    fs.mkdirSync(path.join(dir, 'Rangé'), { recursive: true });
    const cases = [
      [FILE, 'nom accentué', path.join(dir, 'Lettre à Zoé.txt'), path.join(dir, 'Courrier d’été.txt')],
      [FOLDER, 'avec son contenu', path.join(dir, 'Photos'), path.join(dir, 'Photos d’août')],
      [FILE, 'vers un autre dossier', path.join(dir, 'Budget.xlsx'), path.join(dir, 'Rangé', 'Budget.xlsx')],
      [FOLDER, 'vers un autre dossier', path.join(dir, 'Projets'), path.join(dir, 'Rangé', 'Projets')],
    ];
    if (facts.longPath) {
      // Chemin de plus de 260 caractères : la limite historique de Windows.
      const deep = path.join(dir, 'a'.repeat(120), 'b'.repeat(120), 'c'.repeat(120));
      fs.mkdirSync(deep, { recursive: true });
      cases.push([FILE, 'chemin de plus de 260 caractères', path.join(deep, 'long.txt'), path.join(deep, 'renommé.txt')]);
    }
    for (const [kind, label, from, to] of cases) {
      const content = `nom libre, ${kind.one}, ${label}`;
      kind.make(from, content);
      const result = await attempt(from, to);
      if (!result.ok) problem(`nom libre (${kind.one}, ${label}) : déplacement refusé — ${result.code}, code du système ${result.number}`);
      else if (present(from) || kind.read(to) !== content) problem(`nom libre (${kind.one}, ${label}) : l'élément n'est pas arrivé intact sous son nouveau nom`);
      else facts.free += 1;
    }
  });

  // --- 2. Nom déjà pris ------------------------------------------------------------
  await section('nom déjà pris', async () => {
    const occupants = [
      ['un fichier', (location) => fs.writeFileSync(location, 'occupant')],
      ['un dossier vide', (location) => fs.mkdirSync(location)],
      ['un dossier non vide', (location) => FOLDER.make(location, 'occupant')],
      [
        'un lien',
        (location, dir) => {
          fs.mkdirSync(path.join(dir, 'cible du lien'));
          // Jonction sous Windows (aucun droit particulier n'est nécessaire), lien symbolique ailleurs.
          fs.symlinkSync(path.join(dir, 'cible du lien'), location, 'junction');
        },
      ],
    ];
    let index = 0;
    for (const kind of [FILE, FOLDER]) {
      for (const [occupant, occupy] of occupants) {
        const label = `${kind.one} vers le nom d'${occupant}`;
        const dir = at('2 - nom déjà pris', String((index += 1)));
        fs.mkdirSync(dir, { recursive: true });
        try {
          occupy(path.join(dir, 'occupant'), dir);
        } catch {
          facts.link = false; // lien impossible à créer sur cette machine : cas non vérifié
          continue;
        }
        kind.make(path.join(dir, 'élément'), 'élément à déplacer');
        const before = snapshot(dir);
        const result = await attempt(path.join(dir, 'élément'), path.join(dir, 'occupant'), 5);
        if (result.ok) problem(`nom déjà pris (${label}) : le déplacement a abouti — l'occupant a été remplacé`);
        else if (snapshot(dir) !== before) problem(`nom déjà pris (${label}) : refusé (${result.code}), mais le dossier d'essai a changé`);
        else if (result.code !== 'EEXIST') problem(`nom déjà pris (${label}) : refus attendu « EEXIST », obtenu « ${result.code} » (code du système ${result.number})`);
        else {
          facts.taken.cases += 1;
          if (result.number !== null && !facts.taken.numbers.includes(result.number)) facts.taken.numbers.push(result.number);
        }
      }
    }
  });

  // --- 3. Seule la casse change ----------------------------------------------------
  await section('casse', async () => {
    const dir = at('3 - casse');
    fs.mkdirSync(dir, { recursive: true });
    for (const [kind, from, to] of [[FILE, 'Budget.xlsx', 'BUDGET.xlsx'], [FOLDER, 'Projets', 'PROJETS']]) {
      const content = `casse, ${kind.one}`;
      kind.make(path.join(dir, from), content);
      const result = await attempt(path.join(dir, from), path.join(dir, to));
      const names = fs.readdirSync(dir);
      if (!result.ok) problem(`seule la casse change (${kind.one}) : refusé — ${result.code}, code du système ${result.number}`);
      else if (!names.includes(to) || names.includes(from) || kind.read(path.join(dir, to)) !== content) problem(`seule la casse change (${kind.one}) : l'élément ne porte pas le nouveau nom, intact`);
      else facts.caseOnly += 1;
    }
  });

  // --- 4. Concurrence --------------------------------------------------------------
  await section('concurrence', async () => {
    // Tout est créé d'avance : pendant les courses, seuls les déplacements (et les créations
    // concurrentes) touchent au disque.
    const races = [];
    const contests = [];
    for (const [kind, count] of [[FILE, movers], [FOLDER, Math.max(2, Math.min(movers, 4))]]) {
      for (let round = 0; round < rounds; round += 1) {
        const dir = at('4 - concurrence', `${kind.label}-${round + 1}`);
        fs.mkdirSync(dir, { recursive: true });
        const sources = Array.from({ length: count }, (_, source) => ({ location: path.join(dir, `source-${source + 1}`), content: `${kind.label}, course ${round + 1}, source ${source + 1}` }));
        for (const source of sources) kind.make(source.location, source.content);
        races.push({ kind, label: `course ${round + 1} entre ${count} ${kind.label}`, sources, target: path.join(dir, 'arrivée') });

        const duel = at('4 - concurrence', `création-${kind.label}-${round + 1}`);
        fs.mkdirSync(duel, { recursive: true });
        const moved = `${kind.one} déplacé, course ${round + 1}`;
        kind.make(path.join(duel, 'élément'), moved);
        contests.push({
          kind,
          label: `course ${round + 1} entre un déplacement et une création (${kind.label})`,
          source: path.join(duel, 'élément'),
          target: path.join(duel, 'arrivée'),
          moved,
          created: `créé par un autre programme, course ${round + 1}`,
          creatorFirst: round % 2 === 1,
        });
      }
    }

    // Plusieurs déplacements visent, au même instant, le même nom libre : un seul doit aboutir.
    for (const { kind, label, sources, target } of races) {
      const results = await Promise.all(sources.map((source) => attempt(source.location, target)));
      const winners = results.filter((result) => result.ok).length;
      const arrived = kind.read(target);
      // Chaque élément doit se trouver quelque part : arrivé sous le nouveau nom, ou resté à sa place.
      const lost = sources.filter((source) => source.content !== arrived && kind.read(source.location) !== source.content).length;
      const unexpected = [...new Set(results.filter((result) => !result.ok && result.code !== 'EEXIST').map((result) => result.code))];
      facts.races.rounds += 1;
      facts.races.requests += results.length;
      facts.races.moved += winners;
      facts.races.refused += results.length - winners;
      facts.races.lost += lost;
      if (winners !== 1) problem(`${label} : ${winners} déplacements ont abouti vers le même nom, au lieu d'un seul`);
      if (lost > 0) problem(`${label} : ${lost} élément(s) remplacé(s) — leur contenu a disparu`);
      if (unexpected.length) problem(`${label} : refus inattendu (${unexpected.join(', ')}) au lieu de « EEXIST »`);
      if (winners === 1 && lost === 0) {
        const winner = sources[results.findIndex((result) => result.ok)];
        if (arrived !== winner.content || present(winner.location)) problem(`${label} : l'élément déplacé n'est pas celui dont le déplacement a abouti`);
      }
    }

    // Un déplacement et une création se disputent le même nom : un seul des deux doit aboutir.
    for (const { kind, label, source, target, moved, created, creatorFirst } of contests) {
      const creation = () =>
        kind.create(target, created).then(
          () => ({ ok: true }),
          (error) => ({ ok: false, code: error?.code ?? 'UNKNOWN' }),
        );
      let mover;
      let creator;
      if (creatorFirst) {
        creator = creation();
        mover = attempt(source, target);
      } else {
        mover = attempt(source, target);
        creator = creation();
      }
      const [moving, creating] = await Promise.all([mover, creator]);
      facts.contests.rounds += 1;
      facts.races.rounds += 1;
      facts.races.requests += 2;
      if (moving.ok && creating.ok) {
        facts.races.lost += 1;
        problem(`${label} : la création et le déplacement ont tous deux abouti — l'un a remplacé l'autre`);
      } else if (!moving.ok && !creating.ok) {
        problem(`${label} : ni la création (${creating.code}) ni le déplacement (${moving.code}) n'ont abouti`);
      } else if (creating.ok) {
        // L'autre programme a pris le nom : le déplacement est refusé, l'élément reste à sa place.
        facts.contests.creator += 1;
        facts.races.refused += 1;
        if (moving.code !== 'EEXIST') problem(`${label} : refus inattendu du déplacement (${moving.code}) au lieu de « EEXIST »`);
        if (kind.created(target) !== created || kind.read(source) !== moved) problem(`${label} : l'élément créé ou l'élément à déplacer n'est plus intact`);
      } else {
        // Le déplacement a pris le nom : la création est refusée.
        facts.contests.mover += 1;
        facts.races.moved += 1;
        if (creating.code !== 'EEXIST') problem(`${label} : refus inattendu de la création (${creating.code})`);
        if (kind.read(target) !== moved || present(source)) problem(`${label} : l'élément déplacé n'est pas arrivé intact`);
      }
    }
  });

  // --- 5. D'un lecteur à l'autre ---------------------------------------------------
  if (otherVolume) {
    await section("d'un lecteur à l'autre", async () => {
      const here = at('5 - autre lecteur');
      fs.mkdirSync(here, { recursive: true });
      const numbers = [];
      let refused = 0;
      for (const kind of [FILE, FOLDER]) {
        const source = path.join(here, kind.label);
        kind.make(source, `autre lecteur, ${kind.one}`);
        const before = snapshot(here);
        const result = await attempt(source, path.join(otherVolume, kind.label), 5);
        if (result.ok) problem(`d'un lecteur à l'autre (${kind.one}) : le déplacement a abouti, alors qu'il ne peut se faire que par copie`);
        else if (snapshot(here) !== before || fs.readdirSync(otherVolume).length !== 0) problem(`d'un lecteur à l'autre (${kind.one}) : refusé (${result.code}), mais un élément a été modifié ou copié`);
        else if (result.code !== 'EXDEV') problem(`d'un lecteur à l'autre (${kind.one}) : refus attendu « EXDEV », obtenu « ${result.code} » (code du système ${result.number})`);
        else {
          refused += 1;
          if (result.number !== null && !numbers.includes(result.number)) numbers.push(result.number);
        }
      }
      // Sous Windows, les deux lecteurs se nomment par leur lettre ; ailleurs, par leur dossier.
      const sameRoot = path.parse(here).root === path.parse(otherVolume).root;
      facts.crossVolume = { from: sameRoot ? base : path.parse(here).root, to: sameRoot ? otherVolume : path.parse(otherVolume).root, refused, numbers };
    });
  }

  return { ok: problems.length === 0, problems, facts };
}

/**
 * Compte rendu d'une vérification réussie : une ligne par constat.
 * @param {object} facts  constats de `verifyNoReplace`
 * @returns {string[]}
 */
function describeFacts(facts) {
  const numbers = (list) => (Array.isArray(list) && list.length ? ` — code du système : ${list.join(', ')}` : '');
  const lines = [
    `✔ nom libre : ${facts.free} déplacements aboutis (noms accentués, autre dossier${facts.longPath ? ', chemin de plus de 260 caractères' : ''})`,
    `✔ nom déjà pris : refusé par le système dans les ${facts.taken.cases} cas (un fichier ou un dossier, vers le nom d'un fichier, d'un dossier vide, d'un dossier non vide${facts.link ? ", d'un lien" : ''}) ; rien n'a été modifié${numbers(facts.taken.numbers)}`,
    `✔ seule la casse du nom change : accepté (${facts.caseOnly} cas)`,
    `✔ concurrence : ${facts.races.rounds} courses, ${facts.races.requests} demandes simultanées — une seule aboutie par course (${facts.races.moved} déplacements, ${facts.contests.creator} créations), ${facts.races.refused} déplacements refusés, aucun élément remplacé ni perdu`,
    `  dont ${facts.contests.rounds} courses entre un déplacement et une création : nom pris ${facts.contests.creator} fois par la création, ${facts.contests.mover} fois par le déplacement`,
  ];
  if (facts.crossVolume) lines.push(`✔ d'un lecteur à l'autre (${facts.crossVolume.from} → ${facts.crossVolume.to}) : refusé sans rien copier (${facts.crossVolume.refused} cas)${numbers(facts.crossVolume.numbers)}`);
  if (!facts.link) lines.push('! nom pris par un lien : non vérifié (lien impossible à créer sur cette machine)');
  if (facts.transient > 0) lines.push(`  (${facts.transient} refus passagers du système, demandes renouvelées)`);
  return lines;
}

/**
 * Résumé en une ligne, pour le compte rendu de l'auto-test ; `null` si les constats sont absents ou incomplets.
 * @param {object|null|undefined} facts
 * @returns {string|null}
 */
function summarizeFacts(facts) {
  const counts = [facts?.free, facts?.taken?.cases, facts?.caseOnly, facts?.races?.rounds, facts?.races?.requests, facts?.races?.lost];
  if (!counts.every((value) => Number.isInteger(value) && value >= 0)) return null;
  const codes = Array.isArray(facts.taken.numbers) ? facts.taken.numbers.filter(Number.isInteger).slice(0, 4) : [];
  const lost = facts.races.lost === 0 ? 'aucun élément remplacé ni perdu' : `${facts.races.lost} élément(s) remplacé(s) ou perdu(s)`;
  return (
    `Sans remplacement : ${facts.taken.cases} déplacements vers un nom déjà pris refusés par le système${codes.length ? ` (code ${codes.join(', ')})` : ''}` +
    ` · ${facts.races.rounds} courses, ${facts.races.requests} demandes simultanées, ${lost}`
  );
}

module.exports = { verifyNoReplace, describeFacts, summarizeFacts, snapshot, CHECK, FOLDER_NAME, DEFAULT_ROUNDS, DEFAULT_MOVERS, TRANSIENT };

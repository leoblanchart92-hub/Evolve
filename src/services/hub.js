'use strict';

/**
 * Evolve — Point d'accès unique aux services.
 *
 * Un service est un ensemble de méthodes nommées, indépendant de toute
 * interface : il ne connaît ni fenêtre, ni page web, ni Electron. L'interface
 * — ou tout autre programme, demain un bureau Linux — les appelle par leur
 * nom à travers ce point d'accès, qui garantit que :
 *   - seules les méthodes déclarées sont appelables ;
 *   - les arguments sont de simples données, de taille bornée ;
 *   - la réponse a toujours la même forme, y compris en cas d'erreur :
 *       { ok: true, value }   ou   { ok: false, code, message }
 *   - une erreur imprévue d'un service ne se propage jamais à l'appelant.
 */

/** Limites des arguments reçus de l'extérieur. */
const LIMITS = Object.freeze({ args: 8, depth: 6, nodes: 2000, text: 65_536 });

/** Erreur prévue d'un service : son code et son message sont transmis à l'appelant. */
class ServiceError extends Error {
  /**
   * @param {string} code     identifiant stable (« unknown-key », « invalid-value »…)
   * @param {string} message  explication lisible
   */
  constructor(code, message) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}

const failure = (code, message) => ({ ok: false, code, message });

/**
 * Exécute `task` et renvoie son résultat sous la forme commune à tous les
 * services : `{ ok: true, value }`, ou `{ ok: false, code, message }` si le
 * service refuse (`ServiceError`) ou rencontre une erreur imprévue — dont le
 * détail est consigné, jamais transmis. Ne lève jamais d'exception.
 * @param {() => any} task
 * @param {object} [options]
 * @param {(message: string) => void} [options.log]
 * @param {string} [options.label]  ce qui est appelé, pour le journal
 */
async function reply(task, { log = () => {}, label = 'service' } = {}) {
  try {
    const value = await task();
    return { ok: true, value: value === undefined ? null : value };
  } catch (error) {
    if (error instanceof ServiceError) return failure(error.code, error.message);
    log(`Erreur du service ${label} : ${error?.stack ?? error}`);
    return failure('failed', 'Le service a rencontré une erreur.');
  }
}

/**
 * Vrai si `value` n'est faite que de données simples (nul, booléens, nombres
 * finis, textes, listes et objets ordinaires), dans les limites fixées.
 */
function isPlainData(value, limits = LIMITS) {
  let nodes = 0;
  let text = 0;
  const visit = (item, depth) => {
    nodes += 1;
    if (nodes > limits.nodes || depth > limits.depth) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') {
      text += item.length;
      return text <= limits.text;
    }
    if (Array.isArray(item)) return item.length <= limits.nodes && item.every((child) => visit(child, depth + 1));
    if (typeof item === 'object') {
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null) return false;
      return Object.entries(item).every(([key, child]) => {
        text += key.length;
        return text <= limits.text && visit(child, depth + 1);
      });
    }
    return false;
  };
  return visit(value, 0);
}

/**
 * @param {object} [options]
 * @param {(message: string) => void} [options.log]  journal des erreurs imprévues
 */
function createHub({ log = () => {} } = {}) {
  /** @type {Map<string, { methods: Map<string, Function>, events: Set<string>, status: Function|null }>} */
  const services = new Map();
  const listeners = new Set();

  return {
    /**
     * Déclare un service.
     * @param {string} name
     * @param {object} definition
     * @param {Record<string, (context: { origin: string|null }, ...args: any[]) => any>} definition.methods
     * @param {string[]} [definition.events]  événements que le service peut émettre
     * @param {() => object} [definition.status]  état détaillé, pour les comptes rendus
     * @returns {(event: string, payload: any, meta?: { origin?: string|null }) => void}
     *   fonction par laquelle le service émet ses événements
     */
    register(name, { methods, events = [], status = null }) {
      if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) throw new TypeError(`Nom de service invalide : ${name}`);
      if (services.has(name)) throw new Error(`Service déjà déclaré : ${name}`);
      const table = new Map(Object.entries(methods));
      for (const [method, handler] of table) {
        if (typeof handler !== 'function') throw new TypeError(`Méthode invalide : ${name}.${method}`);
      }
      const declared = new Set(events);
      services.set(name, { methods: table, events: declared, status });

      return (event, payload, { origin = null } = {}) => {
        if (!declared.has(event)) throw new Error(`Événement non déclaré : ${name}.${event}`);
        for (const listener of [...listeners]) {
          try {
            listener({ service: name, event, payload, origin });
          } catch (error) {
            log(`Abonné en erreur sur ${name}.${event} : ${error?.message ?? error}`);
          }
        }
      };
    },

    /**
     * Appelle une méthode d'un service. Ne lève jamais d'exception.
     * @param {string} name     service
     * @param {string} method   méthode
     * @param {any[]} [args]    arguments (données simples)
     * @param {object} [context]
     * @param {string|null} [context.origin]  qui appelle ; les événements qui
     *        découlent de l'appel portent cette origine
     * @returns {Promise<{ ok: true, value: any } | { ok: false, code: string, message: string }>}
     */
    async call(name, method, args = [], { origin = null } = {}) {
      const service = typeof name === 'string' ? services.get(name) : undefined;
      if (!service) return failure('unknown-service', 'Service inconnu.');
      const handler = typeof method === 'string' ? service.methods.get(method) : undefined;
      if (!handler) return failure('unknown-method', 'Méthode inconnue.');
      if (!Array.isArray(args) || args.length > LIMITS.args || !isPlainData(args)) {
        return failure('bad-arguments', 'Arguments refusés : seules des données simples, de taille raisonnable, sont admises.');
      }
      return reply(() => handler({ origin }, ...args), { log, label: `${name}.${method}` });
    },

    /**
     * Abonne `listener({ service, event, payload, origin })` à tous les
     * événements des services ; renvoie une fonction de désabonnement.
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Inventaire des services : méthodes, événements et état de chacun. */
    describe() {
      const inventory = {};
      for (const [name, service] of services) {
        let status;
        try {
          status = service.status ? service.status() : {};
        } catch (error) {
          status = { state: 'unavailable', error: String(error?.message ?? error) };
        }
        inventory[name] = { state: 'available', ...status, methods: [...service.methods.keys()], events: [...service.events] };
      }
      return inventory;
    },
  };
}

module.exports = { createHub, ServiceError, isPlainData, reply, LIMITS };

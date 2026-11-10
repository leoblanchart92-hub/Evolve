/**
 * Evolve — Mise en forme (français) des dates, heures, tailles et nombres.
 * Fonctions pures : testables sans navigateur.
 */

const LOCALE = 'fr-FR';

const timeFormat = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const secondsFormat = new Intl.DateTimeFormat(LOCALE, { second: '2-digit' });
const shortDateFormat = new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
const longDateFormat = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dayMonthFormat = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
const monthYearFormat = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' });
const fileDateFormat = new Intl.DateTimeFormat(LOCALE, {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export const capitalize = (text) => (text ? text.charAt(0).toLocaleUpperCase(LOCALE) + text.slice(1) : text);

/** « 10:42 » */
export const formatTime = (date) => timeFormat.format(date);

/** « 07 » (secondes sur deux chiffres) */
export const formatSeconds = (date) => secondsFormat.format(date).padStart(2, '0');

/** « 10/11/2026 » */
export const formatShortDate = (date) => shortDateFormat.format(date);

/** « Mardi 10 novembre 2026 » */
export const formatLongDate = (date) => capitalize(longDateFormat.format(date));

/** « Mardi 10 novembre » */
export const formatDayMonth = (date) => capitalize(dayMonthFormat.format(date));

/** « Novembre 2026 » */
export const formatMonthYear = (date) => capitalize(monthYearFormat.format(date));

/** « 10/11/2026 10:42 » (colonnes de l'explorateur) */
export const formatFileDate = (date) => fileDateFormat.format(date).replace(',', '');

/** Nombre au format français : 3,6 */
export function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Taille de fichier : « 512 o », « 340 Ko », « 2,3 Mo », « 1,5 Go ». */
export function formatSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${formatNumber(value, digits)}\u00a0${units[unit]}`;
}

/** Durée relative : « À l'instant », « Il y a 5 min », « Hier », « Il y a 3 jours »… */
export function formatRelative(date, now = new Date()) {
  const diff = now.getTime() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "À l'instant";
  if (diff < hour) return `Il y a ${Math.floor(diff / minute)} min`;
  if (diff < day) return `Il y a ${Math.floor(diff / hour)} h`;
  if (diff < 2 * day) return 'Hier';
  if (diff < 7 * day) return `Il y a ${Math.floor(diff / day)} jours`;
  return formatShortDate(date);
}

/** Accorde un nom : plural(1, 'élément') → « 1 élément », plural(3, 'élément') → « 3 éléments ». */
export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${formatNumber(count)} ${count > 1 ? pluralForm : singular}`;
}

/**
 * Browser-side language binding.
 *
 * The shared core in `src/i18n/core.js` holds the active language and the
 * dictionary; this module only adapts it to React and to the DSH locale
 * service, and it is the single place the client bundle reads the language
 * selection from. (Adapted from alexeyfadeev's PR #26.)
 *
 * DSH itself knows exactly two languages (`LOCALE_IDS = ["zh", "en"]` in
 * `@deepseek-ai/dsh-client-locale`), so "follow DSH Settings → Language" is a
 * plain read of its active locale rather than a mapping table.
 */
import { useSyncExternalStore } from "react";
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  LANGUAGE_LABELS,
  getLanguage,
  normalizeLanguage,
  setLanguage,
  subscribeLanguage,
  t
} from "../i18n/core.js";

export { t, setLanguage, getLanguage, normalizeLanguage, subscribeLanguage, LANGUAGES, LANGUAGE_LABELS, DEFAULT_LANGUAGE };

/** Snapshot identity must be stable across renders, so cache per language. */
const SNAPSHOTS = new Map(LANGUAGES.map((id) => [id, Object.freeze({ language: id })]));

function getSnapshot() {
  return SNAPSHOTS.get(getLanguage()) ?? SNAPSHOTS.get(DEFAULT_LANGUAGE);
}

/**
 * Subscribe a component to the active language. Every panel component calls
 * this, so a change in Settings → XSSH Tools repaints the whole plugin
 * immediately, without a page reload.
 */
export function useLanguage() {
  return useSyncExternalStore(subscribeLanguage, getSnapshot).language;
}

/**
 * The language DSH itself is showing, through whichever face the host
 * actually exposes (verified against dsh-client-locale on the real host):
 *  1. the documented LocaleFace read `getSnapshot().active`;
 *  2. `getLocale()`, which returns the same SNAPSHOT OBJECT (not a string);
 *  3. a dictionary probe: our own "xssh-ops" namespace registers a dedicated
 *     `languageProbe` key per language, so bind() resolving it tells us the
 *     active language even on a face that hides both readers above. The key is
 *     never displayed, so renaming any UI string cannot break this probe (an
 *     earlier version probed `sidebarTabTitle` and broke when the tab was renamed).
 */
export function readHostLanguage(locale) {
  const fromSnapshot = (snapshot) =>
    snapshot && typeof snapshot.active === "string" ? normalizeLanguage(snapshot.active) : null;
  try {
    const direct = fromSnapshot(locale?.getSnapshot?.());
    if (direct !== null) return direct;
  } catch {}
  try {
    const legacy = fromSnapshot(locale?.getLocale?.());
    if (legacy !== null) return legacy;
  } catch {}
  try {
    const translate = locale?.bind?.("xssh-ops");
    const probe = typeof translate === "function" ? translate("languageProbe") : null;
    if (probe === "en") return "en";
    if (probe === "zh") return "zh"; // i18n-ignore: probes the HOST dictionary, not our UI
  } catch {}
  return null;
}

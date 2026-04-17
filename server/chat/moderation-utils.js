'use strict';
/**
 * moderation-utils.js — Shared chat moderation logic for HoboStreamer.com
 *
 * This module is the single authoritative source for:
 *  - Text normalization (leet-char mapping, NFKD, de-duplication)
 *  - Built-in slur category pattern definitions
 *  - Matching helpers used by both server and client code
 *
 * SERVER AUTHORITATIVE: Even if the client pre-send check misses a variant,
 * the server always runs these same checks before forwarding the message.
 *
 * KEEP IN SYNC: The browser-side copy of these definitions lives in
 * public/js/chat.js as CHAT_CORE_SLUR_CATEGORIES. When updating patterns
 * here, update that constant there too (or vice-versa).
 */

// ── Leet-char substitution map ──────────────────────────────────────────────
// Applied before any pattern matching to catch common substitution ciphers.
const LEET_MAP = {
    '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a',
    '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
    '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't',
};

// ── Built-in slur category definitions ────────────────────────────────────
// Patterns are matched against normalizeSlurPatternText() output (spaces
// preserved, leet mapped, accents stripped, non-alphanumeric removed).
//
// N-word notes:
//   (?:a+[sz]?|e+r+[sz]?) catches:
//     base: nigga / nigger
//     plural: niggas / niggas / niggers / niggaz
//   The second pattern catches the "nicker/knicker" family (different root).
//   Both patterns are deliberately word-boundary anchored to reduce false positives.
const CORE_SLUR_CATEGORIES = [
    {
        key: 'n_word',
        label: 'N-word and variants',
        patterns: [
            // Base + plural forms: nigga, niggas, niggaz, nigger, niggers, niggaz
            '\\bn+i+g+g+(?:a+[sz]?|e+r+[sz]?)\\b',
            // Alternate root family: nicker, knicker, etc.
            '\\b[kn]*n+h?i+c?k+e+r+s?\\b',
        ],
    },
    {
        key: 'antisemitic',
        label: 'Antisemitic slurs',
        patterns: [
            '\\bk+\\s*y+\\s*k+\\s*e+\\b',
            '\\bj+\\s*e+\\s*w+\\s*s?\\s+w+\\s*i+\\s*l+\\s*l+\\s+n+\\s*o+\\s*t+\\s+r+\\s*e+\\s*p+\\s*l+\\s*a+\\s*c+\\s*e+\\b',
        ],
    },
    {
        key: 'homophobic',
        label: 'Homophobic slurs',
        patterns: [
            '\\bf+\\s*a+\\s*g+(?:o+\\s*t+)?[sz]?\\b',
        ],
    },
    {
        key: 'racial',
        label: 'Racial slurs (spic, chink)',
        patterns: [
            '\\bs+\\s*p+\\s*i+\\s*c+[sz]?\\b',
            '\\bc+\\s*h+\\s*i+\\s*n+\\s*k+[sz]?\\b',
        ],
    },
];

// Pre-compile all patterns at module load time.
for (const cat of CORE_SLUR_CATEGORIES) {
    cat.compiled = cat.patterns
        .map((src) => { try { return new RegExp(src, 'i'); } catch { return null; } })
        .filter(Boolean);
}

// ── Normalization helpers ────────────────────────────────────────────────────

/**
 * Heavy normalization: strip everything to just unambiguous letters.
 * Used for configured-term substring matching where inter-word boundaries
 * are not needed.
 *
 * Steps: lowercase → leet map → NFKD + accent strip → letters only → dedup consecutive chars
 */
function normalizeSlurText(input) {
    const lower = String(input || '').toLowerCase();
    const mapped = lower.split('').map((ch) => LEET_MAP[ch] || ch).join('');
    const ascii = mapped.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    const lettersOnly = ascii.replace(/[^a-z]/g, '');
    return lettersOnly.replace(/(.)\1{1,}/g, '$1');
}

/**
 * Pattern normalization: preserve word boundaries (spaces) so regex anchors work.
 * Used for core category pattern matching and custom regex matching.
 *
 * Steps: lowercase → leet map → NFKD + accent strip → collapse non-alphanum to spaces
 */
function normalizeSlurPatternText(input) {
    const lower = String(input || '').toLowerCase();
    const mapped = lower.split('').map((ch) => LEET_MAP[ch] || ch).join('');
    const ascii = mapped.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    return ascii.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Matching helpers ─────────────────────────────────────────────────────────

/**
 * Returns true if the normalized text hits any enabled built-in slur category.
 *
 * Two normalization passes are run:
 *  1. Space-preserved: "n i g g a" — catches word-boundary-separated attempts
 *  2. Space-collapsed: "nigga"    — catches letter-by-letter separation via dots/dashes
 *
 * @param {string} text - Raw message text (pre-normalization).
 * @param {string[]} disabledCategories - Category keys to skip (per-channel setting).
 */
function containsCoreSlur(text, disabledCategories = []) {
    const normalized = normalizeSlurPatternText(text);
    if (!normalized) return false;
    // Also test the space-collapsed form so patterns catch "n.i.g.g.a" → "nigga".
    const collapsed = normalized.replace(/\s+/g, '');
    const disabled = new Set(disabledCategories);
    return CORE_SLUR_CATEGORIES.some(
        (cat) => !disabled.has(cat.key) && cat.compiled.some(
            (pat) => pat.test(normalized) || (collapsed !== normalized && pat.test(collapsed))
        )
    );
}

/**
 * Returns true if the normalized text matches any of the provided custom regex lines.
 * Lines may be bare patterns or /pattern/flags wrapped patterns.
 *
 * @param {string} text - Raw message text.
 * @param {string[]} regexLines - Array of pattern strings (user-configured).
 */
function containsRegexSlur(text, regexLines) {
    const normalized = normalizeSlurPatternText(text);
    if (!normalized) return false;
    const compiled = compileRegexList(regexLines, { forceInsensitive: true });
    return compiled.some((pat) => pat.test(normalized));
}

/**
 * Returns true if the heavy-normalized text contains any of the configured term substrings.
 *
 * @param {string} text - Raw message text.
 * @param {string[]} terms - Array of configured term strings (user-configured).
 */
function containsConfiguredSlur(text, terms) {
    const normalizedText = normalizeSlurText(text);
    if (!normalizedText) return false;
    for (const term of terms) {
        const normalizedTerm = normalizeSlurText(term);
        if (!normalizedTerm || normalizedTerm.length < 2) continue;
        if (normalizedText.includes(normalizedTerm)) return true;
    }
    return false;
}

/**
 * Compile an array of raw pattern strings into RegExp objects.
 * Supports /pattern/flags wrapped syntax. Invalid patterns are silently skipped.
 *
 * @param {string[]} patternStrings
 * @param {{ forceInsensitive?: boolean }} opts
 * @returns {RegExp[]}
 */
function compileRegexList(patternStrings, { forceInsensitive = true } = {}) {
    const compiled = [];
    for (const raw of patternStrings || []) {
        if (!raw || raw.length > 200) continue;
        let source = raw;
        let flags = forceInsensitive ? 'i' : '';
        const slashWrapped = raw.match(/^\/(.+)\/([a-z]*)$/i);
        if (slashWrapped) {
            source = slashWrapped[1];
            flags = slashWrapped[2] || '';
            if (forceInsensitive && !flags.includes('i')) flags += 'i';
        }
        try {
            compiled.push(new RegExp(source, flags));
        } catch {
            // Ignore invalid user-provided regex patterns.
        }
    }
    return compiled;
}

// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
    LEET_MAP,
    CORE_SLUR_CATEGORIES,
    normalizeSlurText,
    normalizeSlurPatternText,
    containsCoreSlur,
    containsRegexSlur,
    containsConfiguredSlur,
    compileRegexList,
};

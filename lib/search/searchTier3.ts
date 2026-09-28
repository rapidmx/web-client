///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Tier 3 — server-assisted narrowing (`specs/search.md` §6/§14): for an encrypted message, the
 * server's own index has no `body`/`subject` field to match free text against (§2) - a free-text query
 * can only ever surface one via a `participants` coincidence or a pure-operator query. This module
 * closes that gap: it asks the server to narrow by metadata it can actually see (participants, dates,
 * folder, flags - never content, via `searchApi.ts#candidates()`), then fetches, decrypts, and matches
 * each candidate's real content client-side - the part the server structurally cannot do.
 *
 * **No new leakage** (§6): the server never learns which candidate actually matched, only that this
 * client asked about a bounded set of participants/dates/folders it could already see for delivery.
 *
 * Deliberately scoped to `entityType: "message"` only - contacts are never encrypted (Tier 1 already
 * covers them in full), and calendarEvent/note/task encryption has no client-side decrypt path
 * anywhere in this codebase yet (no calendar/notes/tasks E2E UI has been built), so including those
 * types here would just produce fetch/decrypt failures for entities this module has no way to open.
 */
import type { UnlockedKeys } from "../crypto/keySession.js";
import { evaluateMessageSecurity, type MessageSecurityResult } from "../crypto/messageSecurity.js";
import { getMessage, getMessageRawContent } from "../mail/mailApi.js";
import type { ParsedSearchQuery } from "./queryGrammar.js";
import { SEARCH_FIELD_WEIGHTS } from "./searchScoring.js";
import { candidates, SearchResult } from "./searchApi.js";

/** Longest decrypted HTML body `stripHtml()` examines, in UTF-16 code units - content past it is ignored
 * for Tier 3 matching. A hostile sender controls this input entirely, so it is bounded on top of the
 * stripper itself being linear-time. */
export const TIER3_MAX_HTML_LENGTH = 2_000_000;

/** Finds the next `</name` close tag at or after `from`, memoizing per tag name so repeated lookups
 * across one input never rescan the same text: a cached position still ahead of `from` is reused, and a
 * cached "no close tag at all" (-1) stays true for every later `from`. Total work is linear in `lower`. */
function makeCloseTagFinder(lower: string): (name: "script" | "style", from: number) => number {
    const cache: Record<string, number> = {};
    return (name, from) => {
        const cached = cache[name];
        if (cached === -1 || (cached !== undefined && cached >= from)) {
            return cached;
        }
        const found = lower.indexOf(`</${name}`, from);
        cache[name] = found;
        return found;
    };
}

/** Which raw-text element (`script`/`style`) a tag body (the text between `<` and `>`) opens, if any. */
function rawTextElementOf(tagBody: string): "script" | "style" | undefined {
    const match = /^(script|style)(?=[\s/]|$)/i.exec(tagBody);
    return match ? (match[1].toLowerCase() as "script" | "style") : undefined;
}

/** Strips HTML down to plain text for content matching. Deliberately not `dompurify` (used elsewhere
 * in this codebase for sanitizing a decrypted body before it touches a real DOM) - `dompurify` only
 * produces a working `sanitize()` once handed a real `window`, which this module cannot assume: it
 * needs to run identically in a browser tab, an Electron renderer, and this package's own Node-based
 * test suite (no jsdom - `pkijs`'s ECDH key derivation, which every test here depends on, breaks under
 * jsdom's WebCrypto shim). This is not a security boundary - the output only ever feeds a
 * case-insensitive substring match, never rendered back into any DOM.
 *
 * A single left-to-right pass rather than the previous `/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi` regex,
 * which backtracked quadratically on a body of repeated unclosed `<style>` tags (round-4 review: 280 KB
 * took over a second, growing 4x per doubling). `<script>`/`<style>` elements are dropped with their
 * content up to the matching close tag; an unclosed one drops only its own tag (matching the old
 * behavior); any other `<...>` tag becomes a space; an unterminated `<` is kept as text. */
export function stripHtml(html: string): string {
    const input = html.length > TIER3_MAX_HTML_LENGTH ? html.slice(0, TIER3_MAX_HTML_LENGTH) : html;
    const findClose = makeCloseTagFinder(input.toLowerCase());
    const pieces: string[] = [];
    let position = 0;
    while (position < input.length) {
        const open = input.indexOf("<", position);
        if (open === -1) {
            pieces.push(input.slice(position));
            break;
        }
        pieces.push(input.slice(position, open));
        const close = input.indexOf(">", open + 1);
        if (close === -1) {
            pieces.push(input.slice(open));
            break;
        }
        if (close === open + 1) {
            // `<>` is not a tag - kept as text, as the old `<[^>]+>` pattern did.
            pieces.push("<>");
            position = close + 1;
            continue;
        }
        pieces.push(" ");
        position = close + 1;
        const element = rawTextElementOf(input.slice(open + 1, Math.min(close, open + 8)));
        if (element) {
            const endTag = findClose(element, position);
            if (endTag !== -1) {
                const endTagClose = input.indexOf(">", endTag);
                position = endTagClose === -1 ? input.length : endTagClose + 1;
            }
        }
    }
    return pieces
        .join("")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;/gi, "'")
        .replace(/\s+/g, " ")
        .trim();
}

interface FreeTextTerm {
    /** The literal text to match - a whole phrase (quotes stripped) or a single word. */
    text: string;
    /** `true` for a `-`-prefixed term (`-word`/`-"a phrase"`) - `haystack` must NOT contain it. */
    negated: boolean;
    /** `true` when this term came from a `"quoted phrase"` - kept separate from a plain word so an
     * exact, literal `"OR"` (quoted) is never mistaken for the `OR` group separator below. */
    isPhrase: boolean;
}

/** Tokenizes `queryText`'s free-text remainder the same way `queryGrammar.ts`'s own doc comment says a
 * provider's free-text engine is expected to (Postgres's `websearch_to_tsquery` in particular) - a
 * `"quoted phrase"` is one term, and a leading `-` (`-word`/`-"a phrase"`) negates it. Without this,
 * Tier 3's own matching silently diverged from Tier 1's (a quoted phrase split into separate
 * AND-matched words; `-excluded` treated as a literal required word instead of a negation) - `specs/
 * search.md` §14 requires the same query language across tiers "or the tiering becomes visible to the
 * user." */
function tokenizeFreeText(queryText: string): FreeTextTerm[] {
    const terms: FreeTextTerm[] = [];
    const pattern = /(-?)"([^"]*)"|(-?)(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(queryText)) !== null) {
        if (match[2] !== undefined) {
            if (match[2]) {
                terms.push({ text: match[2], negated: match[1] === "-", isPhrase: true });
            }
        } else {
            // match[4] is always non-empty here: the `(-?)(\S+)` alternative only ever matches via `\S+`,
            // which requires at least one character.
            terms.push({ text: match[4], negated: match[3] === "-", isPhrase: false });
        }
    }
    return terms;
}

/** Splits a flat term list into `OR`-separated alternative groups (each an implicit AND of its own
 * terms), mirroring `websearch_to_tsquery`'s `OR` support - `budget OR forecast` matches either, not
 * both. A bare, unquoted, unnegated `OR` token is the separator itself, never matched against content;
 * an empty group (a leading/trailing/doubled `OR`) is dropped. */
function groupByOr(terms: FreeTextTerm[]): FreeTextTerm[][] {
    const groups: FreeTextTerm[][] = [[]];
    for (const term of terms) {
        if (!term.isPhrase && !term.negated && term.text === "OR") {
            groups.push([]);
        } else {
            groups[groups.length - 1].push(term);
        }
    }
    return groups.filter((group) => group.length > 0);
}

/** The positive (non-negated, non-`OR`-separator) term texts in `queryText`, for scoring/snippet
 * purposes only - those don't need OR's alternative-groups structure, just "what to count/highlight". */
function positiveTermTexts(queryText: string): string[] {
    return tokenizeFreeText(queryText)
        .filter((term) => !term.negated && !(term.isPhrase === false && term.text === "OR"))
        .map((term) => term.text);
}

/** `true` when `haystack` satisfies `queryText`'s free-text remainder - quoted phrases matched whole,
 * a `-`-prefixed term required absent, and (at least) one `OR`-separated group's terms all satisfied.
 * An empty `queryText` (a pure-operator query - the operators themselves already did the narrowing)
 * matches unconditionally. */
function matchesFreeText(queryText: string, haystack: string): boolean {
    const terms = tokenizeFreeText(queryText);
    if (terms.length === 0) {
        return true;
    }
    const groups = groupByOr(terms);
    if (groups.length === 0) {
        return true;
    }
    const lowerHaystack = haystack.toLowerCase();
    return groups.some((group) =>
        group.every((term) => {
            const present = lowerHaystack.includes(term.text.toLowerCase());
            return term.negated ? !present : present;
        }),
    );
}

/** Counts (case-insensitive, overlapping-safe-enough for scoring purposes) occurrences of every
 * positive term/phrase in `queryText` within `haystack` - used only to weight a match's score, not to
 * decide whether it matches at all (`matchesFreeText()` already decided that).
 *
 * Returns the same flat `1` for a query with real free text that happens to be entirely `-negated`
 * (e.g. `-spam -junk`) as for a true pure-operator query with no free text at all - there is no positive
 * term to count occurrences of either way, so no content-relevance signal exists to differentiate on.
 * This is not a scoring regression relative to Tier 1: `PostgresFullTextSearchProvider`'s own
 * `ts_rank(search_vector, websearch_to_tsquery(...))` degrades identically for an all-negative tsquery
 * (no positive lexeme contributes rank weight), so every Tier 1 result for the same query is equally
 * flat before `normalizeServerScores()` sinks both tiers' batches to `0` together - consistent, not a
 * one-sided disadvantage for Tier 3. */
function countTermOccurrences(queryText: string, haystack: string): number {
    const terms = positiveTermTexts(queryText);
    if (terms.length === 0) {
        return 1;
    }
    const lowerHaystack = haystack.toLowerCase();
    return terms.reduce((total, term) => {
        // Never empty: tokenizeFreeText() only ever pushes a term with at least one character, whether
        // matched via `\S+` (which requires one) or a quoted phrase (explicitly checked non-empty there).
        const lowerTerm = term.toLowerCase();
        let count = 0;
        let index = lowerHaystack.indexOf(lowerTerm);
        while (index !== -1) {
            count += 1;
            index = lowerHaystack.indexOf(lowerTerm, index + lowerTerm.length);
        }
        return total + count;
    }, 0);
}

/** Builds a snippet the same way `specs/search.md` §7 "Snippets" requires for a Tier 3 result -
 * "the client MUST generate snippets locally for any result it has decrypted... so snippet presence
 * does not visibly differ by tier." A window of context around the first matched term when there is
 * free text to match on, otherwise the start of the body (falling back to the subject if the body is
 * empty). Never called with both `subjectText`/`bodyText` empty - the caller's own
 * `!security.html && !security.subject` guard already discards a candidate with nothing at all before
 * reaching this function. */
function buildSnippet(queryText: string, subjectText: string, bodyText: string): string {
    const source = bodyText || subjectText;
    const terms = positiveTermTexts(queryText);
    const lowerSource = source.toLowerCase();
    let matchIndex = -1;
    for (const term of terms) {
        const index = lowerSource.indexOf(term.toLowerCase());
        if (index !== -1 && (matchIndex === -1 || index < matchIndex)) {
            matchIndex = index;
        }
    }
    const CONTEXT_BEFORE = 40;
    const CONTEXT_AFTER = 100;
    const start = matchIndex === -1 ? 0 : Math.max(0, matchIndex - CONTEXT_BEFORE);
    const end = matchIndex === -1 ? Math.min(source.length, CONTEXT_BEFORE + CONTEXT_AFTER) : Math.min(source.length, matchIndex + CONTEXT_AFTER);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < source.length ? "…" : "";
    return `${prefix}${source.slice(start, end).trim()}${suffix}`;
}

function hasAnyFilter(parsed: ParsedSearchQuery): boolean {
    return Boolean(
        parsed.text ||
            parsed.from ||
            parsed.to ||
            parsed.cc ||
            parsed.subject ||
            parsed.hasAttachment !== undefined ||
            parsed.before ||
            parsed.after ||
            parsed.folderUid ||
            parsed.flags?.length ||
            parsed.labels?.length,
    );
}

/** How many candidates are fetched/decrypted at once - bounds the burst of raw-MIME requests and
 * concurrent WebCrypto work a large candidate page would otherwise fire all at once. */
export const TIER3_DECRYPT_CONCURRENCY = 4;

/** `Promise.allSettled()` over `items`, but never running more than `concurrency` `task`s at a time.
 * Outcomes are returned in `items`' own order. */
async function settleWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
    const outcomes: PromiseSettledResult<R>[] = new Array(items.length);
    let next = 0;
    async function worker(): Promise<void> {
        while (next < items.length) {
            const index = next++;
            try {
                outcomes[index] = { status: "fulfilled", value: await task(items[index]) };
            } catch (reason) {
                outcomes[index] = { status: "rejected", reason };
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return outcomes;
}

export interface SearchEncryptedCandidatesOptions {
    /** Forwarded to `candidates()` - which accessible mailbox to search (e.g. the one currently open).
     * Omitted, the server uses the caller's own mailbox. */
    mailboxUid?: string;
}

/**
 * Runs Tier 3 for one parsed query: fetches a bounded candidate set from the server, decrypts each
 * candidate this device can open (at most `TIER3_DECRYPT_CONCURRENCY` at a time), and returns only the
 * ones whose real (decrypted) content actually matches - each with a raw (not yet normalized) score the
 * caller should run through `searchScoring.ts#normalizeServerScores()` alongside Tier 1's own scores
 * before merging.
 *
 * Honors every operator `parseSearchQuery()` produces, not just free text: `subject:` must appear
 * (case-insensitively) in the *decrypted* subject, and `has:attachment` is checked against the
 * message's own `Message.hasAttachments` (fetched via `getMessage()` before decrypting, so a mismatch
 * never pays for a decrypt). The candidates endpoint accepts neither filter, so both are applied here.
 *
 * Returns `[]` (never throws) when `unlocked` is absent or destroyed (`UnlockedKeys.destroyed`, checked on
 * entry, before each decrypt and again before building results) - nothing can be decrypted without it, so
 * there is nothing this tier can contribute - or when the query has no free text and no structured
 * filter at all, mirroring `BaseSearchRoute`'s own "at least one of q or a filter" requirement rather
 * than pulling a pointless full-mailbox candidate set.
 */
export async function searchEncryptedCandidates(
    parsed: ParsedSearchQuery,
    unlocked: UnlockedKeys | undefined,
    limit = 50,
    options: SearchEncryptedCandidatesOptions = {},
): Promise<SearchResult[]> {
    if (!unlocked || unlocked.destroyed || !hasAnyFilter(parsed)) {
        return [];
    }

    const participants = [parsed.from, parsed.to, parsed.cc].filter((value): value is string => Boolean(value));

    const page = await candidates({
        types: ["message"],
        participants: participants.length > 0 ? participants : undefined,
        before: parsed.before,
        after: parsed.after,
        folderUid: parsed.folderUid,
        flags: parsed.flags,
        labels: parsed.labels,
        limit,
        mailboxUid: options.mailboxUid,
    });

    const settled = await settleWithConcurrency(
        page.candidates.filter((candidate) => candidate.entityType === "message"),
        TIER3_DECRYPT_CONCURRENCY,
        async (candidate) => {
            if (parsed.hasAttachment !== undefined) {
                const message = await getMessage(candidate.entityUid);
                if (Boolean(message.hasAttachments) !== parsed.hasAttachment) {
                    return undefined;
                }
            }
            const rawMime = await getMessageRawContent(candidate.entityUid);
            if (unlocked.destroyed) {
                return undefined;
            }
            const security: MessageSecurityResult = await evaluateMessageSecurity(rawMime, unlocked);
            return { entityUid: candidate.entityUid, security };
        },
    );

    if (unlocked.destroyed) {
        // Locked while candidates were being fetched/decrypted - don't surface decrypted content after a lock.
        return [];
    }
    const subjectFilter = parsed.subject?.toLowerCase();
    const results: SearchResult[] = [];
    for (const outcome of settled) {
        if (outcome.status === "rejected" || !outcome.value) {
            continue;
        }
        const { entityUid, security } = outcome.value;
        if (!security.html && !security.subject) {
            // Nothing recovered - unprotected with no content override, a failed decrypt, or a
            // signature failure with no body - this candidate contributes nothing Tier 1 didn't
            // already have a chance to see, so there's no point matching against it here.
            continue;
        }
        const subjectText = security.subject ?? "";
        // Prefer the raw plain text when the body was text/plain - `html` is then only an escaped
        // `<pre>` rendering of it (always set alongside `text`, so the guard above needn't check
        // `text` separately) - and fall back to stripping a real text/html body.
        const bodyText = security.text ?? (security.html ? stripHtml(security.html) : "");
        if (subjectFilter && !subjectText.toLowerCase().includes(subjectFilter)) {
            continue;
        }
        const haystack = `${subjectText} ${bodyText}`;
        if (!matchesFreeText(parsed.text, haystack)) {
            continue;
        }
        const score =
            countTermOccurrences(parsed.text, subjectText) * SEARCH_FIELD_WEIGHTS.subject +
            countTermOccurrences(parsed.text, bodyText) * SEARCH_FIELD_WEIGHTS.body;
        results.push({
            entityType: "message",
            entityUid,
            score,
            source: "candidate",
            metadataOnly: false,
            snippet: buildSnippet(parsed.text, subjectText, bodyText),
        });
    }
    return results;
}

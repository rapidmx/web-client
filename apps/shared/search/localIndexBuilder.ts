///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The Tier 2 local index's background builder (`specs/search.md` §11 "Initial build... incrementally,
 * newest-first"). Runs on the main thread - the actual storage I/O and encryption happen in
 * `localIndexWorker.ts` (off the UI thread, per that file's own doc comment); this module's own work is
 * orchestration (deciding what to fetch) plus already-async fetch/decrypt calls, not CPU-heavy work that
 * would itself need to move off-thread.
 *
 * **Known scoping simplification**: walks the mailbox's real mail folders one at a time (a fixed,
 * reasonable priority order - Inbox and Sent first), each already newest-first via `listMessages()`'s own
 * default sort, rather than a true interleaved k-way merge producing one single globally-newest-first
 * stream across folders. A message in, say, Sent slightly older than the *oldest-processed-so-far*
 * message in Inbox can therefore be indexed slightly out of true global date order relative to it. Given
 * the byte-budget eviction below is itself date-based (oldest `date_for_sort` first, enforced by
 * `localIndexWorker.ts`'s own `applyEviction()` after every insert - see that file), a small amount of
 * cross-folder interleaving imprecision here does not affect *what* ultimately survives the window, only
 * the exact order entities are inserted (and therefore briefly evicted-and-reinserted) in.
 *
 * Only encrypted messages (`subject === "[...]"`) are indexed - see `ENCRYPTED_SUBJECT_PLACEHOLDER`'s
 * own precedent in `apps/www/index.tsx`'s inbox-list decrypt work. An unencrypted message is already
 * fully searchable via Tier 1; indexing it here too would spend this index's bounded byte budget on
 * content that didn't need it.
 */
import { getMessageRawContent, listFolders, listMessages, type Folder, type Message } from "@rapidmx/react-shared/mail/mailApi.js";
import { evaluateMessageSecurity } from "@rapidmx/react-shared/crypto/messageSecurity.js";
import type { UnlockedKeys } from "@rapidmx/react-shared/crypto/keySession.js";
import type { LocalIndexEntity } from "./localIndexSchema.js";
import {
    getIndexedVersions,
    indexLocalEntities,
    initLocalIndex,
    nextLocalIndexGeneration,
    pruneLocalEntities,
    setLocalIndexBuilding,
    setLocalIndexWindow,
} from "./localIndexRpcClient.js";
import { deriveLocalIndexKey } from "./localIndexKey.js";
import { getLocalIndexByteBudget } from "./localIndexSizePreference.js";

/** The RFC 9788 placeholder subject every encrypted message's outer envelope carries server-side - see
 * `apps/www/index.tsx`'s identical constant and its own doc comment for the full citation. */
const ENCRYPTED_SUBJECT_PLACEHOLDER = "[...]";

/** §11's Window Sizing table's time-floor column - explicitly unvalidated starting-point default per the
 * spec's own §16 "Measurement Task" ("cannot be supplied by design work... MUST NOT be treated as
 * validated"). Used as-is rather than invented/adjusted here. Not user-adjustable today (unlike the byte
 * budget - see `localIndexSizePreference.ts`) - nothing in this codebase has asked for that yet. */
export const WEB_TIME_FLOOR_MONTHS = 12;

/** Either bound as `0` means "no limit": `applyEviction()` (`localIndexWorker.ts`) already treats a
 * falsy byte budget as unconfigured/unenforced, and `buildLocalIndex()` below mirrors that same
 * convention for `timeFloorMonths` so a single `0` means the same thing in both dimensions. */
export interface LocalIndexWindowConfig {
    timeFloorMonths: number;
    byteBudgetBytes: number;
}

/** Folder types that actually hold messages, including `user` (custom folders). Inbox and Sent first: the two
 * folders a "did I find that email" search is overwhelmingly likely to land in, so they're covered soonest if
 * the build is interrupted (tab closed, idle timeout) partway through. */
const MESSAGE_FOLDER_TYPES = new Set(["inbox", "sent_items", "drafts", "deleted_items", "outbox", "junk", "archive", "user"]);
/** Folder types known not to hold mail. Any folder in neither set is skipped, and the pass is then not
 * complete - a type this module doesn't know about may well hold messages. */
const NON_MESSAGE_FOLDER_TYPES = new Set(["calendar", "contacts", "tasks", "notes"]);
const FOLDER_PRIORITY: Record<string, number> = { inbox: 0, sent_items: 1 };

/** How many times a pass walks a folder whose total count changed during the walk. `listMessages()` only
 * pages by offset, so a message removed from an already-walked page shifts a later one onto it unseen;
 * only a folder whose count held steady across a whole walk is trusted for completeness and pruning. */
export const MAX_WALK_ATTEMPTS = 3;

/** Subtracted from the pass's start time before it's recorded as the end of guaranteed coverage - a
 * message's server-assigned `receivedDate` can be ahead of this device's clock. */
export const CLOCK_SKEW_MARGIN_MS = 10 * 60 * 1000;

const PAGE_SIZE = 100;
const MAX_APPROX_BYTES_PER_MESSAGE_PADDING = 512; // subject/participants/flags overhead beyond raw text length
const FETCH_FAILED = Symbol("fetch-failed");

/** How many raw-MIME fetch+decrypt calls run at once - a page of 100 encrypted messages used to fire all
 * 100 requests simultaneously. */
export const FETCH_CONCURRENCY = 6;

/** `cutoff === undefined` means no time floor at all (an unbounded `windowConfig`) - every message is
 * "within" it, so the caller's own end-of-folder check (`messages.length < PAGE_SIZE`) becomes the only
 * stopping condition. */
function isWithinTimeFloor(receivedDate: string, cutoff: Date | undefined): boolean {
    return !cutoff || new Date(receivedDate).getTime() >= cutoff.getTime();
}

/** A relative weight only - the worker enforces the budget against the database's real measured size and
 * uses these per-row values just to decide how much of the oldest range to evict at once. UTF-8 bytes,
 * not UTF-16 code units. */
function estimateByteSize(entity: Pick<LocalIndexEntity, "subject" | "body" | "attachmentText" | "participants">): number {
    const encoder = new TextEncoder();
    const textBytes = [entity.subject, entity.body, entity.attachmentText, entity.participants].reduce(
        (total, value) => total + (value ? encoder.encode(value).length : 0),
        0,
    );
    return textBytes + MAX_APPROX_BYTES_PER_MESSAGE_PADDING;
}

/** The change marker stored per row: a new server `version` (flags, content) or a folder move both
 * invalidate the indexed copy. */
function versionOf(message: Message): string {
    return `${message.version}:${message.folderUid}`;
}

/** `Promise.all(items.map(fn))`, but with at most `limit` calls in flight. Preserves input order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    async function worker(): Promise<void> {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/** Decrypts one message and shapes it into a `LocalIndexEntity`, or `undefined` when nothing usable was
 * recovered (a decrypt failure, or a message that turns out not to actually be encrypted despite the
 * placeholder subject) - mirrors `searchTier3.ts`'s own `!security.html && !security.subject` discard
 * rule exactly, for the same reason. */
async function buildEntity(message: Message, unlocked: UnlockedKeys): Promise<LocalIndexEntity | undefined | typeof FETCH_FAILED> {
    let rawMime: Awaited<ReturnType<typeof getMessageRawContent>>;
    try {
        rawMime = await getMessageRawContent(message.uid);
    } catch {
        // Distinct from "undecryptable": a message that couldn't even be fetched may well be searchable,
        // so the pass can't claim complete coverage.
        return FETCH_FAILED;
    }
    try {
        const security = await evaluateMessageSecurity(rawMime, unlocked);
        if (!security.subject && !security.html) {
            return undefined;
        }
        const participants = [message.from.address, message.from.displayName, ...message.recipients.map((r) => r.address)]
            .filter(Boolean)
            .join(" ");
        const setFlags = Object.entries(message.flags)
            .filter(([, value]) => value)
            .map(([key]) => key);
        // Leading/trailing comma so `flags LIKE '%,x,%'` (localIndexSchema.ts's buildSearchPredicates())
        // matches correctly even for the first/last flag in the list.
        const flags = `,${setFlags.join(",")},`;
        const entity: LocalIndexEntity = {
            entityType: "message",
            entityUid: message.uid,
            mailboxUid: message.mailboxUid,
            folderUid: message.folderUid,
            dateForSort: message.receivedDate,
            participants,
            flags,
            hasAttachments: message.hasAttachments,
            subject: security.subject,
            body: security.html,
            byteSize: 0, // filled in below, after the fields above are known
            entityVersion: versionOf(message),
        };
        entity.byteSize = estimateByteSize(entity);
        return entity;
    } catch {
        // Best-effort, matching searchTier3.ts's own Promise.allSettled-per-candidate posture - one
        // message's fetch/decrypt failure never aborts the rest of the build.
        return undefined;
    }
}

/** Runs one full incremental build pass for `mailboxUid`: sets the window, walks mail folders newest-first
 * (per this module's own doc comment on the folder-order simplification), decrypts and indexes only
 * `"[...]"`-subject messages until each folder's own coverage passes the time floor, then clears the
 * `building` flag. Messages already indexed at the same version are skipped, fetches run at most
 * `FETCH_CONCURRENCY` at a time, and messages older than the eviction watermark (`WindowState.evictedBefore`)
 * are neither fetched nor walked past. A failure partway through leaves whatever was indexed so far in place
 * and records the pass as incomplete (spec §11's "incomplete-index UX... MUST indicate that coverage is
 * partial" - see `Coverage.complete`). Rows the server no longer lists (deleted or moved elsewhere by any
 * client) are pruned only within folders whose count held steady for a whole walk (see `MAX_WALK_ATTEMPTS`).
 *
 * Only one pass runs per mailbox (a newer call cancels the older), and every Worker call carries this pass's
 * generation, so a pass outlived by a destroy can't write anything (see `cancelLocalIndexBuild()`).
 *
 * `windowConfig` defaults to this device's own configured byte budget (`getLocalIndexByteBudget()` -
 * 500 MB in a browser tab, 1 GB in Electron, or whatever the user has since set in Settings > Encryption)
 * alongside the fixed time floor above. Evaluated fresh on every call with no explicit override, so a
 * preference change in Settings takes effect starting with this mailbox's next build pass (its next
 * unlock), without requiring a reload.
 */
export async function buildLocalIndex(
    mailboxUid: string,
    unlocked: UnlockedKeys,
    folders: Folder[],
    windowConfig: LocalIndexWindowConfig = { timeFloorMonths: WEB_TIME_FLOOR_MONTHS, byteBudgetBytes: getLocalIndexByteBudget() },
): Promise<void> {
    // At most one pass per mailbox: a newer one cancels the older and waits for it to wind down first.
    const previous = activeBuilds.get(mailboxUid);
    const controller = new AbortController();
    const run = (async () => {
        if (previous) {
            previous.controller.abort();
            await previous.settled;
        }
        await runBuildPass(mailboxUid, unlocked, folders, windowConfig, controller.signal);
    })();
    const entry: ActiveBuild = { controller, settled: run.catch(() => undefined) };
    activeBuilds.set(mailboxUid, entry);
    try {
        await run;
    } finally {
        if (activeBuilds.get(mailboxUid) === entry) {
            activeBuilds.delete(mailboxUid);
        }
    }
}

interface ActiveBuild {
    controller: AbortController;
    /** Resolves (never rejects) once the pass has fully stopped. */
    settled: Promise<void>;
}

const activeBuilds = new Map<string, ActiveBuild>();

/** Stops a mailbox's running build pass, if any (e.g. its keys were just destroyed), resolving once it has
 * wound down. The Worker independently rejects the pass's later calls once the index is destroyed (see
 * `GenerationParams`); this just stops the fetching and decrypting too. Never rejects. */
export async function cancelLocalIndexBuild(mailboxUid: string): Promise<void> {
    const active = activeBuilds.get(mailboxUid);
    if (active) {
        active.controller.abort();
        await active.settled;
    }
}

function isOlderThan(date: string, watermark: string | undefined): boolean {
    return !!watermark && new Date(date).getTime() < new Date(watermark).getTime();
}

/** How one folder's walk ended. */
type WalkOutcome =
    /** Reached the time floor or the end of the folder. */
    | "done"
    /** Reached messages older than the eviction watermark, which is itself within the time floor. */
    | "budget"
    /** A listing failed - nothing can be concluded about the rest of the folder. */
    | "failed";

async function runBuildPass(mailboxUid: string, unlocked: UnlockedKeys, folders: Folder[], windowConfig: LocalIndexWindowConfig, signal: AbortSignal): Promise<void> {
    const generation = nextLocalIndexGeneration();
    const indexKey = await deriveLocalIndexKey(unlocked.masterKey, mailboxUid);
    signal.throwIfAborted();
    await initLocalIndex({ mailboxUid, indexKey, generation });
    let { evictedBefore } = await setLocalIndexWindow(mailboxUid, windowConfig.timeFloorMonths, windowConfig.byteBudgetBytes, generation);
    await setLocalIndexBuilding(mailboxUid, true, { complete: false, generation });
    // Mail arriving after this moment isn't guaranteed to be picked up by this pass.
    const coveredUntil = new Date(Date.now() - CLOCK_SKEW_MARGIN_MS).toISOString();
    let cutoff: Date | undefined;
    if (windowConfig.timeFloorMonths > 0) {
        cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - windowConfig.timeFloorMonths);
    }
    // A pass is "complete" only if every folder was walked back to the time floor (or its end) with a stable
    // count, no listing/fetch failure and no budget cut-off - the only case where coverage can be used to
    // narrow Tier 3.
    let complete = true;
    try {
        if (folders.some((f) => !MESSAGE_FOLDER_TYPES.has(f.type) && !NON_MESSAGE_FOLDER_TYPES.has(f.type))) {
            complete = false;
        }
        const mailFolders = folders
            .filter((f) => MESSAGE_FOLDER_TYPES.has(f.type))
            .sort((a, b) => (FOLDER_PRIORITY[a.type] ?? 99) - (FOLDER_PRIORITY[b.type] ?? 99));
        const seenEncryptedUids = new Set<string>();

        async function walkFolder(folder: Folder): Promise<WalkOutcome> {
            for (let page = 0; ; page++) {
                signal.throwIfAborted();
                let messages: Message[];
                try {
                    messages = await listMessages(folder.uid, { page, limit: PAGE_SIZE });
                } catch {
                    return "failed";
                }
                if (messages.length === 0) {
                    return "done";
                }
                const encrypted = messages.filter((m) => m.subject === ENCRYPTED_SUBJECT_PLACEHOLDER);
                for (const m of encrypted) {
                    seenEncryptedUids.add(m.uid);
                }
                // Anything older than the eviction watermark would only be inserted and evicted again.
                const candidates = encrypted.filter((m) => !isOlderThan(m.receivedDate, evictedBefore));
                if (candidates.length > 0) {
                    // Skip anything already indexed at the same version - a re-unlock used to re-fetch and
                    // re-decrypt the entire window every time.
                    const indexed = await getIndexedVersions(
                        mailboxUid,
                        candidates.map((m) => m.uid),
                    );
                    const changed = candidates.filter((m) => indexed[m.uid] !== versionOf(m));
                    const built = await mapWithConcurrency(changed, FETCH_CONCURRENCY, (m) => buildEntity(m, unlocked));
                    signal.throwIfAborted();
                    if (built.includes(FETCH_FAILED)) {
                        complete = false;
                    }
                    const entities = built.filter((e): e is LocalIndexEntity => e !== undefined && e !== FETCH_FAILED);
                    if (entities.length > 0) {
                        ({ evictedBefore } = await indexLocalEntities(mailboxUid, entities, generation));
                    }
                }
                const oldestOnPage = messages[messages.length - 1].receivedDate;
                if (evictedBefore && isOlderThan(oldestOnPage, evictedBefore) && isWithinTimeFloor(evictedBefore, cutoff)) {
                    return "budget";
                }
                if (!isWithinTimeFloor(oldestOnPage, cutoff) || messages.length < PAGE_SIZE) {
                    return "done";
                }
            }
        }

        /** Each folder's current total, or `undefined` if the listing failed. */
        async function folderTotals(): Promise<Map<string, number> | undefined> {
            try {
                return new Map((await listFolders(mailboxUid)).map((f) => [f.uid, f.totalCount]));
            } catch {
                return undefined;
            }
        }

        // Folders walked with a steady count and no listing failure - the only ones whose unseen rows can be
        // pruned (deleted, or moved elsewhere by any client).
        const reliable: string[] = [];
        let totalsBefore = await folderTotals();
        let toWalk = mailFolders;
        for (let attempt = 0; attempt < MAX_WALK_ATTEMPTS && toWalk.length > 0; attempt++) {
            const outcomes = new Map<string, WalkOutcome>();
            for (const folder of toWalk) {
                outcomes.set(folder.uid, await walkFolder(folder));
            }
            const totalsAfter = await folderTotals();
            const changed: Folder[] = [];
            for (const folder of toWalk) {
                const outcome = outcomes.get(folder.uid);
                if (outcome === "failed" || !totalsBefore || !totalsAfter) {
                    // A failed listing, or no counts to vouch for the walk with: indexed as far as it got, but
                    // neither complete nor prunable (see the `reliable` check below).
                } else if (totalsAfter.get(folder.uid) === totalsBefore.get(folder.uid)) {
                    reliable.push(folder.uid);
                    complete &&= outcome === "done";
                } else {
                    changed.push(folder);
                }
            }
            totalsBefore = totalsAfter;
            toWalk = changed;
        }
        // Failed, count-less, or still changing after every attempt.
        if (reliable.length < mailFolders.length) {
            complete = false;
        }
        if (reliable.length > 0) {
            // Every reliable folder was walked back to at least the watermark (or the floor).
            const since = evictedBefore && isWithinTimeFloor(evictedBefore, cutoff) ? evictedBefore : cutoff?.toISOString();
            await pruneLocalEntities(mailboxUid, [...seenEncryptedUids], since, { folderUids: reliable, generation });
        }
    } catch (err) {
        complete = false;
        throw err;
    } finally {
        // Rejected (harmlessly) when the index was destroyed mid-pass.
        await setLocalIndexBuilding(mailboxUid, false, { complete, coveredFrom: cutoff?.toISOString(), coveredUntil, generation }).catch(() => undefined);
    }
}

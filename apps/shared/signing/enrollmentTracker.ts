///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useSyncExternalStore } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    CurrentSignEnrollment,
    EnrollmentResult,
    checkNowRetryAfterSeconds,
    checkSignEnrollmentNow,
    checkSignEnrollmentStatus,
} from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { SIGNING_ENROLLMENT_UNKNOWN } from "@rapidmx/react-shared/crypto/signingProviderApi.js";
import { storeSignEnrollment } from "./enrollmentStorage.js";
import { resetSigningInfo } from "./signingInfo.js";

/** The code of the 404 the server answers for an enrollment id it does not know (another provider after a configuration change, one long gone).
 * Re-exported from react-shared's `signingProviderApi.js` (R6's) rather than a second copy of the literal. */
export const UNKNOWN_ENROLLMENT_CODE = SIGNING_ENROLLMENT_UNKNOWN;

/**
 * Follows the signing-certificate enrollments this browser knows about, one per mailbox, for everyone who wants to show or react to one:
 * the Settings > Encryption card and the app frame's watcher share it, so an enrollment is asked about once however many look at it.
 *
 * An enrollment is a real e-mail round trip with a public CA (minutes), so it is read - not hammered: after the first answer it asks again
 * after 15 s, then 30 s, then every 60 s, **only while the page is visible** (a hidden tab asks nothing; coming back to the front, or the
 * window taking focus, asks at once and starts the backoff over), and it stops for good when the enrollment is issued or failed.
 * `checkNow()` is the user's "Check status": it asks the server to re-check with the CA, with a cooldown so it can't be spammed.
 *
 * Framework-free apart from the `useSyncExternalStore` hook at the bottom; safe where there is no window (nothing runs until `watch()`).
 */

/** The wait before each re-read of a pending enrollment: the last value repeats. */
export const ENROLLMENT_POLL_DELAYS_MS = [15_000, 30_000, 60_000];

/** How long "Check status" stays unavailable after a check (the server refuses one within about ten seconds of the last). */
export const ENROLLMENT_CHECK_COOLDOWN_MS = 10_000;

/** What came of the last manual check. */
export type CheckOutcome = "changed" | "unchanged" | "limited" | "failed";

export interface EnrollmentSnapshot {
    mailboxUid: string;
    enrollmentId: string;
    /** The latest answer. `null` until the server has answered (or when its answers never arrive). */
    result: EnrollmentResult | null;
    /** When this browser last got an answer (its own clock), or `null`. */
    answeredAt: number | null;
    /** A read is in flight. */
    checking: boolean;
    /** A manual check is in flight: the button's busy state. */
    checkingNow: boolean;
    /** "Check status" is unavailable until this time (epoch ms); `0` when it is available. */
    retryAt: number;
    /** The last read did not get an answer (offline, a server error) - what is shown is what was known. */
    offline: boolean;
    /** The server no longer knows this enrollment (404). */
    gone: boolean;
    /** The last manual check, for the words under the button. */
    lastCheck: { at: number; outcome: CheckOutcome } | null;
}

interface Entry {
    snapshot: EnrollmentSnapshot;
    refs: number;
    timer: ReturnType<typeof setTimeout> | undefined;
    /** Reads since the backoff began: picks the next delay. */
    attempt: number;
    /** A timer came due while the page was hidden: nothing is scheduled until it is visible again. */
    paused: boolean;
    /** Ended while this browser was watching a pending enrollment: worth announcing once. */
    expectPending: boolean;
    announced: boolean;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const terminalListeners = new Set<(snapshot: EnrollmentSnapshot) => void>();
let environmentBound = false;

function isVisible(): boolean {
    return typeof document === "undefined" || document.visibilityState === "visible";
}

function isTerminal(result: EnrollmentResult | null): boolean {
    return result?.status === "issued" || result?.status === "failed";
}

function emit(): void {
    listeners.forEach((listener) => listener());
}

function update(entry: Entry, patch: Partial<EnrollmentSnapshot>): void {
    entry.snapshot = { ...entry.snapshot, ...patch };
    emit();
}

function isCurrent(entry: Entry): boolean {
    return entries.get(entry.snapshot.mailboxUid) === entry;
}

function stop(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.paused = false;
}

function schedule(entry: Entry): void {
    stop(entry);
    const delay = ENROLLMENT_POLL_DELAYS_MS[Math.min(entry.attempt, ENROLLMENT_POLL_DELAYS_MS.length - 1)];
    entry.attempt += 1;
    entry.timer = setTimeout(() => {
        entry.timer = undefined;
        // (Whatever replaces or ends an entry clears its timer first, so this one is always for the entry as it is.)
        if (!isVisible()) {
            entry.paused = true;
            return;
        }
        void read(entry);
    }, delay);
}

/** Puts an answer on the entry and decides what happens next: keep asking, or end (and tell the watchers once). */
function apply(entry: Entry, result: EnrollmentResult, patch: Partial<EnrollmentSnapshot> = {}): void {
    if (!isCurrent(entry)) {
        return;
    }
    update(entry, { result, answeredAt: Date.now(), offline: false, gone: false, checking: false, ...patch });
    if (!isTerminal(result)) {
        schedule(entry);
        return;
    }
    stop(entry);
    // The enrollment is over: nothing is pending, so the id is not kept (it is what blocks a rotation across a reload).
    storeSignEnrollment(entry.snapshot.mailboxUid, null);
    if (entry.expectPending && !entry.announced) {
        entry.announced = true;
        terminalListeners.forEach((listener) => listener(entry.snapshot));
    }
}

/** A failed read: the server no longer has the enrollment (nothing is pending), or it could not be reached (assume it is still going). */
function fail(entry: Entry, err: unknown, patch: Partial<EnrollmentSnapshot> = {}): void {
    if (!isCurrent(entry)) {
        return;
    }
    if (err instanceof ApiRequestError && err.status === 404) {
        stop(entry);
        storeSignEnrollment(entry.snapshot.mailboxUid, null);
        update(entry, { gone: true, offline: false, checking: false, ...patch });
        return;
    }
    update(entry, { offline: true, checking: false, ...patch });
    schedule(entry);
}

async function read(entry: Entry): Promise<void> {
    update(entry, { checking: true });
    try {
        apply(entry, await checkSignEnrollmentStatus(entry.snapshot.mailboxUid, entry.snapshot.enrollmentId));
    } catch (err) {
        fail(entry, err);
    }
}

function resume(): void {
    if (!isVisible()) {
        return;
    }
    entries.forEach((entry) => {
        if (entry.paused && !isTerminal(entry.snapshot.result)) {
            entry.paused = false;
            entry.attempt = 0;
            void read(entry);
        }
    });
}

function bindEnvironment(): void {
    if (!environmentBound && typeof document !== "undefined") {
        environmentBound = true;
        document.addEventListener("visibilitychange", resume);
        window.addEventListener("focus", resume);
        window.addEventListener("online", resume);
    }
}

function unbindEnvironment(): void {
    if (environmentBound && entries.size === 0) {
        environmentBound = false;
        document.removeEventListener("visibilitychange", resume);
        window.removeEventListener("focus", resume);
        window.removeEventListener("online", resume);
    }
}

export interface WatchOptions {
    /** What is already known (a `getCurrentSignEnrollment()` answer): shown at once and not asked again first. */
    initial?: EnrollmentResult;
    /** This enrollment was pending when it was stored, so its ending is news (a stored id, a pending one found on the server). Default `true`. */
    expectPending?: boolean;
}

/**
 * Starts following `enrollmentId` for `mailboxUid` (one enrollment per mailbox; a different id replaces the old one) and returns the
 * function that lets go. Reads it now unless `initial` says what it is, then keeps reading with backoff while it is pending. Following is
 * shared, and a pending enrollment stays followed after everyone has let go (until it ends); an ended one is forgotten.
 */
export function watchEnrollment(mailboxUid: string, enrollmentId: string, options: WatchOptions = {}): () => void {
    const { initial, expectPending = true } = options;
    let entry = entries.get(mailboxUid);
    if (entry && entry.snapshot.enrollmentId !== enrollmentId) {
        stop(entry);
        entry = undefined;
    }
    if (entry) {
        entry.refs += 1;
        entry.expectPending ||= expectPending && !isTerminal(entry.snapshot.result);
        if (initial && !entry.snapshot.result) {
            apply(entry, initial);
        }
    } else {
        const created: Entry = {
            snapshot: {
                mailboxUid,
                enrollmentId,
                result: null,
                answeredAt: null,
                checking: false,
                checkingNow: false,
                retryAt: 0,
                offline: false,
                gone: false,
                lastCheck: null,
            },
            refs: 1,
            timer: undefined,
            attempt: 0,
            paused: false,
            expectPending,
            announced: false,
        };
        entries.set(mailboxUid, created);
        bindEnvironment();
        emit();
        if (initial) {
            apply(created, initial);
        } else {
            void read(created);
        }
    }
    const held = entries.get(mailboxUid)!;
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        held.refs -= 1;
        // A pending enrollment is followed on with nobody looking - that is what lets the frame tell the user it finished wherever they are, and
        // what the next visit to the page shows at once. One that ended (or that the server no longer knows) has nothing left to follow.
        if (held.refs <= 0 && isCurrent(held) && (isTerminal(held.snapshot.result) || held.snapshot.gone)) {
            stop(held);
            entries.delete(mailboxUid);
            unbindEnvironment();
            emit();
        }
    };
}

/** Whether a manual check changed what the user sees: the step, the state or the progress. */
function differs(before: EnrollmentResult | null, after: EnrollmentResult): boolean {
    return !before || before.status !== after.status || before.stage !== after.stage || before.progress !== after.progress;
}

/** "Check status": asks the server to re-check with the CA now. Does nothing while one is under way or within the cooldown. */
export async function checkEnrollmentNow(mailboxUid: string): Promise<void> {
    const entry = entries.get(mailboxUid);
    if (!entry || entry.snapshot.checkingNow || entry.snapshot.retryAt > Date.now() || isTerminal(entry.snapshot.result)) {
        return;
    }
    const before = entry.snapshot.result;
    update(entry, { checkingNow: true, checking: true });
    entry.attempt = 0;
    const done = (outcome: CheckOutcome, patch: Partial<EnrollmentSnapshot> = {}) => ({
        checkingNow: false,
        lastCheck: { at: Date.now(), outcome },
        ...patch,
    });
    try {
        const result = await checkSignEnrollmentNow(mailboxUid, entry.snapshot.enrollmentId);
        apply(entry, result, done(differs(before, result) ? "changed" : "unchanged", { retryAt: Date.now() + ENROLLMENT_CHECK_COOLDOWN_MS }));
        return;
    } catch (err) {
        const seconds = checkNowRetryAfterSeconds(err);
        if (seconds !== undefined) {
            update(entry, done("limited", { retryAt: Date.now() + seconds * 1000, checking: false }));
            return;
        }
        if (err instanceof ApiRequestError && err.status === 404 && err.code === UNKNOWN_ENROLLMENT_CODE) {
            // The server says this enrollment does not exist: there is nothing to fall back to.
            fail(entry, err, done("failed"));
            return;
        }
        if (!(err instanceof ApiRequestError && [404, 405, 501].includes(err.status))) {
            if (isCurrent(entry)) {
                update(entry, done("failed", { checking: false }));
            }
            return;
        }
    }
    // A server without the check endpoint: a plain read is the "check" it has - and a 404 there says the enrollment itself is gone.
    try {
        const result = await checkSignEnrollmentStatus(mailboxUid, entry.snapshot.enrollmentId);
        apply(entry, result, done(differs(before, result) ? "changed" : "unchanged", { retryAt: Date.now() + ENROLLMENT_CHECK_COOLDOWN_MS }));
    } catch (err) {
        fail(entry, err, done("failed"));
    }
}

/** Adopts an enrollment the server reported (`getCurrentSignEnrollment()`) - see `watchEnrollment()`. */
export function watchCurrentEnrollment(mailboxUid: string, current: CurrentSignEnrollment, expectPending = true): () => void {
    const { enrollmentId, ...result } = current;
    return watchEnrollment(mailboxUid, enrollmentId, { initial: result, expectPending });
}

/** Puts an answer the caller got itself (the reply to a cancel that found the certificate already issued) on `mailboxUid`'s enrollment, if it is the one followed. */
export function recordEnrollmentResult(mailboxUid: string, enrollmentId: string, result: EnrollmentResult): void {
    const entry = entries.get(mailboxUid);
    if (entry && entry.snapshot.enrollmentId === enrollmentId) {
        apply(entry, result);
    }
}

/** Stops following `mailboxUid`'s enrollment altogether (it was cancelled): nothing is kept, whoever else was watching. */
export function forgetEnrollment(mailboxUid: string): void {
    const entry = entries.get(mailboxUid);
    if (entry) {
        stop(entry);
        entries.delete(mailboxUid);
        unbindEnvironment();
        emit();
    }
}

/** The current state of `mailboxUid`'s followed enrollment, or `undefined` when none is followed. */
export function getEnrollmentSnapshot(mailboxUid: string): EnrollmentSnapshot | undefined {
    return entries.get(mailboxUid)?.snapshot;
}

export function subscribeToEnrollments(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Called once when an enrollment this browser was following ends (issued or failed) - the frame's watcher raises the pop-up. */
export function onEnrollmentEnded(listener: (snapshot: EnrollmentSnapshot) => void): () => void {
    terminalListeners.add(listener);
    return () => {
        terminalListeners.delete(listener);
    };
}

/** `mailboxUid`'s followed enrollment, kept current (`undefined` when none is followed). */
export function useEnrollmentSnapshot(mailboxUid: string | undefined): EnrollmentSnapshot | undefined {
    return useSyncExternalStore(
        subscribeToEnrollments,
        () => (mailboxUid ? getEnrollmentSnapshot(mailboxUid) : undefined),
        () => undefined,
    );
}

/** Forgets everything and stops every timer: for tests, which share the module. */
export function resetEnrollmentTracker(): void {
    resetSigningInfo();
    entries.forEach(stop);
    entries.clear();
    listeners.clear();
    terminalListeners.clear();
    unbindEnvironment();
    environmentBound = false;
}

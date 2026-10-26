///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Mounts the Tier 2 local index's lifecycle: starts the background build for the active mailbox once it's
 * unlocked, and destroys an index on the same events that destroy that mailbox's unlocked keys (spec §11
 * "MUST be destroyed on the same events that destroy private keys: explicit logout, session revocation,
 * and the configurable idle timeout").
 *
 * **Locks**: `localIndexRpcClient.ts` itself destroys an index it opened the moment `subscribeKeySession()` reports its mailbox locked,
 * whatever destroyed the keys (idle timeout, the manual button, a sign-out) and whether or not this component is still mounted. This
 * component subscribes to the same `locked` event to reset what it remembers of the mailbox (built, synced) at that moment, so a re-unlock
 * builds again - even one made before the next poll tick, which a poll alone would never see as a lock, leaving the destroyed index
 * unbuilt and every zero-access sync failing against it. Keys only ever go away through `destroyUnlockedKeys()`, which always reports
 * the lock, so the poll doesn't watch for a lock itself. A lock while a build is still deriving its index key, before anything is open
 * for the index client to destroy, is the builder's own to catch (`localIndexBuilder.ts`): it opens nothing with destroyed keys.
 *
 * Every mailbox this component has seen unlocked is tracked for the life of the mount - not just whichever
 * is active right now - so switching mailboxes (or a folders-list refresh re-running the build effect)
 * can never lose a pending unlocked-to-locked transition for a mailbox whose index was already built.
 *
 * **Explicit logout** navigates away immediately, which may not leave time for the lock's asynchronous destroy - `AppShell.tsx`
 * handles that case itself via `destroyAllLocalIndexes()`.
 */
import { useEffect, useRef } from "react";
import { getUnlockedKeys, subscribeKeySession } from "../../../lib/crypto/keySession.js";
import type { PublicKey } from "../../../lib/crypto/keyvaultApi.js";
import type { Folder } from "../../../lib/mail/mailApi.js";
import type { ApiClient } from "../../../lib/util/api.js";
import { useApiClient } from "../../../lib/util/apiClientContext.js";

/**
 * The index builder (with the message security code it decrypts through - PKI.js and the ASN.1/X.509 libraries, over half a
 * megabyte) is loaded only once a mailbox is actually unlocked and a build is due, so an inbox that never unlocks - the
 * common case - never downloads it.
 */
let builder: Promise<typeof import("./localIndexBuilder.js")> | undefined;
const loadBuilder = () =>
    (builder ??= import("./localIndexBuilder.js").catch((err) => {
        // A failed download is tried again the next time one is due.
        builder = undefined;
        throw err;
    }));
/** The zero-access index sync (`zeroAccessIndexSync.ts`), loaded the same way: only once a zero-access mailbox is unlocked. */
let syncer: Promise<typeof import("./zeroAccessIndexSync.js")> | undefined;
const loadSyncer = () =>
    (syncer ??= import("./zeroAccessIndexSync.js").catch((err) => {
        syncer = undefined;
        throw err;
    }));
import { pruneInaccessibleLocalIndexes } from "./localIndexRpcClient.js";

export const POLL_INTERVAL_MS = 5_000;

/** How often an unlocked zero-access mailbox's local index is brought up to date with the server's sealed index. */
export const ZERO_ACCESS_SYNC_INTERVAL_MS = 120_000;

export interface LocalIndexLifecycleProps {
    mailboxUid?: string;
    mailboxKeys?: PublicKey[];
    folders: Folder[];
    /** Every mailbox the signed-in user can currently access. Once known, indexes on this device for any
     * other mailbox (e.g. left behind by a different user who never signed out) are removed. */
    accessibleMailboxUids?: string[];
}

/** Renders nothing - pure side-effect component, mounted by `MailShell.tsx`. */
export default function LocalIndexLifecycle({ mailboxUid, folders, accessibleMailboxUids }: LocalIndexLifecycleProps) {
    // The explicit ApiClient (from useApiClient()) this component is rendered under - undefined for every existing caller (the SSR web/admin
    // apps, Electron), which keeps building the index against the default global cookie-based session exactly as before. A native,
    // multi-account host that renders this under an ApiClientContext.Provider gets its own account's client threaded through instead.
    const client = useApiClient();
    // mailboxUid -> whether it is unlocked as far as this component knows: set when its build starts, cleared by its lock. An entry exists
    // for every mailbox whose build this component started; never reset by an effect re-run.
    const trackedRef = useRef(new Map<string, boolean>());
    // The latest props (and client), for the long-lived polling interval below.
    const latestRef = useRef({ mailboxUid, folders, client });
    latestRef.current = { mailboxUid, folders, client };
    // mailboxUid -> when its last zero-access sync started. A mailbox syncs only once its build of this unlock settled (`builtRef` - the
    // sync writes into the index the build opened), first at once and then every interval; a mailbox in `syncingRef` has a pass running,
    // and never gets a second one alongside it. A lock forgets all three, so a pass still winding down never holds up the next unlock's.
    const lastSyncRef = useRef(new Map<string, number>());
    const builtRef = useRef(new Set<string>());
    // mailboxUid -> its latest build, so only that one's end starts the sync (not one a lock overtook).
    const buildsRef = useRef(new Map<string, symbol>());
    const syncingRef = useRef(new Map<string, symbol>());

    function syncIfDue(targetMailboxUid: string, targetClient: ApiClient | undefined) {
        const unlocked = getUnlockedKeys(targetMailboxUid);
        const last = lastSyncRef.current.get(targetMailboxUid);
        if (
            !unlocked?.zeroAccessKeys?.length ||
            !builtRef.current.has(targetMailboxUid) ||
            syncingRef.current.has(targetMailboxUid) ||
            (last !== undefined && Date.now() - last < ZERO_ACCESS_SYNC_INTERVAL_MS)
        ) {
            return;
        }
        lastSyncRef.current.set(targetMailboxUid, Date.now());
        const pass = Symbol(targetMailboxUid);
        syncingRef.current.set(targetMailboxUid, pass);
        loadSyncer()
            .then(({ syncZeroAccessIndex }) => syncZeroAccessIndex(targetMailboxUid, unlocked, targetClient))
            .catch(() => undefined)
            .finally(() => {
                if (syncingRef.current.get(targetMailboxUid) === pass) {
                    syncingRef.current.delete(targetMailboxUid);
                }
            });
    }

    function startBuildIfUnlocked(targetMailboxUid: string, targetFolders: Folder[], targetClient: ApiClient | undefined) {
        const unlocked = getUnlockedKeys(targetMailboxUid);
        if (!unlocked || targetFolders.length === 0 || trackedRef.current.get(targetMailboxUid)) {
            return;
        }
        trackedRef.current.set(targetMailboxUid, true);
        const build = Symbol(targetMailboxUid);
        buildsRef.current.set(targetMailboxUid, build);
        // Never an unhandled rejection - a broken local index is best-effort infrastructure, not a build
        // the rest of the app depends on.
        // The sync runs however the build ended: zero-access mail reaches the index only through it, and a build that failed part-way
        // isn't tried again until the next unlock. (Locked meanwhile, there are no keys to sync with.)
        void loadBuilder()
            .then(({ buildLocalIndex }) => buildLocalIndex(targetMailboxUid, unlocked, targetFolders, undefined, targetClient))
            .catch(() => undefined)
            .then(() => {
                if (buildsRef.current.get(targetMailboxUid) === build && trackedRef.current.get(targetMailboxUid)) {
                    builtRef.current.add(targetMailboxUid);
                    syncIfDue(targetMailboxUid, targetClient);
                }
            });
    }

    useEffect(() => {
        if (mailboxUid) {
            startBuildIfUnlocked(mailboxUid, folders, client);
        }
    }, [mailboxUid, folders, client]);

    // A lock forgets the mailbox at once: no build of this unlock counts as built any more (the cancelled build's end finds `buildsRef`
    // cleared and starts no sync), and the next unlock's tick starts a new build. The cancel and destroy themselves are
    // `localIndexRpcClient.ts`'s, which reacts to the same event.
    useEffect(
        () =>
            subscribeKeySession(({ mailboxUid: lockedUid, state }) => {
                if (state === "locked" && trackedRef.current.get(lockedUid)) {
                    trackedRef.current.set(lockedUid, false);
                    lastSyncRef.current.delete(lockedUid);
                    builtRef.current.delete(lockedUid);
                    syncingRef.current.delete(lockedUid);
                    buildsRef.current.delete(lockedUid);
                }
            }),
        [],
    );

    useEffect(() => {
        const interval = setInterval(() => {
            // The active mailbox was (re-)unlocked since the last check, e.g. via an on-demand unlock prompt.
            const { mailboxUid: activeUid, folders: activeFolders, client: activeClient } = latestRef.current;
            if (activeUid) {
                startBuildIfUnlocked(activeUid, activeFolders, activeClient);
                syncIfDue(activeUid, activeClient);
            }
        }, POLL_INTERVAL_MS);
        return () => clearInterval(interval);
    }, []);

    // A stable string key so a re-render with an equal-but-new array doesn't re-scan OPFS.
    const accessibleKey = accessibleMailboxUids && accessibleMailboxUids.length > 0 ? JSON.stringify([...accessibleMailboxUids].sort()) : "";
    useEffect(() => {
        if (accessibleKey) {
            void pruneInaccessibleLocalIndexes(JSON.parse(accessibleKey) as string[]);
        }
    }, [accessibleKey]);

    return null;
}

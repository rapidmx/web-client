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
 * **Why polling, not hooking the existing destroy call sites directly**: `destroyUnlockedKeys()`
 * (`react-shared/src/crypto/keySession.ts`) has no observer/callback hook. Watching `getUnlockedKeys()`
 * for a present-to-absent transition catches *every* destroy path uniformly - idle timeout, the manual
 * button, or anything else that calls it - without needing to know which one fired.
 *
 * Every mailbox this component has seen unlocked is tracked for the life of the mount - not just whichever
 * is active right now - so switching mailboxes (or a folders-list refresh re-running the build effect)
 * can never lose a pending unlocked-to-locked transition for a mailbox whose index was already built.
 *
 * **Explicit logout** navigates away immediately, which may not leave time for a poll tick - `AppShell.tsx`
 * handles that case itself via `destroyAllLocalIndexes()`.
 */
import { useEffect, useRef } from "react";
import { getUnlockedKeys } from "../../../lib/crypto/keySession.js";
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
import { destroyLocalIndex, pruneInaccessibleLocalIndexes } from "./localIndexRpcClient.js";

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
    // mailboxUid -> whether it was unlocked at the last check. An entry exists for every mailbox whose
    // build this component started; only ever changed by a real observed transition, never reset by an
    // effect re-run.
    const trackedRef = useRef(new Map<string, boolean>());
    // The latest props (and client), for the long-lived polling interval below.
    const latestRef = useRef({ mailboxUid, folders, client });
    latestRef.current = { mailboxUid, folders, client };
    // mailboxUid -> when its last zero-access sync started. Set only once its first build finished (the sync writes into the index the
    // build opened); a mailbox in `syncingRef` has a pass running, and never gets a second one alongside it.
    const lastSyncRef = useRef(new Map<string, number>());
    const syncingRef = useRef(new Set<string>());

    function syncIfDue(targetMailboxUid: string, targetClient: ApiClient | undefined, first = false) {
        const unlocked = getUnlockedKeys(targetMailboxUid);
        const last = lastSyncRef.current.get(targetMailboxUid);
        if (!unlocked?.zeroAccessKeys?.length || syncingRef.current.has(targetMailboxUid) || (!first && (last === undefined || Date.now() - last < ZERO_ACCESS_SYNC_INTERVAL_MS))) {
            return;
        }
        lastSyncRef.current.set(targetMailboxUid, Date.now());
        syncingRef.current.add(targetMailboxUid);
        loadSyncer()
            .then(({ syncZeroAccessIndex }) => syncZeroAccessIndex(targetMailboxUid, unlocked, targetClient))
            .catch(() => undefined)
            .finally(() => syncingRef.current.delete(targetMailboxUid));
    }

    function startBuildIfUnlocked(targetMailboxUid: string, targetFolders: Folder[], targetClient: ApiClient | undefined) {
        const unlocked = getUnlockedKeys(targetMailboxUid);
        if (!unlocked || targetFolders.length === 0 || trackedRef.current.get(targetMailboxUid)) {
            return;
        }
        trackedRef.current.set(targetMailboxUid, true);
        // Never an unhandled rejection - a broken local index is best-effort infrastructure, not a build
        // the rest of the app depends on.
        loadBuilder()
            .then(({ buildLocalIndex }) => buildLocalIndex(targetMailboxUid, unlocked, targetFolders, undefined, targetClient))
            .then(() => syncIfDue(targetMailboxUid, targetClient, true))
            .catch(() => undefined);
    }

    useEffect(() => {
        if (mailboxUid) {
            startBuildIfUnlocked(mailboxUid, folders, client);
        }
    }, [mailboxUid, folders, client]);

    useEffect(() => {
        const interval = setInterval(() => {
            for (const [trackedUid, wasUnlocked] of trackedRef.current) {
                if (wasUnlocked && !getUnlockedKeys(trackedUid)) {
                    // A present-to-absent transition: something just destroyed this mailbox's keys.
                    trackedRef.current.set(trackedUid, false);
                    lastSyncRef.current.delete(trackedUid);
                    // Stop the pass still running with the now-destroyed keys; the destroy itself also makes
                    // the Worker reject anything that pass still sends.
                    loadBuilder()
                        .then(({ cancelLocalIndexBuild }) => cancelLocalIndexBuild(trackedUid))
                        .catch(() => undefined);
                    void destroyLocalIndex(trackedUid);
                }
            }
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

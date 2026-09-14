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
import { getUnlockedKeys } from "@rapidmx/react-shared/crypto/keySession.js";
import type { PublicKey } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import type { Folder } from "@rapidmx/react-shared/mail/mailApi.js";
import { buildLocalIndex, cancelLocalIndexBuild } from "./localIndexBuilder.js";
import { destroyLocalIndex, pruneInaccessibleLocalIndexes } from "./localIndexRpcClient.js";

export const POLL_INTERVAL_MS = 5_000;

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
    // mailboxUid -> whether it was unlocked at the last check. An entry exists for every mailbox whose
    // build this component started; only ever changed by a real observed transition, never reset by an
    // effect re-run.
    const trackedRef = useRef(new Map<string, boolean>());
    // The latest props, for the long-lived polling interval below.
    const latestRef = useRef({ mailboxUid, folders });
    latestRef.current = { mailboxUid, folders };

    function startBuildIfUnlocked(targetMailboxUid: string, targetFolders: Folder[]) {
        const unlocked = getUnlockedKeys(targetMailboxUid);
        if (!unlocked || targetFolders.length === 0 || trackedRef.current.get(targetMailboxUid)) {
            return;
        }
        trackedRef.current.set(targetMailboxUid, true);
        // Never an unhandled rejection - a broken local index is best-effort infrastructure, not a build
        // the rest of the app depends on.
        buildLocalIndex(targetMailboxUid, unlocked, targetFolders).catch(() => undefined);
    }

    useEffect(() => {
        if (mailboxUid) {
            startBuildIfUnlocked(mailboxUid, folders);
        }
    }, [mailboxUid, folders]);

    useEffect(() => {
        const interval = setInterval(() => {
            for (const [trackedUid, wasUnlocked] of trackedRef.current) {
                if (wasUnlocked && !getUnlockedKeys(trackedUid)) {
                    // A present-to-absent transition: something just destroyed this mailbox's keys.
                    trackedRef.current.set(trackedUid, false);
                    // Stop the pass still running with the now-destroyed keys; the destroy itself also makes
                    // the Worker reject anything that pass still sends.
                    void cancelLocalIndexBuild(trackedUid);
                    void destroyLocalIndex(trackedUid);
                }
            }
            // The active mailbox was (re-)unlocked since the last check, e.g. via an on-demand unlock prompt.
            const { mailboxUid: activeUid, folders: activeFolders } = latestRef.current;
            if (activeUid) {
                startBuildIfUnlocked(activeUid, activeFolders);
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

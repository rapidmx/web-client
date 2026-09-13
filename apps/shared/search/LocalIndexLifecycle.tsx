///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Mounts the Tier 2 local index's lifecycle for one mailbox: starts the background build once it's
 * unlocked, and destroys the index on the same events that destroy the unlocked keys themselves (spec
 * §11 "MUST be destroyed on the same events that destroy private keys: explicit logout, session
 * revocation, and the configurable idle timeout").
 *
 * **Why polling, not hooking the existing destroy call sites directly**: `destroyUnlockedKeys()`
 * (`react-shared/src/crypto/keySession.ts`) has no observer/callback hook, and its own two real call
 * sites are `useIdleKeyTimeout.ts` (in `react-shared`, not this repo) and the manual "Destroy keys now"
 * button in Settings - editing the former would mean a react-shared source change that (per this
 * session's own earlier finding) doesn't reach `web-client` without a package republish + patch refresh
 * cycle, which is out of scope for wiring up a destroy signal. Watching `getUnlockedKeys()` for a
 * present-to-absent transition instead catches *every* destroy path uniformly - idle timeout, the manual
 * button, or anything else that calls it - without needing to know which one fired.
 *
 * **Explicit logout is the one gap this polling doesn't reliably cover**: `AppShell.tsx`'s sign-out
 * navigates away immediately, which may not leave time for a poll tick to fire first. That case is
 * handled separately, directly in `AppShell.tsx`, via `destroyAllLocalIndexes()` - see that call site's
 * own comment.
 */
import { useEffect, useRef } from "react";
import { getUnlockedKeys } from "@rapidmx/react-shared/crypto/keySession.js";
import type { PublicKey } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import type { Folder } from "@rapidmx/react-shared/mail/mailApi.js";
import { buildLocalIndex } from "./localIndexBuilder.js";
import { destroyLocalIndex } from "./localIndexRpcClient.js";

const POLL_INTERVAL_MS = 5_000;

export interface LocalIndexLifecycleProps {
    mailboxUid?: string;
    mailboxKeys?: PublicKey[];
    folders: Folder[];
}

/** Renders nothing - pure side-effect component, mounted by `MailShell.tsx` (which is where a
 * `mailboxUid` is actually known; `AppShell.tsx` itself is mailbox-agnostic, shared by every app). Each
 * `buildLocalIndex()` call below omits its `windowConfig` argument deliberately - that leaves the byte
 * budget to its own default, which already resolves per-device (Web vs. Electron) and per-user
 * preference (Settings > Encryption) on its own; see `localIndexBuilder.ts`/`localIndexSizePreference.ts`
 * for how. */
export default function LocalIndexLifecycle({ mailboxUid, folders }: LocalIndexLifecycleProps) {
    // Guards against re-triggering a build every time this component re-renders (e.g. on an unrelated
    // folders-list refresh) for a mailbox already built/building this session.
    const buildStartedForRef = useRef<string | undefined>(undefined);
    const wasUnlockedRef = useRef(false);

    useEffect(() => {
        if (!mailboxUid || folders.length === 0) {
            return;
        }
        const unlocked = getUnlockedKeys(mailboxUid);
        wasUnlockedRef.current = !!unlocked;
        if (unlocked && buildStartedForRef.current !== mailboxUid) {
            buildStartedForRef.current = mailboxUid;
            // Never an unhandled rejection - a broken local index (Worker/WASM/OPFS unsupported or
            // unavailable, a corrupted store) is best-effort infrastructure, not a build the rest of the
            // app depends on. searchTier2.ts's own callers already degrade gracefully independent of
            // whether a build ever completed at all.
            buildLocalIndex(mailboxUid, unlocked, folders).catch(() => undefined);
        }

        const interval = setInterval(() => {
            const stillUnlocked = !!getUnlockedKeys(mailboxUid);
            if (wasUnlockedRef.current && !stillUnlocked) {
                // A present-to-absent transition: something just destroyed this mailbox's unlocked keys
                // (idle timeout or the manual "Destroy keys now" button - see this module's own doc
                // comment on why this is observed rather than hooked directly).
                void destroyLocalIndex(mailboxUid);
                buildStartedForRef.current = undefined;
            } else if (!wasUnlockedRef.current && stillUnlocked && buildStartedForRef.current !== mailboxUid) {
                // The mailbox was re-unlocked this session (e.g. via ComposeWindow's or
                // MessageDetailPane's own on-demand unlock prompt) - start the build it missed the first
                // time around.
                buildStartedForRef.current = mailboxUid;
                buildLocalIndex(mailboxUid, getUnlockedKeys(mailboxUid)!, folders).catch(() => undefined);
            }
            wasUnlockedRef.current = stillUnlocked;
        }, POLL_INTERVAL_MS);

        return () => clearInterval(interval);
    }, [mailboxUid, folders]);

    return null;
}

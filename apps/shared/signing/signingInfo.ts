///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useState } from "react";
import { SigningEnrollmentInfo, getSigningEnrollmentInfo } from "@rapidmx/react-shared/crypto/signingProviderApi.js";

// The type and the request both come from react-shared's `signingProviderApi.js` (R6's) - this module only adds the caching, the
// never-rejects contract and the hook that Settings > Encryption and its card want. Re-exported so the rest of `signing/` and
// `SigningCertificateCard` keep importing `SigningEnrollmentInfo` from here rather than reaching into react-shared directly.
export type { SigningEnrollmentInfo };

/** How long an answer is reused: the page asks once when it opens, and again after this if it is opened again. */
export const SIGNING_INFO_CACHE_MS = 5 * 60_000;

let cached: { at: number; promise: Promise<SigningEnrollmentInfo | null> } | undefined;

/** The deployment's signing-enrollment description, or `null` when it cannot be had (an older server with no such endpoint, offline,
 * anything) - never rejects. One request at a time, reused for five minutes. */
export function fetchSigningEnrollmentInfo(now: number = Date.now()): Promise<SigningEnrollmentInfo | null> {
    if (cached && now - cached.at < SIGNING_INFO_CACHE_MS) {
        return cached.promise;
    }
    const promise = getSigningEnrollmentInfo().catch(() => null);
    cached = { at: now, promise };
    // An answer that could not be had is not worth remembering: the next visit asks again.
    void promise.then((info) => {
        if (info === null && cached?.promise === promise) {
            cached = undefined;
        }
    });
    return promise;
}

/** Forgets the remembered answer: for tests, which share the module. */
export function resetSigningInfo(): void {
    cached = undefined;
}

/** The deployment's description, once it is known: `undefined` while it is being asked for, `null` when there is none. Asks only while `enabled`. */
export function useSigningEnrollmentInfo(enabled: boolean): SigningEnrollmentInfo | null | undefined {
    const [info, setInfo] = useState<SigningEnrollmentInfo | null | undefined>(undefined);
    useEffect(() => {
        if (!enabled) {
            return;
        }
        let cancelled = false;
        void fetchSigningEnrollmentInfo().then((answer) => {
            if (!cancelled) {
                setInfo(answer);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [enabled]);
    return info;
}

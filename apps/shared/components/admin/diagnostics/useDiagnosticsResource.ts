///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useState } from "react";
import { describeError } from "./format.js";

export interface DiagnosticsResource<T> {
    /** What was last loaded. It stays while a reload is under way, and after a reload that failed. */
    data: T | undefined;
    /** Why the last load failed. */
    error: string | undefined;
    loading: boolean;
}

/**
 * Loads `load()` when the component mounts and again whenever `reloadKey` changes (the Refresh button). It is never polled.
 * The answer to a load that a newer one (or an unmount) has overtaken is dropped.
 */
export function useDiagnosticsResource<T>(load: () => Promise<T>, reloadKey: number, failure: string): DiagnosticsResource<T> {
    const [state, setState] = useState<DiagnosticsResource<T>>({ data: undefined, error: undefined, loading: true });

    useEffect(() => {
        let cancelled = false;
        setState((previous) => ({ ...previous, error: undefined, loading: true }));
        load().then(
            (data) => {
                if (!cancelled) {
                    setState({ data, error: undefined, loading: false });
                }
            },
            (err: unknown) => {
                if (!cancelled) {
                    setState((previous) => ({ ...previous, error: describeError(err, failure), loading: false }));
                }
            }
        );
        return () => {
            cancelled = true;
        };
    }, [reloadKey]);

    return state;
}

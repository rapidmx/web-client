///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";

export interface LoadedSettingsFormProps<T> {
    load: () => Promise<T>;
    /** Shown when loading fails with something other than an API error message. */
    loadErrorMessage: string;
    children: (value: T, onChange: (value: T) => void) => ReactNode;
}

/** Loads a settings object, then renders its form - the loading and error states every settings page shares. */
export default function LoadedSettingsForm<T>({ load, loadErrorMessage, children }: LoadedSettingsFormProps<T>) {
    const [value, setValue] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        load()
            .then(setValue)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : loadErrorMessage));
    }, []);

    if (error) {
        return <Alert>{error}</Alert>;
    }
    if (value === null) {
        return <p className="text-sm text-text-muted">Loading&hellip;</p>;
    }
    return <>{children(value, setValue)}</>;
}

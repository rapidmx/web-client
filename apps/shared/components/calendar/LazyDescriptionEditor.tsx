///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ComponentType, useEffect, useState } from "react";
import type { DescriptionEditorProps } from "./DescriptionEditor.js";

let loading: Promise<ComponentType<DescriptionEditorProps>> | undefined;
/** The editor once its chunk has arrived, so an editor drawn again (the quick popover growing into the card) starts as the editor, not as the placeholder. */
let loaded: ComponentType<DescriptionEditorProps> | undefined;

/** Fetches the editor's chunk once. A failed download is forgotten, so asking again tries again. */
function loadDescriptionEditor(): Promise<ComponentType<DescriptionEditorProps>> {
    loading ??= import("./DescriptionEditor.js").then(
        (module) => (loaded = module.default),
        (err: unknown) => {
            loading = undefined;
            throw err;
        },
    );
    return loading;
}

/**
 * `DescriptionEditor`, loaded when it is first drawn. The editor is TipTap and ProseMirror - a good deal of code that the calendar, and the reading pane's
 * invitation card, only need once somebody opens a description - so it is fetched then rather than with the page. Not `React.lazy()`: a chunk that fails to
 * download (offline, or a deploy that replaced it) is said so here with a retry, instead of throwing through the tree above.
 */
export default function LazyDescriptionEditor(props: DescriptionEditorProps) {
    const [Editor, setEditor] = useState<ComponentType<DescriptionEditorProps> | null>(() => loaded ?? null);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let current = true;
        loadDescriptionEditor().then(
            (component) => current && setEditor(() => component),
            () => current && setFailed(true),
        );
        return () => {
            current = false;
        };
    }, [attempt]);

    if (Editor) {
        return <Editor {...props} />;
    }
    if (failed) {
        return (
            <p role="alert" className="text-sm text-danger">
                The description editor couldn&rsquo;t be loaded.{" "}
                <button
                    type="button"
                    className="underline"
                    onClick={() => {
                        setFailed(false);
                        setAttempt((count) => count + 1);
                    }}
                >
                    Try again
                </button>
            </p>
        );
    }
    return (
        <div aria-busy="true" className="min-h-[7rem] rounded-md border border-border bg-surface-alt text-sm text-text-muted px-3 py-2">
            Loading the editor&hellip;
        </div>
    );
}

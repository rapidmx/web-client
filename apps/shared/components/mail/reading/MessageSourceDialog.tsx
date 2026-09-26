///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useMemo } from "react";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import CopyButton from "@rapidmx/react-shared/components/buttons/CopyButton.js";
import Drawer from "@rapidmx/react-shared/components/overlays/Drawer.js";
import { MAX_SOURCE_DISPLAY_CHARS, headerText, sourceText } from "./messageExport.js";

/** What the dialog is showing a message's source for: the whole of it, or only its header lines ("Message details"). */
export type SourceMode = "source" | "headers";

/** What has been fetched of the raw message: on its way, here, or refused. */
export type SourceState = { status: "loading" } | { status: "ready"; raw: string } | { status: "error"; message: string };

export interface MessageSourceDialogProps {
    open: boolean;
    onClose: () => void;
    mode: SourceMode;
    source: SourceState;
    /** The message is end-to-end encrypted: what is shown is the ciphertext the server holds, and the dialog says so. */
    encrypted: boolean;
}

const TITLES: Record<SourceMode, string> = { source: "Message source", headers: "Message details" };

/**
 * A message's raw source (or just its headers) in a full-window dialog, in a monospace block that can be scrolled and selected, with a Copy
 * button. It is the RFC 5322 text exactly as the server stores it - for an encrypted message that is the encrypted message, never a
 * decrypted one, and the dialog says so. A very long source is cut for display (`MAX_SOURCE_DISPLAY_CHARS`); Copy has all of it.
 */
export default function MessageSourceDialog({ open, onClose, mode, source, encrypted }: MessageSourceDialogProps) {
    const text = useMemo(() => {
        if (source.status !== "ready") {
            return "";
        }
        return mode === "headers" ? headerText(source.raw) : sourceText(source.raw);
    }, [source, mode]);
    const cut = text.length > MAX_SOURCE_DISPLAY_CHARS;
    const title = TITLES[mode];
    return (
        <Drawer open={open} onClose={onClose} title={title} fullScreen>
            <div className="flex flex-col gap-3 text-sm">
                {encrypted && (
                    <p role="note" className="py-2 px-3 rounded-sm bg-surface-alt text-text">
                        This message is encrypted. This is the encrypted message exactly as the server stores it; it is not decrypted here.
                    </p>
                )}
                {source.status === "loading" && (
                    <p role="status" className="text-text-muted">
                        Loading the message&hellip;
                    </p>
                )}
                {source.status === "error" && <Alert>{source.message}</Alert>}
                {source.status === "ready" && (
                    <>
                        <div className="flex flex-wrap items-center gap-3">
                            <CopyButton value={text} label={`Copy the ${mode === "headers" ? "message headers" : "message source"}`} />
                            {cut && (
                                <span className="text-xs text-text-muted">
                                    Showing the first {MAX_SOURCE_DISPLAY_CHARS.toLocaleString()} of {text.length.toLocaleString()} characters. Copy and Save as
                                    .eml keep all of it.
                                </span>
                            )}
                        </div>
                        <pre
                            tabIndex={0}
                            aria-label={title}
                            className="m-0 max-h-[70vh] overflow-auto rounded-sm border border-border bg-surface-alt p-3 font-mono text-xs whitespace-pre-wrap break-all"
                        >
                            {cut ? text.slice(0, MAX_SOURCE_DISPLAY_CHARS) : text}
                        </pre>
                    </>
                )}
            </div>
        </Drawer>
    );
}

///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect } from "react";
import { HiOutlineMinus, HiOutlineXMark } from "react-icons/hi2";
import Skeleton from "@rapidmx/react-shared/components/feedback/Skeleton.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import useIsMobile from "@rapidmx/react-shared/util/useIsMobile.js";
import type { ComposeSession } from "./ComposeContext.js";
import { markComposePhase } from "./composePerf.js";

export interface ComposeWindowPlaceholderProps {
    session: ComposeSession;
    /** The compose window's code couldn't be downloaded. */
    failed: boolean;
    onRetry: () => void;
    onClose: () => void;
    onToggleMinimize: () => void;
}

/**
 * What stands in for the compose window in the moment between clicking Compose/Reply/Forward and the window's code being
 * loaded (already there when it was prefetched, so usually not seen at all): the window's own frame at its own size and
 * place, its title and the recipients and subject the window will open with, all of which are known without the network -
 * so the click is answered on the same frame. It is deliberately tiny and lives in the page's own chunk.
 *
 * Nothing here can be typed into yet, and there is no draft to save or discard, so Close just closes.
 */
export default function ComposeWindowPlaceholder({ session, failed, onRetry, onClose, onToggleMinimize }: ComposeWindowPlaceholderProps) {
    const isMobile = useIsMobile();
    const title = session.initialSubject?.trim() || "New Message";
    const titleId = `compose-title-${session.id}`;

    useEffect(() => markComposePhase(session.id, "shell"), [session.id]);

    if (session.minimized) {
        return (
            <div role="dialog" aria-label={title} className="w-64 shrink-0 bg-surface border border-border border-b-0 rounded-t-md shadow-modal">
                <div className="h-10 flex items-center justify-between gap-2 px-3 rounded-t-md bg-primary-darker text-white cursor-pointer" onClick={onToggleMinimize}>
                    <span className="text-sm font-medium truncate">{title}</span>
                </div>
            </div>
        );
    }

    return (
        <div
            role="dialog"
            aria-labelledby={titleId}
            aria-busy={!failed}
            className={[
                "relative shrink-0 flex flex-col bg-surface border border-border shadow-modal overflow-hidden",
                isMobile ? "fixed inset-0 w-full h-full rounded-none border-0" : "border-b-0 rounded-t-md w-[480px] h-[520px]",
            ].join(" ")}
        >
            <div className="h-10 shrink-0 flex items-center justify-between gap-2 px-3 bg-primary-darker text-white cursor-pointer" onClick={onToggleMinimize}>
                <span id={titleId} className="text-sm font-medium truncate">
                    {title}
                </span>
                <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                    <button
                        type="button"
                        aria-label="Minimize"
                        title="Minimize"
                        onClick={onToggleMinimize}
                        className="w-6 h-6 flex items-center justify-center rounded-sm text-white/80 hover:bg-white/15 hover:text-white"
                    >
                        <HiOutlineMinus size={14} />
                    </button>
                    <button
                        type="button"
                        aria-label="Close"
                        title="Close"
                        onClick={onClose}
                        className="w-6 h-6 flex items-center justify-center rounded-sm text-white/80 hover:bg-white/15 hover:text-white"
                    >
                        <HiOutlineXMark size={14} />
                    </button>
                </div>
            </div>
            {failed ? (
                <div className="px-3 pt-2">
                    <Alert>
                        <p className="mb-2">The compose window couldn&rsquo;t be loaded. Check your connection and try again.</p>
                        <Button type="button" variant="secondary" className="!w-auto" onClick={onRetry}>
                            Retry
                        </Button>
                    </Alert>
                </div>
            ) : (
                <div role="status" className="flex-1 min-h-0 flex flex-col">
                    <span className="sr-only">Opening the compose window</span>
                    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-sm">
                        <span className="text-text-muted">To</span>
                        <span className="truncate">{session.initialTo}</span>
                    </div>
                    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-sm">
                        <span className="truncate">{session.initialSubject || <span className="text-text-muted">Subject</span>}</span>
                    </div>
                    <div className="flex-1 p-3 flex flex-col gap-2" aria-hidden="true">
                        <Skeleton height="h-4" />
                        <Skeleton height="h-4" />
                        <Skeleton height="h-4" />
                    </div>
                </div>
            )}
        </div>
    );
}

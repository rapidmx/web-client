///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ComponentType, useEffect, useState } from "react";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Skeleton from "@rapidmx/react-shared/components/feedback/Skeleton.js";
import type MessageDetailPaneType from "./MessageDetailPane.js";
import type ConversationThreadPaneType from "./ConversationThreadPane.js";

/**
 * The reading pane (`MessageDetailPane`, and the thread pane that stacks it) is only rendered once a message is selected, and
 * it is the heaviest piece of the inbox after the compose window - message security, the body sanitizer, the labels and move
 * menus - so it is a chunk of its own, downloaded when the browser is idle after the list has loaded (`prefetchReadingPane()`)
 * and, at the latest, on the first selection. Nothing about the pane changes: these wrap the same components, with a skeleton
 * while the chunk loads and a reload prompt if it can't.
 *
 * Deliberately not `React.lazy()` + `<Suspense>`: a boundary that has shown its fallback holds the content back for up to 300 ms
 * after the code arrives (React's fallback throttle), which would put a fifth of a second between a click and a pane whose
 * code was already fetched. This reads the loaded component synchronously when there is one, so an already-loaded pane renders
 * on the click's own frame, and it can retry a failed download.
 */
function lazyComponent<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
    let loaded: ComponentType<P> | undefined;
    let loading: Promise<ComponentType<P>> | undefined;

    /** Starts (once) loading the component's code. Rejects if it can't be downloaded - and then a later call tries again. */
    function start(): Promise<ComponentType<P>> {
        loading ??= load().then(
            (module) => (loaded = module.default),
            (err) => {
                loading = undefined;
                throw err;
            },
        );
        return loading;
    }

    function Lazy(props: P) {
        const [, setLoadedNow] = useState(0);
        const [failed, setFailed] = useState(false);
        useEffect(() => {
            if (loaded) {
                return;
            }
            let cancelled = false;
            start().then(
                () => !cancelled && setLoadedNow((n) => n + 1),
                () => !cancelled && setFailed(true),
            );
            return () => {
                cancelled = true;
            };
        }, []);
        if (loaded) {
            const Component = loaded;
            return <Component {...props} />;
        }
        return failed ? <ChunkFailed /> : <PaneSkeleton />;
    }

    return { Lazy, start };
}

function PaneSkeleton() {
    return (
        <div role="status" aria-busy="true" className="flex-1 p-6 flex flex-col gap-3">
            <span className="sr-only">Loading the message</span>
            <Skeleton width="w-2/3" height="h-6" />
            <Skeleton width="w-1/3" />
            <Skeleton height="h-40" />
        </div>
    );
}

/** A chunk that can't be downloaded (offline, or replaced by a deploy since this page loaded) is the one failure a reading
 * pane can't recover from by itself: say so, with the fix, rather than leaving a blank pane. */
function ChunkFailed() {
    return (
        <div className="flex-1 p-6">
            <Alert>
                <p className="mb-2">This part of the page couldn&rsquo;t be loaded. Check your connection, then reload.</p>
                <Button type="button" variant="secondary" className="!w-auto" onClick={() => window.location.reload()}>
                    Reload
                </Button>
            </Alert>
        </div>
    );
}

const messageDetailPane = lazyComponent<React.ComponentProps<typeof MessageDetailPaneType>>(() => import("./MessageDetailPane.js"));
const conversationThreadPane = lazyComponent<React.ComponentProps<typeof ConversationThreadPaneType>>(() => import("./ConversationThreadPane.js"));

/** Starts downloading the reading pane's code, for the page to call when it has nothing better to do. Never rejects. */
export function prefetchReadingPane(): void {
    messageDetailPane.start().catch(() => undefined);
    conversationThreadPane.start().catch(() => undefined);
}

/** With nothing selected the pane is only its empty-state line, which needs none of the pane's code - so the chunk isn't
 * requested until something is (or the page prefetches it). */
export function LazyMessageDetailPane(props: React.ComponentProps<typeof MessageDetailPaneType>) {
    if (!props.message) {
        return <p className="p-8 text-sm text-text-muted">Select a message to read it.</p>;
    }
    return <messageDetailPane.Lazy {...props} />;
}

export function LazyConversationThreadPane(props: React.ComponentProps<typeof ConversationThreadPaneType>) {
    if (!props.conversation) {
        return <p className="p-8 text-sm text-text-muted">Select a conversation to read it.</p>;
    }
    return <conversationThreadPane.Lazy {...props} />;
}

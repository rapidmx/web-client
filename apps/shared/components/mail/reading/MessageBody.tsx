///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, apiUrl } from "@rapidmx/react-shared/util/api.js";
import type { Attachment } from "@rapidmx/react-shared/mail/mailApi.js";
import type { MimeAttachment } from "@rapidmx/react-shared/crypto/mime.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Skeleton from "@rapidmx/react-shared/components/feedback/Skeleton.js";
import { useResolvedTheme } from "../../../appearance/resolvedTheme.js";
import { BodyContent, attachmentSource, cachedBodyContent, fetchBodyContent, makeCidResolver } from "./bodyContent.js";
import { prepareBodyHtml } from "./bodyHtml.js";
import { formatColour } from "./color.js";
import { controlFrame } from "./frameControl.js";
import { FRAME_SANDBOX, FrameMode, buildFrameDocument } from "./frameDocument.js";
import { surfaceKey, useThemeSurface } from "./themeSurface.js";

export interface MessageBodyProps {
    messageUid: string;
    /** Part of what a remembered body is keyed on, so an edited message is fetched again. */
    messageVersion: number;
    /** The accessible name of the body. */
    title: string;
    /** A body the caller already has - decrypted or verified content. Shown instead of asking the server. */
    content?: BodyContent;
    /** The message's server-side attachments, for resolving its inline `cid:` images. */
    attachments?: Attachment[];
    /** The parts inside a signed or encrypted message, for resolving its inline images from the decrypted content. */
    inlineParts?: MimeAttachment[];
    /** Show the message as its author wrote it: nothing adapted to the theme. */
    original?: boolean;
    /** Says whether "view original" would change anything, once that is known: never for plain text, a message with its own dark styles, or a
     * message the theme leaves as it is. */
    onAdaptable?: (adaptable: boolean) => void;
}

type Remote = { status: "loading" } | { status: "ready"; content: BodyContent } | { status: "error"; message: string };

/** Placeholder lines shown where the body will be, in the body's own place, until it has arrived and been laid out. */
export function BodySkeleton() {
    return (
        <div role="status" aria-busy="true" className="flex flex-col gap-2.5 py-1">
            <span className="sr-only">Loading the message</span>
            <Skeleton width="w-11/12" />
            <Skeleton width="w-4/5" />
            <Skeleton width="w-9/12" />
            <Skeleton width="w-1/2" />
        </div>
    );
}

/** A short, stable fingerprint of a document's text (djb2), to tell one loaded document from the next. */
function fingerprint(text: string): string {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
}

/** The background of a message shown as authored: white, the canvas an HTML message is written for. */
const AUTHORED_CANVAS = "rgb(255, 255, 255)";

/**
 * The body of one message, in the card's own place: the sanitized HTML in a frame that is exactly as tall as its content (following it as
 * images load and the width changes), or plain text. See `frameDocument.ts` for the isolation and `themeAdaptation.ts` for how a message
 * takes the app's theme.
 *
 * Nothing waits on the network to lay out: the skeleton is here at once, and the frame's height is only ever the height of what is in it.
 */
export default function MessageBody({ messageUid, messageVersion, title, content, attachments, inlineParts, original = false, onAdaptable }: MessageBodyProps) {
    const [remote, setRemote] = useState<Remote>(() => {
        const cached = cachedBodyContent(messageUid, messageVersion);
        return cached ? { status: "ready", content: cached } : { status: "loading" };
    });
    const [attempt, setAttempt] = useState(0);
    const supplied = content !== undefined;

    useEffect(() => {
        if (supplied) {
            return;
        }
        const cached = cachedBodyContent(messageUid, messageVersion);
        if (cached) {
            setRemote({ status: "ready", content: cached });
            return;
        }
        const controller = new AbortController();
        setRemote({ status: "loading" });
        fetchBodyContent(messageUid, messageVersion, controller.signal).then(
            (loaded) => setRemote({ status: "ready", content: loaded }),
            (err) => {
                if (!controller.signal.aborted) {
                    setRemote({ status: "error", message: err instanceof ApiRequestError ? err.message : "Could not load this message." });
                }
            },
        );
        return () => controller.abort();
    }, [messageUid, messageVersion, supplied, attempt]);

    const shown: Remote = content ? { status: "ready", content } : remote;
    if (shown.status === "loading") {
        return <BodySkeleton />;
    }
    if (shown.status === "error") {
        return (
            <div className="flex flex-col items-start gap-2">
                <Alert>{shown.message}</Alert>
                <Button type="button" variant="secondary" className="!w-auto" onClick={() => setAttempt((n) => n + 1)}>
                    Try again
                </Button>
            </div>
        );
    }
    if (shown.content.kind === "text") {
        // Rendered as text - React escapes it - never as markup, in the theme's own colours.
        return <pre aria-label={title} className="m-0 text-sm font-sans whitespace-pre-wrap break-words text-text">{shown.content.text}</pre>;
    }
    return (
        <HtmlBody
            key={messageUid}
            messageUid={messageUid}
            title={title}
            html={shown.content.html}
            remoteAvailable={!supplied}
            attachments={attachments}
            inlineParts={inlineParts}
            original={original}
            onAdaptable={onAdaptable}
        />
    );
}

function HtmlBody({
    messageUid,
    title,
    html,
    remoteAvailable,
    attachments,
    inlineParts,
    original,
    onAdaptable,
}: {
    messageUid: string;
    title: string;
    html: string;
    /** The full message can be opened on its own from the server (it was not supplied by the caller). */
    remoteAvailable: boolean;
    attachments?: Attachment[];
    inlineParts?: MimeAttachment[];
    original: boolean;
    onAdaptable?: (adaptable: boolean) => void;
}) {
    const theme = useResolvedTheme();
    const surface = useThemeSurface(theme);
    // Keyed on what the resolver reads rather than on the arrays, which a caller may rebuild on every render.
    const inlineKey = [...(attachments ?? []).map((a) => `${a.uid}:${(a as { contentId?: string }).contentId ?? ""}`), inlineParts ? `parts:${inlineParts.length}` : ""].join("|");
    const resolveCid = useMemo(() => makeCidResolver(attachments, inlineParts), [inlineKey]);
    const prepared = useMemo(() => prepareBodyHtml(html, { resolveCid }), [html, resolveCid]);
    const mode: FrameMode = prepared.declaresDarkSupport ? "native" : original ? "original" : "adapt";
    const surfaceCss = formatColour(surface.background);
    const srcDoc = useMemo(() => {
        // The frame may load images from this server's attachment URLs only when an inline image was actually resolved to one.
        const source = prepared.inlineImages > 0 ? attachmentSource() : undefined;
        return buildFrameDocument(prepared.html, {
            mode,
            scheme: theme,
            surface: surfaceCss,
            text: formatColour(surface.text),
            attachmentSource: source && prepared.html.includes(source) ? source : undefined,
        });
    }, [prepared, mode, theme, surfaceCss, surface.text]);
    // A different body, surface or mode is a different document: the adaptation pass edits the document it ran on, so it is run on a fresh
    // one, and the old one's readiness is not the new one's.
    const frameKey = useMemo(() => `${mode}:${surfaceKey(surface)}:${fingerprint(srcDoc)}`, [mode, surface, srcDoc]);

    const [height, setHeight] = useState<number | undefined>(undefined);
    const [readyFor, setReadyFor] = useState<string | null>(null);
    const [canvasAuthored, setCanvasAuthored] = useState(false);
    const dispose = useRef<(() => void) | undefined>(undefined);
    useEffect(() => () => dispose.current?.(), []);
    const reportAdaptable = useRef(onAdaptable);
    reportAdaptable.current = onAdaptable;
    useEffect(() => {
        if (mode === "native") {
            reportAdaptable.current?.(false);
        }
    }, [mode]);

    if (prepared.status === "too_large") {
        return (
            <Alert>
                This message is too large to show here.{" "}
                {remoteAvailable && (
                    <a href={apiUrl(`/mail/messages/${encodeURIComponent(messageUid)}/content`)} target="_blank" rel="noopener noreferrer" className="font-medium underline">
                        Open it in its own tab
                    </a>
                )}
            </Alert>
        );
    }

    const ready = readyFor === frameKey;
    const canvas = mode === "original" ? AUTHORED_CANVAS : surfaceCss;
    const framed = mode !== "adapt" || canvasAuthored;
    return (
        <div className="relative rounded-md overflow-hidden" style={{ backgroundColor: canvas }}>
            {!ready && <BodySkeleton />}
            <iframe
                key={frameKey}
                title={title}
                srcDoc={srcDoc}
                sandbox={FRAME_SANDBOX}
                scrolling="no"
                onLoad={(event) => {
                    dispose.current?.();
                    dispose.current = controlFrame(event.currentTarget, {
                        surface: mode === "adapt" ? surface : undefined,
                        onHeight: setHeight,
                        onReady: (adaptation) => {
                            setReadyFor(frameKey);
                            if (adaptation) {
                                setCanvasAuthored(adaptation.authoredCanvas);
                                reportAdaptable.current?.(adaptation.material);
                            }
                        },
                    });
                }}
                className={[
                    "block w-full border-0 rounded-md",
                    ready ? "" : "absolute inset-x-0 top-0 invisible",
                    framed && ready ? "ring-1 ring-border" : "",
                ].join(" ")}
                style={{ height: height ?? 0 }}
            />
        </div>
    );
}

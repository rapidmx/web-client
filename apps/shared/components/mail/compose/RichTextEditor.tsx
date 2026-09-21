///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TextStyleKit } from "@tiptap/extension-text-style";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import Placeholder from "@tiptap/extension-placeholder";
import ComposeToolbar from "./ComposeToolbar.js";

export interface RichTextEditorProps {
    value: string;
    onChange: (value: string) => void;
    height?: string;
    /** When true, the editor fills its parent's height via flexbox instead of a fixed `height` — for
     * embedding inside a flex-column container of variable height (the floating Compose window) where
     * a literal pixel height can't be computed up front. `height` is ignored when this is set. */
    fill?: boolean;
    /** Passed straight through to `ComposeToolbar` — see its own doc comment on this prop. */
    onUploadImage: (file: File) => Promise<string | null>;
    /** Focuses the editor with the caret at the very start of the document once it mounts - a reply or forward, whose
     * body starts with an empty paragraph above the signature and quote, so typing goes above them. Only read when
     * the editor is created. */
    autoFocusStart?: boolean;
    /** Called once the editor is ready, with `value` as the editor itself serializes it: TipTap drops what its schema
     * doesn't hold (e.g. a blockquote's `style`) and adds an empty paragraph after a trailing non-paragraph node (a
     * quote). That normalization happens on the editor's first transaction - even one that only moves the caret -
     * and isn't reported through `onChange`, so a caller can compare later edits against this instead of `value`. */
    onInitialized?: (value: string) => void;
    /**
     * HTML to add at the end of the document, once, as soon as there is some (it may be undefined when the editor is created and
     * defined later). A reply opens its editor before the quoted original has been fetched and hands the quote in through this when
     * it arrives - so whatever has been typed above stays, and the quote lands where it always did, under the signature.
     */
    appendHtml?: string;
    /** Called with the document as the editor serializes it, right after `appendHtml` was added. */
    onAppended?: (value: string) => void;
}

/**
 * A WYSIWYG rich-text editor for the Compose window's message body — replaces `MonacoHtmlEditor` (an HTML
 * *source* editor) with a real Outlook-Home-tab-style formatting experience, built on TipTap/ProseMirror.
 * Used by `ComposeWindow` (the floating overlay, not a dedicated page — see `ComposeContext.tsx`'s doc
 * comment).
 *
 * `value` seeds the editor's initial content only — like `MonacoHtmlEditor`, this never re-syncs from a
 * later `value` prop change; TipTap owns its own document once created. Live edits flow out as HTML (via
 * `editor.getHTML()`) through `onChange`.
 *
 * `immediatelyRender: false` is required for this framework's SSR: the page embedding `ComposeWindow` is
 * rendered server-side under plain Node before hydration (see `ReactRoute`), and TipTap's default
 * (`immediatelyRender: true`) tries to mount its ProseMirror view during that very first render, which
 * both can't work without a real DOM and produces a hydration mismatch. With it `false`, `useEditor`
 * returns `null` until the editor actually mounts client-side after hydration — `ComposeToolbar`/
 * `EditorContent` both already handle a `null` editor by rendering their disabled/empty state, so this
 * needs no extra loading-placeholder logic here. Unlike `MonacoHtmlEditor`, no dynamic `import()` is
 * needed to defer loading TipTap's modules off the SSR path — `immediatelyRender: false` alone is
 * sufficient here since TipTap (unlike Monaco) never touches the DOM at module-evaluation time, only when
 * an editor view actually mounts.
 */
export default function RichTextEditor({
    value,
    onChange,
    height = "360px",
    fill = false,
    onUploadImage,
    autoFocusStart = false,
    onInitialized,
    appendHtml,
    onAppended,
}: RichTextEditorProps) {
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onInitializedRef = useRef(onInitialized);
    onInitializedRef.current = onInitialized;
    const onAppendedRef = useRef(onAppended);
    onAppendedRef.current = onAppended;
    const appendedRef = useRef<string | undefined>(undefined);
    // Transactions before `create` (the autofocus, and the normalizing one below) aren't edits.
    const initializedRef = useRef(false);
    // Held for this editor's lifetime: TipTap focuses a tick after creating the editor, and a re-render passing a
    // different value in between would replace the option (via `setOptions`) before it's read.
    const [autofocus] = useState<"start" | false>(autoFocusStart ? "start" : false);

    const editor = useEditor({
        extensions: [
            StarterKit.configure({ link: { openOnClick: false } }),
            TextStyleKit.configure({ backgroundColor: false, lineHeight: false }),
            TextAlign.configure({ types: ["heading", "paragraph"] }),
            Highlight,
            Image,
            TableKit.configure({ table: { resizable: true } }),
            Placeholder.configure({ placeholder: "Write your message…" }),
        ],
        content: value,
        autofocus,
        immediatelyRender: false,
        onCreate: ({ editor: created }) => {
            // An empty transaction runs the schema's append-transaction normalization now, before any edit.
            created.view.dispatch(created.state.tr);
            initializedRef.current = true;
            onInitializedRef.current?.(created.getHTML());
        },
        onUpdate: ({ editor: updated }) => {
            if (initializedRef.current) {
                onChangeRef.current(updated.getHTML());
            }
        },
    });

    // Added once, at the end, whatever the reader has typed meanwhile (the caret stays where it is).
    useEffect(() => {
        if (!editor || appendHtml === undefined || appendedRef.current === appendHtml) {
            return;
        }
        appendedRef.current = appendHtml;
        editor.commands.insertContentAt(editor.state.doc.content.size, appendHtml);
        onAppendedRef.current?.(editor.getHTML());
    }, [editor, appendHtml]);

    return (
        <div className={["border border-border rounded-sm overflow-hidden", fill ? "h-full flex flex-col" : ""].filter(Boolean).join(" ")}>
            <ComposeToolbar editor={editor} onUploadImage={onUploadImage} />
            <EditorContent
                editor={editor}
                style={fill ? undefined : { height }}
                className={[
                    "overflow-y-auto px-3 py-2 text-sm [&_.tiptap]:outline-none [&_.tiptap]:h-full",
                    fill ? "flex-1 min-h-0" : "",
                ]
                    .filter(Boolean)
                    .join(" ")}
            />
        </div>
    );
}

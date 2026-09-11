///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useRef } from "react";
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
export default function RichTextEditor({ value, onChange, height = "360px", fill = false, onUploadImage }: RichTextEditorProps) {
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

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
        immediatelyRender: false,
        onUpdate: ({ editor: updated }) => onChangeRef.current(updated.getHTML()),
    });

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

///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, KeyboardEvent, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import type { IconType } from "react-icons";
import { BsEraser, BsLink45Deg, BsListOl, BsListUl, BsTypeBold, BsTypeItalic, BsTypeUnderline } from "react-icons/bs";
import { safeDescriptionHref } from "@rapidmx/react-shared/calendar/eventDescription.js";

export interface DescriptionEditorProps {
    /** The description to start with, as HTML. Read once, when the editor is created: TipTap owns the document from then on. */
    value: string;
    /** Called with the document as HTML (`<p></p>` for an empty one) each time it changes. */
    onChange: (html: string) => void;
    /** Focus the text when the editor appears (the "Add description" row that opened it). */
    autoFocus?: boolean;
    /** The accessible name of the text box. */
    label?: string;
}

/**
 * The plain text on a clipboard as paragraphs, one for each line - what `handlePaste` inserts instead of the pasted formatting. Empty lines are kept as
 * empty paragraphs, so a pasted block keeps its shape.
 */
function paragraphsOf(text: string) {
    return text.split(/\r\n|\r|\n/).map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] }));
}

/**
 * What a typed link address is: an `http`, `https` or `mailto` link, with `https://` put in front of an address that names no scheme ("example.com") and
 * `mailto:` in front of a plain email address. `undefined` for anything else (`javascript:`, `data:`, ...).
 */
export function linkFromInput(input: string): string | undefined {
    const text = input.trim();
    if (/\s/.test(text)) {
        return undefined;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
        return safeDescriptionHref(text);
    }
    return safeDescriptionHref(/^[^\s@/]+@[^\s@/]+$/.test(text) ? `mailto:${text}` : `https://${text}`);
}

const NO_MARKS = { bold: false, italic: false, underline: false, bulletList: false, orderedList: false, link: false };

interface ToolbarButton {
    label: string;
    icon: IconType;
    pressed?: boolean;
    onClick: () => void;
}

/**
 * The rich-text box of an event's description, as Google Calendar draws it: a toolbar (bold, italic, underline, numbered list, bulleted list, link, remove
 * formatting) over the text. Built on TipTap with only the schema an event description may hold - paragraphs, line breaks, bold, italic, underline, lists and
 * `http`/`https`/`mailto` links, so the HTML it writes has nothing the server would remove. Ctrl/Cmd+B, I and U format, Ctrl/Cmd+K asks for a link, and a
 * paste keeps the text and drops the formatting.
 *
 * The toolbar is a WAI-ARIA toolbar: one tab stop, the arrow keys, Home and End move along it, and each toggle says whether it is on (`aria-pressed`). The
 * buttons do not take focus from the text, so a selection survives pressing one.
 */
export default function DescriptionEditor({ value, onChange, autoFocus, label = "Description" }: DescriptionEditorProps) {
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const openLinkRef = useRef<(() => void) | null>(null);
    // The paste handler is created with the editor, before the editor exists.
    const editorRef = useRef<Editor | null>(null);
    const editor = useEditor({
        extensions: [
            StarterKit.configure({
                heading: false,
                blockquote: false,
                code: false,
                codeBlock: false,
                horizontalRule: false,
                strike: false,
                dropcursor: false,
                gapcursor: false,
                trailingNode: false,
                link: {
                    openOnClick: false,
                    autolink: false,
                    linkOnPaste: false,
                    protocols: ["http", "https", "mailto"],
                    HTMLAttributes: { rel: "noopener noreferrer", target: "_blank", class: "text-primary-dark underline" },
                },
            }),
            Placeholder.configure({ placeholder: "Add description" }),
        ],
        content: value,
        autofocus: autoFocus ? "end" : false,
        immediatelyRender: false,
        editorProps: {
            attributes: { role: "textbox", "aria-multiline": "true", "aria-label": label },
            handlePaste: (_view, event) => {
                // A paste that came without a clipboard (ProseMirror then reads it back through a hidden field) has no text to give.
                const text = event.clipboardData?.getData("text/plain") ?? "";
                if (!text) {
                    return false;
                }
                event.preventDefault();
                editorRef.current!.chain().focus().insertContent(paragraphsOf(text)).run();
                return true;
            },
            handleKeyDown: (_view, event) => {
                if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
                    event.preventDefault();
                    openLinkRef.current!();
                    return true;
                }
                return false;
            },
        },
        onUpdate: ({ editor: updated }) => onChangeRef.current(updated.getHTML()),
    });
    editorRef.current = editor;

    // Which formats the caret is in (re-read on every transaction). There is no editor until it has mounted, and then nothing is on.
    const marks = useEditorState({
        editor,
        selector: ({ editor: current }) =>
            current
                ? {
                      bold: current.isActive("bold"),
                      italic: current.isActive("italic"),
                      underline: current.isActive("underline"),
                      bulletList: current.isActive("bulletList"),
                      orderedList: current.isActive("orderedList"),
                      link: current.isActive("link"),
                  }
                : NO_MARKS,
    }) as typeof NO_MARKS;

    const [linkOpen, setLinkOpen] = useState(false);
    const [linkText, setLinkText] = useState("");
    const [linkError, setLinkError] = useState<string | null>(null);
    const [focusIndex, setFocusIndex] = useState(0);
    const buttons = useRef<(HTMLButtonElement | null)[]>([]);

    function openLink() {
        setLinkText(editor!.getAttributes("link").href ?? "");
        setLinkError(null);
        setLinkOpen(true);
    }
    openLinkRef.current = openLink;

    function closeLink() {
        setLinkOpen(false);
        editor!.commands.focus();
    }

    function submitLink(event: FormEvent) {
        // The description sits inside the event's own form: applying a link must not submit that.
        event.preventDefault();
        event.stopPropagation();
        const chain = editor!.chain().focus();
        if (linkText.trim() === "") {
            chain.extendMarkRange("link").unsetLink().run();
        } else {
            const href = linkFromInput(linkText);
            if (!href) {
                setLinkError("Enter a web address (http or https) or an email address.");
                return;
            }
            if (editor!.state.selection.empty && !editor!.isActive("link")) {
                chain.insertContent({ type: "text", text: linkText.trim(), marks: [{ type: "link", attrs: { href } }] }).run();
            } else {
                chain.extendMarkRange("link").setLink({ href }).run();
            }
        }
        setLinkOpen(false);
    }

    const items: ToolbarButton[] = [
        { label: "Bold", icon: BsTypeBold, pressed: marks.bold, onClick: () => editor!.chain().focus().toggleBold().run() },
        { label: "Italic", icon: BsTypeItalic, pressed: marks.italic, onClick: () => editor!.chain().focus().toggleItalic().run() },
        { label: "Underline", icon: BsTypeUnderline, pressed: marks.underline, onClick: () => editor!.chain().focus().toggleUnderline().run() },
        { label: "Numbered list", icon: BsListOl, pressed: marks.orderedList, onClick: () => editor!.chain().focus().toggleOrderedList().run() },
        { label: "Bulleted list", icon: BsListUl, pressed: marks.bulletList, onClick: () => editor!.chain().focus().toggleBulletList().run() },
        { label: "Link", icon: BsLink45Deg, pressed: marks.link, onClick: openLink },
        { label: "Remove formatting", icon: BsEraser, onClick: () => editor!.chain().focus().unsetAllMarks().run() },
    ];

    function handleToolbarKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        const last = items.length - 1;
        const next =
            event.key === "ArrowRight" ? (focusIndex === last ? 0 : focusIndex + 1)
            : event.key === "ArrowLeft" ? (focusIndex === 0 ? last : focusIndex - 1)
            : event.key === "Home" ? 0
            : event.key === "End" ? last
            : undefined;
        if (next !== undefined) {
            event.preventDefault();
            setFocusIndex(next);
            buttons.current[next]!.focus();
        }
    }

    return (
        <div className="border border-border rounded-md bg-surface focus-within:border-primary">
            <div role="toolbar" aria-label="Description formatting" onKeyDown={handleToolbarKeyDown} className="flex flex-wrap items-center gap-0.5 px-1.5 py-1 border-b border-border">
                {items.map((item, index) => (
                    <button
                        key={item.label}
                        ref={(element) => {
                            buttons.current[index] = element;
                        }}
                        type="button"
                        aria-label={item.label}
                        title={item.label}
                        aria-pressed={item.pressed}
                        disabled={!editor}
                        tabIndex={index === focusIndex ? 0 : -1}
                        onFocus={() => setFocusIndex(index)}
                        // Pressing a button must not move focus (and the selection) out of the text.
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={item.onClick}
                        className={[
                            "w-7 h-7 flex items-center justify-center rounded-sm disabled:opacity-40",
                            item.pressed ? "bg-primary/10 text-primary-dark" : "text-text-muted hover:bg-surface-alt hover:text-text",
                        ].join(" ")}
                    >
                        <item.icon size={15} aria-hidden="true" />
                    </button>
                ))}
            </div>
            {linkOpen && (
                <div className="flex flex-col gap-1 px-2 py-1.5 border-b border-border">
                    <div className="flex items-center gap-1.5">
                        <input
                            type="text"
                            autoFocus
                            aria-label="Link address"
                            placeholder="https://example.com"
                            value={linkText}
                            onChange={(event) => {
                                setLinkText(event.target.value);
                                setLinkError(null);
                            }}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    submitLink(event);
                                } else if (event.key === "Escape") {
                                    // Closes the prompt, not the dialog around it.
                                    event.stopPropagation();
                                    closeLink();
                                }
                            }}
                            className="flex-1 min-w-0 text-sm py-1 px-2 border border-border rounded-sm bg-surface"
                        />
                        <button type="button" onClick={submitLink} className="text-xs font-semibold text-primary-dark hover:underline">
                            Apply
                        </button>
                        <button type="button" onClick={closeLink} className="text-xs font-medium text-text-muted hover:underline">
                            Cancel
                        </button>
                    </div>
                    {linkError && (
                        <p role="alert" className="text-xs text-danger">
                            {linkError}
                        </p>
                    )}
                </div>
            )}
            <EditorContent
                editor={editor}
                className="px-3 py-2 text-sm max-h-64 overflow-y-auto [&_.tiptap]:outline-none [&_.tiptap]:min-h-[4.5rem] [&_.tiptap_ul]:list-disc [&_.tiptap_ul]:pl-5 [&_.tiptap_ol]:list-decimal [&_.tiptap_ol]:pl-5 [&_.tiptap_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)] [&_.tiptap_p.is-editor-empty:first-child]:before:text-text-muted [&_.tiptap_p.is-editor-empty:first-child]:before:float-left [&_.tiptap_p.is-editor-empty:first-child]:before:h-0 [&_.tiptap_p.is-editor-empty:first-child]:before:pointer-events-none"
            />
        </div>
    );
}

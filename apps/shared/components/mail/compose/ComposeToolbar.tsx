///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { IconType } from "react-icons";
import {
    BsArrowClockwise,
    BsArrowCounterclockwise,
    BsEraser,
    BsHighlighter,
    BsImage,
    BsIndent,
    BsJustify,
    BsLink45Deg,
    BsListOl,
    BsListUl,
    BsPaletteFill,
    BsTable,
    BsTextCenter,
    BsTextLeft,
    BsTextRight,
    BsTypeBold,
    BsTypeItalic,
    BsTypeStrikethrough,
    BsTypeUnderline,
    BsUnindent,
} from "react-icons/bs";
import EmojiPicker from "./EmojiPicker.js";
import GifPicker from "./GifPicker.js";

export interface ComposeToolbarProps {
    /** `null` before the editor has mounted client-side (see `RichTextEditor`'s `immediatelyRender: false`
     * doc comment) — every button is disabled in that state rather than the toolbar rendering nothing, so
     * its layout doesn't shift the instant the editor becomes ready. */
    editor: Editor | null;
    /** Uploads `file` as an attachment on the current draft and resolves to a URL the browser can
     * preview it at while composing — see `BaseMailComposeRoute.rewriteInlineImageSources()`'s doc
     * comment for why that's not the final URL the message actually ships with. Resolves to `null`
     * (rather than rejecting) on failure — `ComposeWindow`'s own implementation is responsible for
     * surfacing the error itself, so a failed upload here just quietly doesn't insert an image. */
    onUploadImage: (file: File) => Promise<string | null>;
}

const FONT_FAMILIES = [
    { label: "Default", value: "" },
    { label: "Sans Serif", value: "Arial, Helvetica, sans-serif" },
    { label: "Serif", value: "Georgia, 'Times New Roman', serif" },
    { label: "Monospace", value: "'Courier New', monospace" },
];

const FONT_SIZES = [
    { label: "Small", value: "12px" },
    { label: "Normal", value: "" },
    { label: "Large", value: "18px" },
    { label: "Huge", value: "24px" },
];

function ToolbarButton({
    label,
    icon: Icon,
    active,
    disabled,
    onClick,
}: {
    label: string;
    icon: IconType;
    active?: boolean;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            aria-pressed={active ?? false}
            title={label}
            disabled={disabled}
            onClick={onClick}
            className={[
                "w-8 h-8 flex items-center justify-center rounded-sm disabled:opacity-40 disabled:cursor-not-allowed",
                active ? "bg-primary/10 text-primary-dark" : "text-text-muted hover:bg-surface-alt hover:text-text",
            ].join(" ")}
        >
            <Icon size={16} aria-hidden="true" />
        </button>
    );
}

function Divider() {
    return <div className="w-px self-stretch my-1.5 bg-border" aria-hidden="true" />;
}

/**
 * The compose page's rich-text formatting toolbar — a practical single Outlook-Home-tab-style bar
 * (font/size, bold/italic/underline/strikethrough, text/highlight color, alignment, lists/indent, insert
 * link/image/table, clear formatting, undo/redo), not a full multi-tab ribbon replica. Every command is a
 * plain `editor.chain().focus().<command>().run()` call against the `Editor` instance `RichTextEditor`
 * creates; active-state styling comes from `editor.isActive(...)`.
 */
type Popup = "link" | "emoji" | "gif" | null;

export default function ComposeToolbar({ editor, onUploadImage }: ComposeToolbarProps) {
    const [openPopup, setOpenPopup] = useState<Popup>(null);
    const [linkUrl, setLinkUrl] = useState("");
    const imageInputRef = useRef<HTMLInputElement>(null);
    const emojiButtonRef = useRef<HTMLButtonElement>(null);
    const gifButtonRef = useRef<HTMLButtonElement>(null);

    const disabled = !editor;

    // Every control that calls `run()` is itself `disabled` while `editor` is null (see `disabled` above),
    // and `editor` never reverts to null once TipTap actually creates it (only `immediatelyRender: false`'s
    // one-render gap before mount produces a null `editor` at all) — so `run()` is never reachable with a
    // null `editor` through any real UI interaction; asserted non-null rather than guarded, matching this
    // codebase's established pattern for the same class of "always non-null by the time it's called" value.
    function run(fn: (editor: Editor) => void) {
        fn(editor!);
    }

    async function handleImageFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) {
            return;
        }
        const url = await onUploadImage(file);
        if (url) {
            run((ed) => ed.chain().focus().setImage({ src: url }).run());
        }
    }

    function handleInsertEmoji(native: string) {
        run((e) => e.chain().focus().insertContent(native).run());
        setOpenPopup(null);
    }

    function handleInsertGif(url: string) {
        run((e) => e.chain().focus().setImage({ src: url }).run());
        setOpenPopup(null);
    }

    function openLinkPrompt() {
        setLinkUrl(editor?.getAttributes("link").href ?? "");
        setOpenPopup("link");
    }

    function submitLink(e: React.FormEvent) {
        e.preventDefault();
        if (linkUrl.trim().length === 0) {
            run((ed) => ed.chain().focus().extendMarkRange("link").unsetLink().run());
        } else {
            run((ed) => ed.chain().focus().extendMarkRange("link").setLink({ href: linkUrl.trim() }).run());
        }
        setOpenPopup(null);
    }

    let linkPrompt: ReactNode = null;
    if (openPopup === "link") {
        linkPrompt = (
            <form onSubmit={submitLink} className="flex items-center gap-1.5 px-2 py-1.5 border-t border-border">
                <input
                    type="text"
                    autoFocus
                    aria-label="Link URL"
                    placeholder="https://example.com"
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    className="flex-1 text-sm py-1 px-2 border border-border rounded-sm bg-surface"
                />
                <button type="submit" className="text-xs font-semibold text-primary-dark hover:underline">
                    Apply
                </button>
                <button
                    type="button"
                    onClick={() => setOpenPopup(null)}
                    className="text-xs font-medium text-text-muted hover:underline"
                >
                    Cancel
                </button>
            </form>
        );
    }

    return (
        <div className="border-b border-border bg-surface-alt">
            <div className="flex flex-wrap items-center gap-0.5 px-2 py-1.5">
                <select
                    aria-label="Font family"
                    disabled={disabled}
                    value={editor?.getAttributes("textStyle").fontFamily ?? ""}
                    onChange={(e) =>
                        run((ed) =>
                            e.target.value
                                ? ed.chain().focus().setFontFamily(e.target.value).run()
                                : ed.chain().focus().unsetFontFamily().run(),
                        )
                    }
                    className="text-xs py-1 px-1.5 border border-border rounded-sm bg-surface disabled:opacity-40"
                >
                    {FONT_FAMILIES.map((f) => (
                        <option key={f.label} value={f.value}>
                            {f.label}
                        </option>
                    ))}
                </select>

                <select
                    aria-label="Font size"
                    disabled={disabled}
                    value={editor?.getAttributes("textStyle").fontSize ?? ""}
                    onChange={(e) =>
                        run((ed) =>
                            e.target.value
                                ? ed.chain().focus().setFontSize(e.target.value).run()
                                : ed.chain().focus().unsetFontSize().run(),
                        )
                    }
                    className="text-xs py-1 px-1.5 border border-border rounded-sm bg-surface disabled:opacity-40"
                >
                    {FONT_SIZES.map((f) => (
                        <option key={f.label} value={f.value}>
                            {f.label}
                        </option>
                    ))}
                </select>

                <Divider />

                <ToolbarButton
                    label="Bold"
                    icon={BsTypeBold}
                    disabled={disabled}
                    active={editor?.isActive("bold")}
                    onClick={() => run((e) => e.chain().focus().toggleBold().run())}
                />
                <ToolbarButton
                    label="Italic"
                    icon={BsTypeItalic}
                    disabled={disabled}
                    active={editor?.isActive("italic")}
                    onClick={() => run((e) => e.chain().focus().toggleItalic().run())}
                />
                <ToolbarButton
                    label="Underline"
                    icon={BsTypeUnderline}
                    disabled={disabled}
                    active={editor?.isActive("underline")}
                    onClick={() => run((e) => e.chain().focus().toggleUnderline().run())}
                />
                <ToolbarButton
                    label="Strikethrough"
                    icon={BsTypeStrikethrough}
                    disabled={disabled}
                    active={editor?.isActive("strike")}
                    onClick={() => run((e) => e.chain().focus().toggleStrike().run())}
                />

                <Divider />

                <label className="w-8 h-8 flex items-center justify-center rounded-sm text-text-muted hover:bg-surface-alt hover:text-text cursor-pointer has-[:disabled]:opacity-40 has-[:disabled]:cursor-not-allowed">
                    <BsPaletteFill size={16} aria-hidden="true" />
                    <span className="sr-only">Text color</span>
                    <input
                        type="color"
                        disabled={disabled}
                        value={editor?.getAttributes("textStyle").color ?? "#000000"}
                        onChange={(e) => run((ed) => ed.chain().focus().setColor(e.target.value).run())}
                        className="sr-only"
                    />
                </label>
                <ToolbarButton
                    label="Highlight"
                    icon={BsHighlighter}
                    disabled={disabled}
                    active={editor?.isActive("highlight")}
                    onClick={() => run((e) => e.chain().focus().toggleHighlight().run())}
                />

                <Divider />

                <ToolbarButton
                    label="Align left"
                    icon={BsTextLeft}
                    disabled={disabled}
                    active={editor?.isActive({ textAlign: "left" })}
                    onClick={() => run((e) => e.chain().focus().setTextAlign("left").run())}
                />
                <ToolbarButton
                    label="Align center"
                    icon={BsTextCenter}
                    disabled={disabled}
                    active={editor?.isActive({ textAlign: "center" })}
                    onClick={() => run((e) => e.chain().focus().setTextAlign("center").run())}
                />
                <ToolbarButton
                    label="Align right"
                    icon={BsTextRight}
                    disabled={disabled}
                    active={editor?.isActive({ textAlign: "right" })}
                    onClick={() => run((e) => e.chain().focus().setTextAlign("right").run())}
                />
                <ToolbarButton
                    label="Justify"
                    icon={BsJustify}
                    disabled={disabled}
                    active={editor?.isActive({ textAlign: "justify" })}
                    onClick={() => run((e) => e.chain().focus().setTextAlign("justify").run())}
                />

                <Divider />

                <ToolbarButton
                    label="Bulleted list"
                    icon={BsListUl}
                    disabled={disabled}
                    active={editor?.isActive("bulletList")}
                    onClick={() => run((e) => e.chain().focus().toggleBulletList().run())}
                />
                <ToolbarButton
                    label="Numbered list"
                    icon={BsListOl}
                    disabled={disabled}
                    active={editor?.isActive("orderedList")}
                    onClick={() => run((e) => e.chain().focus().toggleOrderedList().run())}
                />
                <ToolbarButton
                    label="Decrease indent"
                    icon={BsUnindent}
                    disabled={disabled}
                    onClick={() => run((e) => e.chain().focus().liftListItem("listItem").run())}
                />
                <ToolbarButton
                    label="Increase indent"
                    icon={BsIndent}
                    disabled={disabled}
                    onClick={() => run((e) => e.chain().focus().sinkListItem("listItem").run())}
                />

                <Divider />

                <ToolbarButton
                    label="Insert link"
                    icon={BsLink45Deg}
                    disabled={disabled}
                    active={editor?.isActive("link")}
                    onClick={openLinkPrompt}
                />
                <ToolbarButton label="Insert image" icon={BsImage} disabled={disabled} onClick={() => imageInputRef.current?.click()} />
                <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleImageFileSelected}
                    className="sr-only"
                    aria-label="Insert image file"
                />
                <ToolbarButton
                    label="Insert table"
                    icon={BsTable}
                    disabled={disabled}
                    onClick={() => run((e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
                />

                <button
                    ref={emojiButtonRef}
                    type="button"
                    aria-label="Insert emoji"
                    title="Insert emoji"
                    disabled={disabled}
                    onClick={() => setOpenPopup((p) => (p === "emoji" ? null : "emoji"))}
                    className="w-8 h-8 flex items-center justify-center text-base rounded-sm disabled:opacity-40 disabled:cursor-not-allowed text-text-muted hover:bg-surface-alt hover:text-text"
                >
                    😀
                </button>
                {openPopup === "emoji" && (
                    <EmojiPicker anchorRef={emojiButtonRef} onSelect={handleInsertEmoji} onClose={() => setOpenPopup(null)} />
                )}

                <button
                    ref={gifButtonRef}
                    type="button"
                    aria-label="Insert GIF"
                    title="Insert GIF"
                    disabled={disabled}
                    onClick={() => setOpenPopup((p) => (p === "gif" ? null : "gif"))}
                    className="w-8 h-8 flex items-center justify-center text-[10px] font-extrabold tracking-tight rounded-sm disabled:opacity-40 disabled:cursor-not-allowed text-text-muted hover:bg-surface-alt hover:text-text"
                >
                    GIF
                </button>
                {openPopup === "gif" && <GifPicker anchorRef={gifButtonRef} onSelect={handleInsertGif} onClose={() => setOpenPopup(null)} />}

                <Divider />

                <ToolbarButton
                    label="Clear formatting"
                    icon={BsEraser}
                    disabled={disabled}
                    onClick={() => run((e) => e.chain().focus().unsetAllMarks().clearNodes().run())}
                />
                <ToolbarButton
                    label="Undo"
                    icon={BsArrowCounterclockwise}
                    disabled={disabled || !editor?.can().undo()}
                    onClick={() => run((e) => e.chain().focus().undo().run())}
                />
                <ToolbarButton
                    label="Redo"
                    icon={BsArrowClockwise}
                    disabled={disabled || !editor?.can().redo()}
                    onClick={() => run((e) => e.chain().focus().redo().run())}
                />
            </div>
            {linkPrompt}
        </div>
    );
}

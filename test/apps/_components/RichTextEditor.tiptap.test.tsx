// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import RichTextEditor from "../../../apps/shared/components/mail/compose/RichTextEditor.js";

// A real TipTap editor (RichTextEditor.test.tsx mocks it) - the toolbar is beside the point here.
vi.mock("../../../apps/shared/components/mail/compose/ComposeToolbar.js", () => ({ default: () => null }));

const REPLY_BODY = "<p></p><p>Best,<br>Jane</p><p></p><p>On Monday, Sender wrote:</p><blockquote><p>Original text</p></blockquote>";

/** The editor behind the rendered ProseMirror view (TipTap sets `editor` on its view's DOM element). */
async function mountedEditor(container: HTMLElement): Promise<Editor> {
    return await waitFor(() => {
        const found: { editor?: Editor } | null = container.querySelector(".ProseMirror");
        expect(found?.editor).toBeDefined();
        return found!.editor!;
    });
}

// jsdom has no layout: ProseMirror measures a Range when it scrolls the caret into view (which adding content at the end does), and
// jsdom's Range cannot be measured - an asynchronous "getClientRects is not a function" that failed whichever test was running.
beforeAll(() => {
    const noRects = { length: 0, item: () => null, [Symbol.iterator]: () => [][Symbol.iterator]() };
    Range.prototype.getClientRects = () => noRects;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterEach(() => {
    cleanup();
});

describe("RichTextEditor with a real TipTap editor", () => {
    it("with autoFocusStart, focuses the editor with the caret in the empty first paragraph, and typing lands above the quote", async () => {
        const onChange = vi.fn();
        const onInitialized = vi.fn();
        const { container } = render(
            <RichTextEditor value={REPLY_BODY} onChange={onChange} onUploadImage={vi.fn()} autoFocusStart onInitialized={onInitialized} />,
        );
        const editor = await mountedEditor(container);

        await waitFor(() => expect(editor.isFocused).toBe(true));
        const { from, to, $from } = editor.state.selection;
        expect(from).toBe(1);
        expect(to).toBe(1);
        expect($from.parent.type.name).toBe("paragraph");
        expect($from.parent.content.size).toBe(0);
        expect($from.index(0)).toBe(0);
        // Moving the caret isn't an edit - an untouched reply stays untouched. The editor's own serialization (with the
        // empty paragraph it appends after the quote) is reported once, separately.
        expect(onChange).not.toHaveBeenCalled();
        await waitFor(() => expect(onInitialized).toHaveBeenCalledTimes(1));
        expect(onInitialized).toHaveBeenCalledWith(`${REPLY_BODY}<p></p>`);
        expect(editor.getHTML()).toBe(`${REPLY_BODY}<p></p>`);

        editor.view.dispatch(editor.state.tr.insertText("Thanks!"));
        expect(editor.getHTML().startsWith("<p>Thanks!</p><p>Best,<br>Jane</p><p></p><p>On Monday, Sender wrote:</p><blockquote>")).toBe(true);
        expect(onChange).toHaveBeenLastCalledWith(editor.getHTML());
    });

    it("lets Ctrl+Enter and Cmd+Enter go to the window (no hard break, not prevented) while Shift+Enter is still a hard break", async () => {
        const { container } = render(<RichTextEditor value="<p>Hello</p>" onChange={vi.fn()} onUploadImage={vi.fn()} />);
        const editor = await mountedEditor(container);
        editor.commands.focus("end");
        const dom = editor.view.dom;
        const press = (init: KeyboardEventInit) => {
            const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
            dom.dispatchEvent(event);
            return event;
        };

        expect(press({ ctrlKey: true }).defaultPrevented).toBe(false);
        expect(press({ metaKey: true }).defaultPrevented).toBe(false);
        expect(editor.getHTML()).not.toContain("<br");

        expect(press({ shiftKey: true }).defaultPrevented).toBe(true);
        expect(editor.getHTML()).toContain("<br");
    });

    it("without autoFocusStart, leaves the editor unfocused", async () => {
        const onChange = vi.fn();
        const { container } = render(<RichTextEditor value={REPLY_BODY} onChange={onChange} onUploadImage={vi.fn()} />);
        const editor = await mountedEditor(container);

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(editor.isFocused).toBe(false);
        expect(container.contains(document.activeElement)).toBe(false);
        expect(onChange).not.toHaveBeenCalled();
    });

    it("keeps the autofocus it mounted with when a re-render passes a different value", async () => {
        const { container, rerender } = render(<RichTextEditor value={REPLY_BODY} onChange={vi.fn()} onUploadImage={vi.fn()} autoFocusStart />);
        rerender(<RichTextEditor value={REPLY_BODY} onChange={vi.fn()} onUploadImage={vi.fn()} autoFocusStart={false} />);
        const editor = await mountedEditor(container);

        await waitFor(() => expect(editor.isFocused).toBe(true));
        expect(editor.state.selection.from).toBe(1);
    });

    describe("appendHtml", () => {
        it("adds the html at the end of the document once, keeping what was typed above, and reports the serialization", async () => {
            const onChange = vi.fn();
            const onAppended = vi.fn();
            const { container, rerender } = render(
                <RichTextEditor value="<p>Best,<br>Jane</p>" onChange={onChange} onUploadImage={vi.fn()} autoFocusStart onAppended={onAppended} />,
            );
            const editor = await mountedEditor(container);
            await waitFor(() => expect(editor.isFocused).toBe(true));
            editor.view.dispatch(editor.state.tr.insertText("Thanks! "));
            expect(onAppended).not.toHaveBeenCalled();

            rerender(
                <RichTextEditor
                    value="<p>Best,<br>Jane</p>"
                    onChange={onChange}
                    onUploadImage={vi.fn()}
                    autoFocusStart
                    onAppended={onAppended}
                    appendHtml="<p></p><blockquote>Original</blockquote>"
                />,
            );
            await waitFor(() => expect(onAppended).toHaveBeenCalledTimes(1));
            expect(editor.getHTML()).toContain("<p>Thanks! Best,<br>Jane</p>");
            expect(editor.getHTML()).toContain("<blockquote><p>Original</p></blockquote>");
            expect(editor.getHTML().indexOf("Thanks!")).toBeLessThan(editor.getHTML().indexOf("Original"));
            expect(onAppended).toHaveBeenCalledWith(editor.getHTML());
            expect(onChange).toHaveBeenLastCalledWith(editor.getHTML());

            // The same html again (a re-render) is not added twice; nor is anything added without it.
            rerender(
                <RichTextEditor
                    value="<p>Best,<br>Jane</p>"
                    onChange={onChange}
                    onUploadImage={vi.fn()}
                    autoFocusStart
                    onAppended={onAppended}
                    appendHtml="<p></p><blockquote>Original</blockquote>"
                />,
            );
            expect(onAppended).toHaveBeenCalledTimes(1);
            expect(editor.getHTML().match(/Original/g)).toHaveLength(1);
        });

        it("works without an onAppended callback", async () => {
            const { container } = render(<RichTextEditor value="<p>Hi</p>" onChange={vi.fn()} onUploadImage={vi.fn()} appendHtml="<p>More</p>" />);
            const editor = await mountedEditor(container);
            await waitFor(() => expect(editor.getHTML()).toContain("<p>More</p>"));
        });
    });
});

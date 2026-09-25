// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import DescriptionEditor, { linkFromInput } from "../../../apps/shared/components/calendar/DescriptionEditor.js";

// The event dialog's description box, with a real TipTap editor: what its toolbar does, what it can write, how it takes a paste.

// jsdom has no layout: ProseMirror measures a Range when it scrolls the caret into view, and jsdom's Range cannot be measured.
beforeAll(() => {
    const noRects = { length: 0, item: () => null, [Symbol.iterator]: () => [][Symbol.iterator]() };
    Range.prototype.getClientRects = () => noRects;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterEach(() => {
    cleanup();
});

/** The editor behind the rendered ProseMirror view. */
async function mountedEditor(container: HTMLElement): Promise<Editor> {
    return await waitFor(() => {
        const found: { editor?: Editor } | null = container.querySelector(".ProseMirror");
        expect(found?.editor).toBeDefined();
        return found!.editor!;
    });
}

async function renderEditor(value = "", props: Partial<React.ComponentProps<typeof DescriptionEditor>> = {}) {
    const onChange = vi.fn();
    const { container } = render(<DescriptionEditor value={value} onChange={onChange} {...props} />);
    const editor = await mountedEditor(container);
    return { editor, onChange, container };
}

const button = (name: string) => screen.getByRole("button", { name });

describe("linkFromInput", () => {
    it("keeps a web or mail address and adds the scheme an address without one needs", () => {
        expect(linkFromInput("https://example.com/a")).toBe("https://example.com/a");
        expect(linkFromInput("  http://example.com  ")).toBe("http://example.com/");
        expect(linkFromInput("mailto:jane@example.com")).toBe("mailto:jane@example.com");
        expect(linkFromInput("example.com/page")).toBe("https://example.com/page");
        expect(linkFromInput("jane@example.com")).toBe("mailto:jane@example.com");
    });

    it("refuses any other scheme, and nothing that is not an address", () => {
        expect(linkFromInput("javascript:alert(1)")).toBeUndefined();
        expect(linkFromInput("data:text/html,x")).toBeUndefined();
        expect(linkFromInput("tel:123")).toBeUndefined();
        expect(linkFromInput("not an address")).toBeUndefined();
        expect(linkFromInput("")).toBeUndefined();
    });
});

describe("DescriptionEditor", () => {
    it("is a labelled text box under a toolbar of seven labelled buttons, none pressed", async () => {
        await renderEditor("<p>Hello</p>", { label: "Agenda" });

        expect(screen.getByRole("textbox", { name: "Agenda" })).toBeInTheDocument();
        const toolbar = screen.getByRole("toolbar", { name: "Description formatting" });
        const buttons = Array.from(toolbar.querySelectorAll("button"));
        expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
            "Bold",
            "Italic",
            "Underline",
            "Numbered list",
            "Bulleted list",
            "Link",
            "Remove formatting",
        ]);
        expect(buttons.slice(0, 6).every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
        // Remove formatting is an action, not a toggle.
        expect(button("Remove formatting")).not.toHaveAttribute("aria-pressed");
    });

    it("is called Description by default, and starts with its value", async () => {
        const { editor } = await renderEditor("<p>Hello <strong>there</strong></p>");
        expect(screen.getByRole("textbox", { name: "Description" })).toHaveTextContent("Hello there");
        expect(editor.getHTML()).toBe("<p>Hello <strong>there</strong></p>");
    });

    it("focuses the end of the text when asked to", async () => {
        const { editor } = await renderEditor("<p>Hello</p>", { autoFocus: true });
        await waitFor(() => expect(editor.isFocused).toBe(true));
        expect(editor.state.selection.from).toBe(6);
    });

    it("bolds, italicises and underlines a selection with the toolbar, and shows which are on", async () => {
        const { editor, onChange } = await renderEditor("<p>Hello</p>");
        act(() => {
            editor.commands.selectAll();
        });

        fireEvent.click(button("Bold"));
        fireEvent.click(button("Italic"));
        fireEvent.click(button("Underline"));

        expect(onChange).toHaveBeenLastCalledWith("<p><strong><em><u>Hello</u></em></strong></p>");
        await waitFor(() => expect(button("Bold")).toHaveAttribute("aria-pressed", "true"));
        expect(button("Italic")).toHaveAttribute("aria-pressed", "true");
        expect(button("Underline")).toHaveAttribute("aria-pressed", "true");

        fireEvent.click(button("Bold"));
        await waitFor(() => expect(button("Bold")).toHaveAttribute("aria-pressed", "false"));
        expect(editor.getHTML()).toBe("<p><em><u>Hello</u></em></p>");
    });

    it("formats with Ctrl+B, Ctrl+I and Ctrl+U in the text", async () => {
        const { editor, onChange } = await renderEditor("<p>Hello</p>");
        act(() => {
            editor.commands.selectAll();
        });
        const text = screen.getByRole("textbox");

        fireEvent.keyDown(text, { key: "b", ctrlKey: true });
        fireEvent.keyDown(text, { key: "i", ctrlKey: true });
        fireEvent.keyDown(text, { key: "u", ctrlKey: true });

        expect(onChange).toHaveBeenLastCalledWith("<p><strong><em><u>Hello</u></em></strong></p>");
    });

    it("makes numbered and bulleted lists, and shows which one the caret is in", async () => {
        const { editor, onChange } = await renderEditor("<p>one</p>");
        act(() => {
            editor.commands.selectAll();
        });

        fireEvent.click(button("Numbered list"));
        expect(onChange).toHaveBeenLastCalledWith("<ol><li><p>one</p></li></ol>");
        await waitFor(() => expect(button("Numbered list")).toHaveAttribute("aria-pressed", "true"));
        expect(button("Bulleted list")).toHaveAttribute("aria-pressed", "false");

        fireEvent.click(button("Bulleted list"));
        expect(onChange).toHaveBeenLastCalledWith("<ul><li><p>one</p></li></ul>");
        await waitFor(() => expect(button("Bulleted list")).toHaveAttribute("aria-pressed", "true"));
    });

    it("removes formatting with the last button, leaving the lists", async () => {
        const { editor, onChange } = await renderEditor('<ul><li><p><strong>bold</strong> <em>and</em> <a href="https://example.com">linked</a></p></li></ul>');
        act(() => {
            editor.commands.selectAll();
        });

        fireEvent.click(button("Remove formatting"));

        expect(onChange).toHaveBeenLastCalledWith("<ul><li><p>bold and linked</p></li></ul>");
    });

    it("cannot write anything an event description may not hold: no headings, strikethrough, quotes, code or rules", async () => {
        const { editor } = await renderEditor(
            "<h1>Title</h1><p><s>gone</s> <code>code</code></p><blockquote><p>quoted</p></blockquote><pre><code>block</code></pre><hr><p><img src=\"https://example.com/x.png\"></p>",
        );
        const html = editor.getHTML();
        for (const tag of ["<h1", "<s>", "<code", "<blockquote", "<pre", "<hr", "<img"]) {
            expect(html).not.toContain(tag);
        }
        expect(html).toContain("Title");
        expect(html).toContain("quoted");
    });

    describe("the toolbar as a WAI-ARIA toolbar", () => {
        it("is one tab stop: only the focused button is tabbable, and the arrow keys, Home and End move along it", async () => {
            await renderEditor("");
            const bold = button("Bold");
            const remove = button("Remove formatting");
            expect(bold).toHaveAttribute("tabindex", "0");
            expect(button("Italic")).toHaveAttribute("tabindex", "-1");

            bold.focus();
            fireEvent.keyDown(bold, { key: "ArrowRight" });
            expect(button("Italic")).toHaveFocus();
            expect(button("Italic")).toHaveAttribute("tabindex", "0");
            expect(bold).toHaveAttribute("tabindex", "-1");

            fireEvent.keyDown(button("Italic"), { key: "ArrowLeft" });
            expect(bold).toHaveFocus();
            // Both ends wrap.
            fireEvent.keyDown(bold, { key: "ArrowLeft" });
            expect(remove).toHaveFocus();
            fireEvent.keyDown(remove, { key: "ArrowRight" });
            expect(bold).toHaveFocus();
            fireEvent.keyDown(bold, { key: "End" });
            expect(remove).toHaveFocus();
            fireEvent.keyDown(remove, { key: "Home" });
            expect(bold).toHaveFocus();
            // Other keys are left alone.
            const other = fireEvent.keyDown(bold, { key: "a" });
            expect(other).toBe(true);
            expect(bold).toHaveFocus();
        });

        it("does not take the focus (or the selection) from the text when a button is pressed", async () => {
            await renderEditor("<p>Hello</p>");
            const notPrevented = fireEvent.mouseDown(button("Bold"));
            expect(notPrevented).toBe(false);
        });
    });

    describe("links", () => {
        it("asks for an address with the Link button, and links the selected text", async () => {
            const { editor, onChange } = await renderEditor("<p>Hello</p>");
            act(() => {
                editor.commands.selectAll();
            });

            fireEvent.click(button("Link"));
            const input = screen.getByLabelText("Link address");
            expect(input).toHaveValue("");
            fireEvent.change(input, { target: { value: "example.com" } });
            fireEvent.click(button("Apply"));

            expect(screen.queryByLabelText("Link address")).not.toBeInTheDocument();
            const html = onChange.mock.lastCall![0] as string;
            expect(html).toContain('href="https://example.com/"');
            expect(html).toContain("Hello");
            await waitFor(() => expect(button("Link")).toHaveAttribute("aria-pressed", "true"));
        });

        it("inserts the address itself as the link text when nothing is selected", async () => {
            const { editor, onChange } = await renderEditor("");
            act(() => {
                editor.commands.focus();
            });

            fireEvent.click(button("Link"));
            fireEvent.change(screen.getByLabelText("Link address"), { target: { value: "jane@example.com" } });
            fireEvent.keyDown(screen.getByLabelText("Link address"), { key: "Enter" });

            const html = onChange.mock.lastCall![0] as string;
            expect(html).toContain('href="mailto:jane@example.com"');
            expect(html).toContain(">jane@example.com<");
        });

        it("writes a link with rel noopener noreferrer, and no javascript: link", async () => {
            const { editor } = await renderEditor('<p><a href="javascript:alert(1)">bad</a> <a href="https://example.com">good</a></p>');
            const html = editor.getHTML();
            expect(html).not.toContain("javascript:");
            expect(html).toContain('rel="noopener noreferrer"');
            expect(html).toContain('href="https://example.com"');
        });

        it("says so, and applies nothing, for an address that is not a web or mail address", async () => {
            const { editor, onChange } = await renderEditor("<p>Hello</p>");
            act(() => {
                editor.commands.selectAll();
            });

            fireEvent.click(button("Link"));
            fireEvent.change(screen.getByLabelText("Link address"), { target: { value: "javascript:alert(1)" } });
            fireEvent.click(button("Apply"));

            expect(screen.getByRole("alert")).toHaveTextContent("Enter a web address (http or https) or an email address.");
            expect(onChange).not.toHaveBeenCalled();
            // Typing again clears the message.
            fireEvent.change(screen.getByLabelText("Link address"), { target: { value: "x" } });
            expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        });

        it("shows the address of the link the caret is in, changes it, and removes it when it is emptied", async () => {
            const { editor, onChange } = await renderEditor('<p><a href="https://example.com/old">link</a></p>');
            act(() => {
                editor.commands.setTextSelection(3);
            });

            fireEvent.click(button("Link"));
            const input = screen.getByLabelText("Link address");
            expect(input).toHaveValue("https://example.com/old");
            fireEvent.change(input, { target: { value: "https://example.com/new" } });
            fireEvent.click(button("Apply"));
            expect(onChange.mock.lastCall![0]).toContain('href="https://example.com/new"');

            fireEvent.click(button("Link"));
            fireEvent.change(screen.getByLabelText("Link address"), { target: { value: "  " } });
            fireEvent.click(button("Apply"));
            expect(onChange.mock.lastCall![0]).toBe("<p>link</p>");
        });

        it("leaves the other keys typed into the prompt alone", async () => {
            await renderEditor("<p>Hello</p>");
            fireEvent.click(button("Link"));
            const input = screen.getByLabelText("Link address");

            fireEvent.keyDown(input, { key: "a" });
            fireEvent.keyDown(input, { key: "Tab" });

            expect(screen.getByLabelText("Link address")).toBeInTheDocument();
        });

        it("closes the prompt with Cancel or Escape - Escape not reaching the dialog around it - and returns to the text", async () => {
            const { editor } = await renderEditor("<p>Hello</p>");
            const outer = vi.fn();
            document.addEventListener("keydown", outer);
            act(() => {
                editor.commands.selectAll();
            });

            fireEvent.click(button("Link"));
            fireEvent.click(button("Cancel"));
            expect(screen.queryByLabelText("Link address")).not.toBeInTheDocument();

            fireEvent.click(button("Link"));
            fireEvent.keyDown(screen.getByLabelText("Link address"), { key: "Escape" });
            expect(screen.queryByLabelText("Link address")).not.toBeInTheDocument();
            expect(outer.mock.calls.filter(([event]) => (event as KeyboardEvent).key === "Escape")).toHaveLength(0);
            document.removeEventListener("keydown", outer);
        });

        it("opens the prompt with Ctrl+K in the text, and leaves other keys alone", async () => {
            await renderEditor("<p>Hello</p>");
            const text = screen.getByRole("textbox");

            fireEvent.keyDown(text, { key: "k", ctrlKey: true, shiftKey: true });
            expect(screen.queryByLabelText("Link address")).not.toBeInTheDocument();
            fireEvent.keyDown(text, { key: "k" });
            expect(screen.queryByLabelText("Link address")).not.toBeInTheDocument();

            fireEvent.keyDown(text, { key: "k", ctrlKey: true });
            expect(screen.getByLabelText("Link address")).toBeInTheDocument();
        });

        it("does not submit the form the editor is in when a link is applied with Enter", async () => {
            const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
            const { container } = render(
                <form onSubmit={onSubmit}>
                    <DescriptionEditor value="<p>Hello</p>" onChange={vi.fn()} />
                </form>,
            );
            const editor = await mountedEditor(container);
            act(() => {
                editor.commands.selectAll();
            });

            fireEvent.click(button("Link"));
            fireEvent.change(screen.getByLabelText("Link address"), { target: { value: "https://example.com" } });
            fireEvent.keyDown(screen.getByLabelText("Link address"), { key: "Enter" });

            expect(onSubmit).not.toHaveBeenCalled();
            expect(editor.getHTML()).toContain("https://example.com");
        });
    });

    describe("paste", () => {
        /** A paste event carrying the given clipboard formats. */
        function paste(target: HTMLElement, data: Record<string, string> | undefined) {
            const event = new Event("paste", { bubbles: true, cancelable: true });
            Object.defineProperty(event, "clipboardData", { value: data ? { getData: (type: string) => data[type] ?? "", types: Object.keys(data) } : undefined });
            target.dispatchEvent(event);
            return event;
        }

        it("keeps the text of pasted rich text and drops its formatting, one paragraph a line", async () => {
            const { editor, onChange } = await renderEditor("");
            act(() => {
                editor.commands.focus();
            });

            const event = paste(screen.getByRole("textbox"), {
                "text/plain": "first line\r\n\r\nthird <b>line</b>",
                "text/html": "<h1>first line</h1><p><strong>third</strong> <a href='https://example.com'>line</a></p>",
            });

            expect(event.defaultPrevented).toBe(true);
            expect(onChange.mock.lastCall![0]).toBe("<p>first line</p><p></p><p>third &lt;b&gt;line&lt;/b&gt;</p>");
        });

        it("leaves a paste with no text on the clipboard (an image, say) to the editor", async () => {
            const { editor } = await renderEditor("");
            act(() => {
                editor.commands.focus();
            });

            expect(paste(screen.getByRole("textbox"), { "text/plain": "" }).defaultPrevented).toBe(false);
            // Nor does a paste with no clipboard at all (ProseMirror then reads it back through a hidden field, a moment later).
            expect(paste(screen.getByRole("textbox"), undefined).defaultPrevented).toBe(false);
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 120));
            });
            expect(editor.getHTML()).toBe("<p></p>");
        });
    });
});

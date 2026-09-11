// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ComposeToolbar from "../../../apps/shared/components/mail/compose/ComposeToolbar.js";

// `EmojiPicker`/`GifPicker` are tested in their own files (including `PopoverPortal`'s positioning
// logic) — mocked here to bare buttons exposing just the callbacks `ComposeToolbar` wires up, matching
// this codebase's "mock a child wholesale, test it separately" convention (e.g. `RichTextEditor`
// mocking `ComposeToolbar` in its own tests).
vi.mock("../../../apps/shared/components/mail/compose/EmojiPicker.js", () => ({
    default: ({ onSelect, onClose }: { onSelect: (native: string) => void; onClose: () => void }) => (
        <div>
            <button type="button" onClick={() => onSelect("😀")}>
                fake-emoji
            </button>
            <button type="button" onClick={onClose}>
                fake-emoji-close
            </button>
        </div>
    ),
}));
vi.mock("../../../apps/shared/components/mail/compose/GifPicker.js", () => ({
    default: ({ onSelect, onClose }: { onSelect: (url: string) => void; onClose: () => void }) => (
        <div>
            <button type="button" onClick={() => onSelect("https://media.giphy.com/fake.gif")}>
                fake-gif
            </button>
            <button type="button" onClick={onClose}>
                fake-gif-close
            </button>
        </div>
    ),
}));

/**
 * A minimal fake `Editor` exposing exactly the chainable command surface `ComposeToolbar` drives —
 * `.chain()` returns an object where every command method records its own name (plus args) into
 * `calls` and returns itself for further chaining, ending in `.run()`. Mirrors this codebase's
 * established "hand-built fake exposing exactly what's called" pattern (see `MonacoHtmlEditor.test.tsx`'s
 * `fakeEditor`), just chainable rather than flat since TipTap's command API is chainable.
 */
function fakeEditor(options: {
    active?: Record<string, boolean>;
    attributes?: Record<string, Record<string, unknown>>;
    canUndo?: boolean;
    canRedo?: boolean;
} = {}) {
    const calls: string[] = [];
    const COMMANDS = [
        "toggleBold",
        "toggleItalic",
        "toggleUnderline",
        "toggleStrike",
        "setFontFamily",
        "unsetFontFamily",
        "setFontSize",
        "unsetFontSize",
        "setColor",
        "toggleHighlight",
        "setTextAlign",
        "toggleBulletList",
        "toggleOrderedList",
        "liftListItem",
        "sinkListItem",
        "extendMarkRange",
        "unsetLink",
        "setLink",
        "setImage",
        "insertContent",
        "insertTable",
        "unsetAllMarks",
        "clearNodes",
        "undo",
        "redo",
    ] as const;
    const chain: any = {
        focus: () => chain,
        run: () => {
            calls.push("run");
            return true;
        },
    };
    for (const name of COMMANDS) {
        chain[name] = (...args: unknown[]) => {
            calls.push(args.length > 0 ? `${name}(${JSON.stringify(args)})` : name);
            return chain;
        };
    }
    return {
        calls,
        chain: () => chain,
        can: () => ({ undo: () => options.canUndo ?? true, redo: () => options.canRedo ?? true }),
        isActive: (name: string | Record<string, unknown>) => {
            const key = typeof name === "string" ? name : JSON.stringify(name);
            return options.active?.[key] ?? false;
        },
        getAttributes: (name: string) => options.attributes?.[name] ?? {},
    } as any;
}

function renderToolbar(props: Partial<React.ComponentProps<typeof ComposeToolbar>> = {}) {
    return render(<ComposeToolbar editor={null} onUploadImage={vi.fn()} {...props} />);
}

describe("ComposeToolbar", () => {
    it("disables every control when the editor hasn't mounted yet (editor === null)", () => {
        renderToolbar();

        expect(screen.getByLabelText("Bold")).toBeDisabled();
        expect(screen.getByLabelText("Font family")).toBeDisabled();
        expect(screen.getByLabelText("Font size")).toBeDisabled();
        expect(screen.getByLabelText("Text color")).toBeDisabled();
        expect(screen.getByLabelText("Undo")).toBeDisabled();
        expect(screen.getByLabelText("Redo")).toBeDisabled();
    });

    it.each([
        ["Bold", "toggleBold"],
        ["Italic", "toggleItalic"],
        ["Underline", "toggleUnderline"],
        ["Strikethrough", "toggleStrike"],
        ["Highlight", "toggleHighlight"],
        ["Align left", 'setTextAlign(["left"])'],
        ["Align center", 'setTextAlign(["center"])'],
        ["Align right", 'setTextAlign(["right"])'],
        ["Justify", 'setTextAlign(["justify"])'],
        ["Bulleted list", "toggleBulletList"],
        ["Numbered list", "toggleOrderedList"],
        ["Decrease indent", 'liftListItem(["listItem"])'],
        ["Increase indent", 'sinkListItem(["listItem"])'],
        [
            "Insert table",
            'insertTable([{"rows":3,"cols":3,"withHeaderRow":true}])',
        ],
        ["Clear formatting", "unsetAllMarks"],
        ["Undo", "undo"],
        ["Redo", "redo"],
    ])("clicking %s runs the %s command", async (label, expectedCall) => {
        const editor = fakeEditor();
        const user = userEvent.setup();
        renderToolbar({ editor });

        await user.click(screen.getByLabelText(label));

        expect(editor.calls).toContain(expectedCall);
        expect(editor.calls[editor.calls.length - 1]).toBe("run");
    });

    it("renders a button as active (pressed) when the editor reports that mark/node as active", () => {
        const editor = fakeEditor({ active: { bold: true } });
        renderToolbar({ editor });

        expect(screen.getByLabelText("Bold")).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByLabelText("Italic")).toHaveAttribute("aria-pressed", "false");
    });

    it("disables Undo/Redo when the editor reports the history stack is empty", () => {
        const editor = fakeEditor({ canUndo: false, canRedo: false });
        renderToolbar({ editor });

        expect(screen.getByLabelText("Undo")).toBeDisabled();
        expect(screen.getByLabelText("Redo")).toBeDisabled();
    });

    it("changes font family, and clears it when the default option is chosen", async () => {
        const editor = fakeEditor();
        const user = userEvent.setup();
        renderToolbar({ editor });

        await user.selectOptions(screen.getByLabelText("Font family"), "Serif");
        expect(editor.calls).toContain('setFontFamily(["Georgia, \'Times New Roman\', serif"])');

        await user.selectOptions(screen.getByLabelText("Font family"), "Default");
        expect(editor.calls).toContain("unsetFontFamily");
    });

    it("shows the editor's current font family in the select.", () => {
        const editor = fakeEditor({ attributes: { textStyle: { fontFamily: "Arial, Helvetica, sans-serif" } } });
        renderToolbar({ editor });

        expect(screen.getByLabelText("Font family")).toHaveValue("Arial, Helvetica, sans-serif");
    });

    it("changes font size, and clears it when the default option is chosen", async () => {
        const editor = fakeEditor();
        const user = userEvent.setup();
        renderToolbar({ editor });

        await user.selectOptions(screen.getByLabelText("Font size"), "Large");
        expect(editor.calls).toContain('setFontSize(["18px"])');

        await user.selectOptions(screen.getByLabelText("Font size"), "Normal");
        expect(editor.calls).toContain("unsetFontSize");
    });

    it("shows the editor's current font size in the select.", () => {
        const editor = fakeEditor({ attributes: { textStyle: { fontSize: "12px" } } });
        renderToolbar({ editor });

        expect(screen.getByLabelText("Font size")).toHaveValue("12px");
    });

    it("applies a text color via the color input.", () => {
        const editor = fakeEditor();
        renderToolbar({ editor });

        // jsdom's <input type="color"> doesn't support typing an arbitrary hex string via userEvent, so
        // drive the change handler directly instead — the same approach this codebase already uses for
        // other native-input edge cases (e.g. compose's file input tests).
        fireEvent.change(screen.getByLabelText("Text color"), { target: { value: "#ff0000" } });

        expect(editor.calls).toContain('setColor(["#ff0000"])');
    });

    it("shows the editor's current text color in the color input.", () => {
        const editor = fakeEditor({ attributes: { textStyle: { color: "#00ff00" } } });
        renderToolbar({ editor });

        expect(screen.getByLabelText("Text color")).toHaveValue("#00ff00");
    });

    it("clicking Insert image opens a file picker, uploads the chosen file, and inserts the resolved URL.", async () => {
        const editor = fakeEditor();
        const onUploadImage = vi.fn().mockResolvedValue("https://server.example.com/attachments/a1/content");
        const user = userEvent.setup();
        renderToolbar({ editor, onUploadImage });

        const file = new File(["pixels"], "photo.png", { type: "image/png" });
        await user.upload(screen.getByLabelText("Insert image file"), file);

        expect(onUploadImage).toHaveBeenCalledWith(file);
        expect(editor.calls).toContain('setImage([{"src":"https://server.example.com/attachments/a1/content"}])');
    });

    it("does not insert an image when the upload fails (onUploadImage resolves null).", async () => {
        const editor = fakeEditor();
        const onUploadImage = vi.fn().mockResolvedValue(null);
        const user = userEvent.setup();
        renderToolbar({ editor, onUploadImage });

        const file = new File(["pixels"], "photo.png", { type: "image/png" });
        await user.upload(screen.getByLabelText("Insert image file"), file);

        expect(onUploadImage).toHaveBeenCalledWith(file);
        expect(editor.calls).not.toContain(expect.stringContaining("setImage"));
    });

    it("ignores a change event with no file selected.", async () => {
        const editor = fakeEditor();
        const onUploadImage = vi.fn();
        renderToolbar({ editor, onUploadImage });

        const input = screen.getByLabelText("Insert image file");
        Object.defineProperty(input, "files", { value: [], configurable: true });
        fireEvent.change(input);

        expect(onUploadImage).not.toHaveBeenCalled();
    });

    it("clicking the Insert image button itself opens the hidden file picker.", async () => {
        const editor = fakeEditor();
        const user = userEvent.setup();
        renderToolbar({ editor });
        const input = screen.getByLabelText("Insert image file");
        const clickSpy = vi.spyOn(input, "click");

        await user.click(screen.getByLabelText("Insert image"));

        expect(clickSpy).toHaveBeenCalled();
    });

    it("opens the emoji picker, inserts the selected emoji, and closes the picker.", async () => {
        const editor = fakeEditor();
        const user = userEvent.setup();
        renderToolbar({ editor });

        await user.click(screen.getByLabelText("Insert emoji"));
        await user.click(screen.getByText("fake-emoji"));

        expect(editor.calls).toContain('insertContent(["😀"])');
        expect(screen.queryByText("fake-emoji")).not.toBeInTheDocument();
    });

    it("closes the emoji picker via its own onClose without inserting anything.", async () => {
        const editor = fakeEditor();
        const user = userEvent.setup();
        renderToolbar({ editor });

        await user.click(screen.getByLabelText("Insert emoji"));
        await user.click(screen.getByText("fake-emoji-close"));

        expect(screen.queryByText("fake-emoji-close")).not.toBeInTheDocument();
        expect(editor.calls).not.toContain(expect.stringContaining("insertContent"));
    });

    it("toggles the emoji picker closed when its own button is clicked again.", async () => {
        const editor = fakeEditor();
        const user = userEvent.setup();
        renderToolbar({ editor });

        await user.click(screen.getByLabelText("Insert emoji"));
        expect(screen.getByText("fake-emoji")).toBeInTheDocument();
        await user.click(screen.getByLabelText("Insert emoji"));

        expect(screen.queryByText("fake-emoji")).not.toBeInTheDocument();
    });

    it("toggles the GIF picker closed when its own button is clicked again.", async () => {
        const editor = fakeEditor();
        const user = userEvent.setup();
        renderToolbar({ editor });

        await user.click(screen.getByLabelText("Insert GIF"));
        expect(screen.getByText("fake-gif")).toBeInTheDocument();
        await user.click(screen.getByLabelText("Insert GIF"));

        expect(screen.queryByText("fake-gif")).not.toBeInTheDocument();
    });

    it("opens the GIF picker, inserts the selected GIF as an image, and closes the picker.", async () => {
        const editor = fakeEditor();
        const user = userEvent.setup();
        renderToolbar({ editor });

        await user.click(screen.getByLabelText("Insert GIF"));
        await user.click(screen.getByText("fake-gif"));

        expect(editor.calls).toContain('setImage([{"src":"https://media.giphy.com/fake.gif"}])');
        expect(screen.queryByText("fake-gif")).not.toBeInTheDocument();
    });

    it("closes the GIF picker via its own onClose without inserting anything.", async () => {
        const editor = fakeEditor();
        const user = userEvent.setup();
        renderToolbar({ editor });

        await user.click(screen.getByLabelText("Insert GIF"));
        await user.click(screen.getByText("fake-gif-close"));

        expect(screen.queryByText("fake-gif-close")).not.toBeInTheDocument();
        expect(editor.calls).not.toContain(expect.stringContaining("setImage"));
    });

    it("opening the GIF picker while the emoji picker is open closes the emoji picker (mutually exclusive).", async () => {
        const editor = fakeEditor();
        const user = userEvent.setup();
        renderToolbar({ editor });

        await user.click(screen.getByLabelText("Insert emoji"));
        expect(screen.getByText("fake-emoji")).toBeInTheDocument();

        await user.click(screen.getByLabelText("Insert GIF"));

        expect(screen.queryByText("fake-emoji")).not.toBeInTheDocument();
        expect(screen.getByText("fake-gif")).toBeInTheDocument();
    });

    it("opens a link prompt, applies a link, then closes the prompt.", async () => {
        const editor = fakeEditor();
        const user = userEvent.setup();
        renderToolbar({ editor });

        await user.click(screen.getByLabelText("Insert link"));
        const urlInput = await screen.findByLabelText("Link URL");
        await user.type(urlInput, "https://example.com");
        await user.click(screen.getByRole("button", { name: "Apply" }));

        expect(editor.calls).toContain('extendMarkRange(["link"])');
        expect(editor.calls).toContain('setLink([{"href":"https://example.com"}])');
        expect(screen.queryByLabelText("Link URL")).not.toBeInTheDocument();
    });

    it("removes a link when the prompt is submitted empty.", async () => {
        const editor = fakeEditor({ active: { link: true }, attributes: { link: { href: "https://old.example.com" } } });
        const user = userEvent.setup();
        renderToolbar({ editor });

        const linkButton = screen.getByLabelText("Insert link");
        expect(linkButton).toHaveAttribute("aria-pressed", "true");
        await user.click(linkButton);

        const urlInput = await screen.findByLabelText("Link URL");
        expect(urlInput).toHaveValue("https://old.example.com");
        await user.clear(urlInput);
        await user.click(screen.getByRole("button", { name: "Apply" }));

        expect(editor.calls).toContain("unsetLink");
    });

    it("closes the link prompt without applying anything when cancelled.", async () => {
        const editor = fakeEditor();
        const user = userEvent.setup();
        renderToolbar({ editor });

        await user.click(screen.getByLabelText("Insert link"));
        await screen.findByLabelText("Link URL");
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        expect(screen.queryByLabelText("Link URL")).not.toBeInTheDocument();
        expect(editor.calls).not.toContain("setLink");
        expect(editor.calls).not.toContain("unsetLink");
    });
});

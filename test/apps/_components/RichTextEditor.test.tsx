// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RichTextEditor from "../../../apps/shared/components/mail/compose/RichTextEditor.js";

let lastUseEditorOptions: any;

vi.mock("@tiptap/react", () => ({
    useEditor: vi.fn((options: any) => {
        lastUseEditorOptions = options;
        return { fake: "editor" };
    }),
    EditorContent: ({ editor, style, className }: any) => (
        <div data-testid="editor-content" data-has-editor={editor != null} style={style} className={className} />
    ),
}));

vi.mock("../../../apps/shared/components/mail/compose/ComposeToolbar.js", () => ({
    default: ({ editor }: any) => <div data-testid="toolbar" data-has-editor={editor != null} />,
}));

afterEach(() => {
    vi.clearAllMocks();
    lastUseEditorOptions = undefined;
});

describe("RichTextEditor", () => {
    it("seeds the editor's initial content from value, and never re-renders it as immediatelyRender-eligible", () => {
        render(<RichTextEditor value="<p>seed</p>" onChange={vi.fn()} />);

        expect(lastUseEditorOptions.content).toBe("<p>seed</p>");
        expect(lastUseEditorOptions.immediatelyRender).toBe(false);
    });

    it("reports edits via onChange, using the updated editor's HTML.", () => {
        const onChange = vi.fn();
        render(<RichTextEditor value="" onChange={onChange} />);

        const updatedEditor = { getHTML: () => "<p>edited</p>" };
        lastUseEditorOptions.onUpdate({ editor: updatedEditor });

        expect(onChange).toHaveBeenCalledWith("<p>edited</p>");
    });

    it("passes the same editor instance to both the toolbar and the editable content area.", async () => {
        render(<RichTextEditor value="" onChange={vi.fn()} />);

        expect(await screen.findByTestId("toolbar")).toHaveAttribute("data-has-editor", "true");
        expect(screen.getByTestId("editor-content")).toHaveAttribute("data-has-editor", "true");
    });

    it("uses a default height of 360px, overridable via the height prop.", () => {
        const { rerender } = render(<RichTextEditor value="" onChange={vi.fn()} />);
        expect(screen.getByTestId("editor-content")).toHaveStyle({ height: "360px" });

        rerender(<RichTextEditor value="" onChange={vi.fn()} height="600px" />);
        expect(screen.getByTestId("editor-content")).toHaveStyle({ height: "600px" });
    });

    it("fills its parent's height via flexbox instead of a fixed height when fill is set.", () => {
        render(<RichTextEditor value="" onChange={vi.fn()} fill />);
        const content = screen.getByTestId("editor-content");
        expect(content.style.height).toBe("");
        expect(content.className).toContain("flex-1");
    });
});

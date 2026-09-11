// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React, { useRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import EmojiPicker from "../../../apps/shared/components/mail/compose/EmojiPicker.js";

// `PopoverPortal`'s own positioning/portal/outside-click behavior is tested in `PopoverPortal.test.tsx`
// — mocked here to a plain passthrough so this file only exercises `EmojiPicker`'s own content.
vi.mock("../../../apps/shared/components/mail/compose/PopoverPortal.js", () => ({
    default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function Harness() {
    const anchorRef = useRef<HTMLButtonElement>(null);
    return (
        <div>
            <button ref={anchorRef} type="button">
                anchor
            </button>
            <EmojiPicker anchorRef={anchorRef} onSelect={vi.fn()} onClose={vi.fn()} />
        </div>
    );
}

describe("EmojiPicker", () => {
    it("renders every category with a readable label, and at least one emoji button in each.", () => {
        render(<Harness />);

        expect(screen.getByText("Smileys & People")).toBeInTheDocument();
        expect(screen.getByText("Animals & Nature")).toBeInTheDocument();
        expect(screen.getByText("Flags")).toBeInTheDocument();
        // A specific, stable emoji that should always be present regardless of dataset updates.
        expect(screen.getByRole("button", { name: "Grinning Face" })).toHaveTextContent("😀");
    });

    it("calls onSelect with the clicked emoji's native character.", async () => {
        const onSelect = vi.fn();
        const anchorRef = { current: null };
        const user = userEvent.setup();
        render(<EmojiPicker anchorRef={anchorRef} onSelect={onSelect} onClose={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Grinning Face" }));

        expect(onSelect).toHaveBeenCalledWith("😀");
    });
});

describe("EmojiPicker with an unrecognized category id", () => {
    vi.doMock("@rapidmx/react-shared/emojiData.js", () => ({
        EMOJI_CATEGORIES: [{ id: "mystery", emojis: [{ id: "e1", native: "🦄", name: "Unicorn" }] }],
    }));

    it("falls back to the raw category id when it has no known display label.", async () => {
        vi.resetModules();
        const { default: EmojiPickerWithMockedData } = await import("../../../apps/shared/components/mail/compose/EmojiPicker.js");
        const anchorRef = { current: null };
        render(<EmojiPickerWithMockedData anchorRef={anchorRef} onSelect={vi.fn()} onClose={vi.fn()} />);

        expect(screen.getByText("mystery")).toBeInTheDocument();
    });
});

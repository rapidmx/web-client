// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
    ROW_FOCUS_CLASS,
    UnreadBar,
    UnreadLabel,
    dateClass,
    isUnread,
    rowClass,
    senderClass,
    subjectClass,
} from "../../../apps/shared/components/mail/unreadStyle.js";

describe("isUnread", () => {
    it("is true unless flags.read is true - a message with no read flag is unread", () => {
        expect(isUnread({ flags: { read: false } } as any)).toBe(true);
        expect(isUnread({ flags: {} } as any)).toBe(true);
        expect(isUnread({ flags: { read: true } } as any)).toBe(false);
    });

    it("is false for no message", () => {
        expect(isUnread(undefined)).toBe(false);
        expect(isUnread(null)).toBe(false);
    });
});

describe("row styling", () => {
    it("tints an unread row and stresses its hover, but not a read one", () => {
        expect(rowClass({ unread: true, selected: false })).toContain("bg-primary/[0.07]");
        expect(rowClass({ unread: true, selected: false })).toContain("hover:bg-primary/10");
        expect(rowClass({ unread: false, selected: false })).not.toContain("bg-primary");
        expect(rowClass({ unread: false, selected: false })).toContain("hover:bg-surface-alt");
    });

    it("gives the open row its own stronger fill and outline, over an unread tint", () => {
        for (const unread of [true, false]) {
            const selected = rowClass({ unread, selected: true });
            expect(selected).toContain("bg-primary/20");
            expect(selected).toContain("ring-1");
            expect(selected).not.toContain("bg-primary/[0.07]");
            expect(selected).not.toContain("hover:");
        }
    });

    it("positions the bar, and takes extra classes", () => {
        expect(rowClass({ unread: false, selected: false }, "flex items-stretch")).toMatch(/^relative .*flex items-stretch$/);
        expect(rowClass({ unread: false, selected: false })).not.toMatch(/ $/);
    });

    it("draws keyboard focus as a solid outline of its own", () => {
        expect(ROW_FOCUS_CLASS).toContain("focus-visible:outline-2");
    });

    it("makes unread text bold and full strength, and read text normal and muted", () => {
        expect(senderClass(true)).toContain("font-bold");
        expect(senderClass(false)).toContain("font-normal");
        expect(senderClass(false)).toContain("text-text-muted");
        expect(subjectClass(true)).toContain("font-semibold");
        expect(subjectClass(false)).toContain("font-normal");
        expect(dateClass(true)).toContain("text-primary-dark");
        expect(dateClass(false)).toContain("text-text-muted");
    });
});

describe("UnreadBar and UnreadLabel", () => {
    it("draw an accent bar, hidden from assistive technology, and say 'Unread' in text - only for an unread row", () => {
        const { container, rerender } = render(
            <div>
                <UnreadBar unread />
                <UnreadLabel unread />
            </div>,
        );
        expect(container.querySelector("[data-unread-bar]")).toHaveAttribute("aria-hidden", "true");
        expect(screen.getByText("Unread.")).toHaveClass("sr-only");

        rerender(
            <div>
                <UnreadBar unread={false} />
                <UnreadLabel unread={false} />
            </div>,
        );
        expect(container.querySelector("[data-unread-bar]")).toBeNull();
        expect(screen.queryByText("Unread.")).not.toBeInTheDocument();
    });
});

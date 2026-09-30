// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FolderTypeIcon, SharedMailboxMark } from "../../../apps/shared/components/mail/layout/folderIcons.js";

const TYPES = ["inbox", "sent_items", "drafts", "deleted_items", "outbox", "junk", "archive", "calendar", "contacts", "tasks", "notes", "user"];

function iconOf(type: string): string {
    const { container, unmount } = render(<FolderTypeIcon type={type} />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    const html = svg.innerHTML;
    unmount();
    return html;
}

describe("FolderTypeIcon", () => {
    it("draws an icon, hidden from screen readers, for every kind of folder", () => {
        for (const type of TYPES) {
            expect(iconOf(type), type).not.toBe("");
        }
    });

    it("gives the well-known folders each their own icon, and a folder of the user's own, or of a kind it doesn't know, a plain folder", () => {
        const wellKnown = ["inbox", "sent_items", "drafts", "deleted_items", "outbox", "junk", "archive"].map(iconOf);
        expect(new Set(wellKnown).size).toBe(wellKnown.length);
        expect(iconOf("user")).not.toBe("");
        expect(iconOf("something-new")).toBe(iconOf("user"));
        expect(wellKnown).not.toContain(iconOf("user"));
    });
});

describe("SharedMailboxMark", () => {
    it("is the group icon, and the word 'shared' for a screen reader alone", () => {
        const { container } = render(
            <span>
                Support
                <SharedMailboxMark />
            </span>,
        );
        expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
        expect(container.querySelector(".sr-only")).toHaveTextContent("(shared)");
        expect(container).toHaveTextContent("Support (shared)");
    });
});

// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
    BODY_FONT_STYLE,
    CardShell,
    CardSkeleton,
    CollapsedCard,
    ReadingPaneSkeleton,
    SenderAvatar,
    SubjectCard,
} from "../../../apps/shared/components/mail/reading/MessageCard.js";

describe("SubjectCard", () => {
    it("is a header card holding the subject as the document's h1, in the app's own tokens", () => {
        const { container } = render(<SubjectCard subject="Quarterly planning" meta="3 messages">extra</SubjectCard>);
        expect(screen.getByRole("heading", { level: 1, name: "Quarterly planning" })).toBeInTheDocument();
        expect(screen.getByText("3 messages")).toBeInTheDocument();
        expect(screen.getByText("extra")).toBeInTheDocument();
        const header = container.querySelector("header")!;
        expect(header.className).toContain("bg-surface");
        expect(header.className).toContain("border-border");
        // A card, not a bare bar: rounded and lifted.
        expect(header.className).toContain("rounded-lg");
        expect(header.className).toContain("shadow-sm");
    });

    it("has no meta line without meta", () => {
        const { container } = render(<SubjectCard subject="Hi" />);
        expect(container.querySelectorAll("p")).toHaveLength(0);
    });
});

describe("CardShell", () => {
    it("is a rounded, bordered, lifted card that clips its content to its corners", () => {
        const { container } = render(<CardShell className="extra">body</CardShell>);
        const card = container.firstElementChild!;
        for (const name of ["rounded-lg", "border", "bg-surface", "shadow-sm", "overflow-hidden", "extra"]) {
            expect(card.className).toContain(name);
        }
        expect(container.querySelector("[data-unread-bar]")).toBeNull();
    });

    it("draws the accent bar of an unread message down its left edge", () => {
        const { container } = render(<CardShell unread>body</CardShell>);
        expect(container.querySelector("[data-unread-bar]")).not.toBeNull();
    });
});

describe("SenderAvatar", () => {
    it("shows the initials of the sender's name, or of the address without one", () => {
        const { rerender } = render(<SenderAvatar from={{ address: "priya@partner.example", displayName: "Priya Nair" }} />);
        expect(screen.getByText("PN")).toBeInTheDocument();
        rerender(<SenderAvatar from={{ address: "billing@utility.example", name: "Billing" }} />);
        expect(screen.getByText("B")).toBeInTheDocument();
        rerender(<SenderAvatar from={{ address: "ci@acme.example" }} />);
        expect(screen.getByText("C")).toBeInTheDocument();
    });
});

describe("CollapsedCard", () => {
    function collapsed(overrides: Partial<React.ComponentProps<typeof CollapsedCard>> = {}) {
        const ref = vi.fn();
        const onClick = vi.fn();
        render(
            <CollapsedCard
                from={{ address: "priya@partner.example", displayName: "Priya Nair" }}
                date="9/21/2026, 10:00:00 AM"
                preview="Hi, attaching the draft plan"
                unread={false}
                senderClassName="sender-class"
                dateClassName="date-class"
                buttonRef={ref}
                buttonProps={{ onClick, "aria-expanded": false, "aria-controls": "thread-message-m1" }}
                {...overrides}
            />,
        );
        return { ref, onClick };
    }

    it("is one button, named for the sender, that expands the message: sender, date and the first line of the body", async () => {
        const user = userEvent.setup();
        const { ref, onClick } = collapsed();
        const button = screen.getByRole("button", { name: /Priya Nair <priya@partner.example>/ });
        expect(button).toHaveAttribute("aria-expanded", "false");
        expect(button).toHaveAttribute("aria-controls", "thread-message-m1");
        expect(button).toHaveTextContent("9/21/2026, 10:00:00 AM");
        expect(button).toHaveTextContent("Hi, attaching the draft plan");
        expect(ref).toHaveBeenCalledWith(button);
        await user.click(button);
        expect(onClick).toHaveBeenCalledTimes(1);
        // The button is the heading's content, in the body's typeface rather than the display face.
        expect(button.parentElement!.tagName).toBe("H2");
        expect(button.parentElement).toHaveStyle(BODY_FONT_STYLE);
    });

    it("says it is unread - in words, an accent bar and a tint - when it is", () => {
        collapsed({ unread: true });
        expect(screen.getByRole("button", { name: /^Unread\.\s*Priya Nair/ })).toBeInTheDocument();
        expect(screen.getByRole("button").className).toContain("bg-primary/[0.07]");
        expect(document.querySelector("[data-unread-bar]")).not.toBeNull();
    });
});

describe("CardSkeleton", () => {
    it("is hidden from assistive technology - the live region is the pane's", () => {
        const { container } = render(<CardSkeleton />);
        expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    });
});

describe("ReadingPaneSkeleton", () => {
    it("draws the subject card at once when the subject is known, and a skeleton card for each message up to three", () => {
        const { container } = render(<ReadingPaneSkeleton subject="Planning" messageCount={5} />);
        expect(screen.getByRole("status")).toHaveTextContent("Loading the message");
        expect(screen.getByRole("heading", { level: 1, name: "Planning" })).toBeInTheDocument();
        expect(screen.getByText("5 messages")).toBeInTheDocument();
        expect(container.querySelectorAll("[aria-hidden='true'].rounded-lg")).toHaveLength(3);
        // One live region for the whole skeleton.
        expect(screen.getAllByRole("status")).toHaveLength(1);
    });

    it("says '(no subject)' for an empty subject, has no count for one message, and shows one card for none", () => {
        const { container } = render(<ReadingPaneSkeleton subject="" messageCount={0} />);
        expect(screen.getByRole("heading", { name: "(no subject)" })).toBeInTheDocument();
        expect(screen.queryByText(/messages/)).not.toBeInTheDocument();
        expect(container.querySelectorAll("[aria-hidden='true'].rounded-lg")).toHaveLength(1);
    });

    it("draws a placeholder for the subject too when it is not known yet", () => {
        const { container } = render(<ReadingPaneSkeleton />);
        expect(screen.queryByRole("heading")).not.toBeInTheDocument();
        // The subject placeholder and one message card.
        expect(container.querySelectorAll("[aria-hidden='true'].rounded-lg")).toHaveLength(2);
    });
});

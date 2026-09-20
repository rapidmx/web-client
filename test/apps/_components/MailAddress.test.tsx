// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import MailAddress, { RECIPIENT_LINE_LIMIT, RecipientLine } from "../../../apps/shared/components/mail/MailAddress.js";

describe("MailAddress", () => {
    it("shows the name with the address after it, in muted type, and both in the tooltip and accessible text", () => {
        const { container } = render(<MailAddress recipient={{ displayName: "Jean-Philippe", address: "jp@example.com" }} />);

        const root = container.firstElementChild as HTMLElement;
        expect(root).toHaveAttribute("title", "Jean-Philippe <jp@example.com>");
        // Assistive technology gets the whole thing once; the visible halves are hidden from it.
        expect(screen.getByText("Jean-Philippe <jp@example.com>")).toHaveClass("sr-only");
        expect(screen.getByText("Jean-Philippe")).toHaveAttribute("aria-hidden", "true");
        expect(root).toHaveTextContent("Jean-Philippe <jp@example.com>Jean-Philippe<jp@example.com>");
        const address = screen.getByText("jp").parentElement!;
        expect(address).toHaveClass("text-text-muted");
        expect(address).toHaveTextContent("<jp@example.com>");
    });

    it("gives way in the right order: the name shrinks first, then the local part, and the domain never does", () => {
        render(<MailAddress recipient={{ displayName: "A Rather Long Display Name", address: "someone.with.a.long.name@example.com" }} />);

        expect(screen.getByText("A Rather Long Display Name")).toHaveStyle({ flexShrink: "1000" });
        expect(screen.getByText("A Rather Long Display Name")).toHaveClass("truncate");
        expect(screen.getByText("someone.with.a.long.name")).toHaveClass("truncate");
        expect(screen.getByText("@example.com")).toHaveClass("shrink-0");
        expect(screen.getByText("@example.com")).not.toHaveClass("truncate");
    });

    it("shows just the address, not muted, when there is no name or the name is only the address", () => {
        const { unmount } = render(<MailAddress recipient={{ address: "jp@example.com" }} />);
        expect(screen.getByText("jp@example.com", { selector: ".sr-only" })).toBeInTheDocument();
        expect(screen.getByText("jp").parentElement).not.toHaveClass("text-text-muted");
        expect(screen.queryByText("<")).not.toBeInTheDocument();
        unmount();

        const { container } = render(<MailAddress recipient={{ displayName: "JP@example.com", address: "jp@example.com" }} />);
        expect(container.firstElementChild).toHaveAttribute("title", "jp@example.com");
    });

    it("shows an address with no @ whole, and passes a class name to its root", () => {
        const { container } = render(<MailAddress recipient={{ displayName: "Local Only", address: "postmaster" }} className="flex-1" />);
        expect(container.firstElementChild).toHaveClass("flex-1", "min-w-0");
        expect(screen.getByText("postmaster")).toBeInTheDocument();
        expect(container.querySelector(".shrink-0")).toBeNull();
    });

    it("still shows the real address when the name is a different address - quoted, and never in its place", () => {
        const { container } = render(<MailAddress recipient={{ displayName: "ceo@bank.com", address: "evil@example.net" }} />);
        expect(container.firstElementChild).toHaveAttribute("title", '"ceo@bank.com" <evil@example.net>');
        expect(screen.getByText("evil")).toBeInTheDocument();
        expect(screen.getByText("@example.net")).toBeInTheDocument();
    });
});

describe("RecipientLine", () => {
    const people = [
        { displayName: "Alice", address: "alice@example.com" },
        { displayName: "Doe, Bob", address: "bob@example.com" },
        { address: "carol@example.com" },
        { displayName: "Dave", address: "dave@example.com" },
        { displayName: "Erin", address: "erin@example.com" },
    ];

    it("renders nothing for no recipients", () => {
        const { container } = render(<RecipientLine label="Cc" recipients={[]} />);
        expect(container).toBeEmptyDOMElement();
    });

    it("lists every recipient's name and address in the text, in the order given, with no fold up to the limit", () => {
        render(<RecipientLine label="To" recipients={people.slice(0, RECIPIENT_LINE_LIMIT)} />);
        expect(screen.getByText("To").parentElement).toHaveTextContent(
            'To Alice <alice@example.com>, "Doe, Bob" <bob@example.com>, carol@example.com',
        );
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("folds a long list to the first few behind 'and N more', and unfolds and folds it again", async () => {
        const user = userEvent.setup();
        render(<RecipientLine label="To" recipients={people} />);

        const line = screen.getByText("To").parentElement!;
        expect(line).toHaveTextContent("To Alice <alice@example.com>, \"Doe, Bob\" <bob@example.com>, carol@example.com and 2 more");
        expect(line).not.toHaveTextContent("dave@example.com");

        await user.click(screen.getByRole("button", { name: "and 2 more" }));
        expect(line).toHaveTextContent("Dave <dave@example.com>, Erin <erin@example.com>");
        expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute("aria-expanded", "true");

        await user.click(screen.getByRole("button", { name: "Show fewer" }));
        expect(line).not.toHaveTextContent("dave@example.com");
        expect(screen.getByRole("button", { name: "and 2 more" })).toHaveAttribute("aria-expanded", "false");
    });
});

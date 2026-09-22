// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import EncryptedBody from "../../../apps/shared/components/mail/reading/EncryptedBody.js";

afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
});

describe("EncryptedBody", () => {
    it("locked: a lock, what the message is, a hint and one primary Unlock button that asks for the unlock", async () => {
        const onUnlock = vi.fn();
        const user = userEvent.setup();
        const { container } = render(<EncryptedBody locked onUnlock={onUnlock} />);
        expect(screen.getByText("This message is encrypted")).toBeInTheDocument();
        expect(screen.getByText("Unlock your keys to read it")).toBeInTheDocument();
        // The lock is decoration: the words say it.
        expect(container.querySelector("svg")!.closest("[aria-hidden='true']")).not.toBeNull();
        const button = screen.getByRole("button", { name: "Unlock to view this message" });
        expect(button).toHaveTextContent("Unlock");
        expect(button).toBeEnabled();
        await user.click(button);
        expect(onUnlock).toHaveBeenCalledTimes(1);
        // Only the one thing to do.
        expect(screen.getAllByRole("button")).toHaveLength(1);
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("locked, while the unlock prompt is open: the button waits", () => {
        render(<EncryptedBody locked unlocking onUnlock={vi.fn()} />);
        expect(screen.getByRole("button", { name: "Unlock to view this message" })).toBeDisabled();
    });

    it("unlocked but unreadable: says so with the reason and no button - unlocking again would change nothing", () => {
        render(<EncryptedBody locked={false} reason="You are not one of this message's recipients." onUnlock={vi.fn()} />);
        expect(screen.getByText("This message can’t be decrypted")).toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent("You are not one of this message's recipients.");
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
        expect(screen.queryByText("Unlock your keys to read it")).not.toBeInTheDocument();
    });

    it("unreadable with no reason given: just the statement", () => {
        render(<EncryptedBody locked={false} onUnlock={vi.fn()} />);
        expect(screen.getByText("This message can’t be decrypted")).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("sits on the theme's opaque surface, in each scheme, so it stays legible over a translucent card", () => {
        const first = render(<EncryptedBody locked onUnlock={vi.fn()} />);
        expect((first.container.firstElementChild as HTMLElement).style.backgroundColor).toBe("rgb(255, 255, 255)");
        first.unmount();
        document.documentElement.setAttribute("data-theme", "dark");
        const second = render(<EncryptedBody locked onUnlock={vi.fn()} />);
        expect((second.container.firstElementChild as HTMLElement).style.backgroundColor).toBe("rgb(27, 32, 34)");
        expect(second.container.firstElementChild!.className).toContain("border-border");
    });
});

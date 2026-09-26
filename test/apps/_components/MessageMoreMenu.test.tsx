// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import MessageMoreMenu, { MessageMenuActions, MessageMoreMenuProps } from "../../../apps/shared/components/mail/reading/MessageMoreMenu.js";

function actionsFixture(): MessageMenuActions {
    return {
        replyAll: vi.fn(),
        forward: vi.fn(),
        deleteMessage: vi.fn(),
        toggleRead: vi.fn(),
        toggleFlag: vi.fn(),
        reportJunk: vi.fn(),
        reportPhishing: vi.fn(),
        blockSender: vi.fn(),
        neverBlockSender: vi.fn(),
        print: vi.fn(),
        viewSource: vi.fn(),
        viewDetails: vi.fn(),
        saveAsEml: vi.fn(),
        createRule: vi.fn(),
    };
}

function setup(overrides: Partial<MessageMoreMenuProps> = {}) {
    const actions = actionsFixture();
    const user = userEvent.setup();
    render(
        <div>
            <p>outside</p>
            <MessageMoreMenu
                actions={actions}
                senderAddress="sender@example.com"
                read={false}
                flagged={false}
                writable
                busy={false}
                inJunk={false}
                inDeletedItems={false}
                sent={false}
                ownSender={false}
                printReason={undefined}
                composing={false}
                triggerClassName="icon-button"
                {...overrides}
            />
        </div>,
    );
    return { actions, user, trigger: screen.getByRole("button", { name: "More actions" }) };
}

/** The visible names of the menu's rows. */
function rowNames(): string[] {
    return within(screen.getByRole("menu")).getAllByRole("menuitem").map((row) => row.textContent ?? "");
}

describe("the More actions menu", () => {
    it("is a round icon button that opens a menu, named More actions", async () => {
        const { user, trigger } = setup();
        expect(trigger).toHaveClass("icon-button");
        expect(trigger).toHaveAttribute("aria-haspopup", "menu");
        expect(trigger).toHaveAttribute("aria-expanded", "false");
        // Icon only: no label beside the icon and no chevron.
        expect(trigger.textContent).toBe("");
        await user.click(trigger);
        expect(trigger).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByRole("menu", { name: "More actions" })).toBeInTheDocument();
    });

    it("lists the rows there really are, in Outlook's order", async () => {
        const { user, trigger } = setup();
        await user.click(trigger);
        expect(rowNames()).toEqual([
            "Other reply actions",
            "Delete",
            "Mark as read",
            "Flag",
            "Report",
            "Block",
            "Print",
            "View",
            "Save as",
            "Advanced actions",
        ]);
        // The submenus are marked as such, the commands are not.
        for (const name of ["Other reply actions", "Report", "Block", "View", "Save as", "Advanced actions"]) {
            expect(screen.getByRole("menuitem", { name })).toHaveAttribute("aria-haspopup", "menu");
        }
        expect(screen.getByRole("menuitem", { name: "Delete" })).not.toHaveAttribute("aria-haspopup");
    });

    it("says Mark as unread and Unflag for a message that is read and flagged", async () => {
        const { user, trigger } = setup({ read: true, flagged: true });
        await user.click(trigger);
        expect(rowNames()).toContain("Mark as unread");
        expect(rowNames()).toContain("Unflag");
        expect(rowNames()).not.toContain("Mark as read");
        expect(rowNames()).not.toContain("Flag");
    });

    it("runs a command and closes, the focus back on the button", async () => {
        const { user, trigger, actions } = setup();
        await user.click(trigger);
        await user.click(screen.getByRole("menuitem", { name: "Delete" }));
        expect(actions.deleteMessage).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });

    it.each([
        ["Mark as read", "toggleRead"],
        ["Flag", "toggleFlag"],
        ["Print", "print"],
    ] as const)("runs %s", async (name, action) => {
        const { user, trigger, actions } = setup();
        await user.click(trigger);
        await user.click(screen.getByRole("menuitem", { name }));
        expect(actions[action]).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["Other reply actions", "Reply all", "replyAll"],
        ["Other reply actions", "Forward", "forward"],
        ["Report", "Report junk", "reportJunk"],
        ["Report", "Report phishing", "reportPhishing"],
        ["Block", "Block sender@example.com", "blockSender"],
        ["Block", "Never block sender@example.com", "neverBlockSender"],
        ["View", "View message source", "viewSource"],
        ["View", "Message details", "viewDetails"],
        ["Save as", "Save as .eml", "saveAsEml"],
        ["Save as", "Save as PDF", "print"],
        ["Advanced actions", "Create rule", "createRule"],
    ] as const)("runs %s > %s", async (submenu, name, action) => {
        const { user, trigger, actions } = setup();
        await user.click(trigger);
        await user.click(screen.getByRole("menuitem", { name: submenu }));
        // A submenu replaces the menu's rows, under a Back row.
        expect(screen.getByRole("menuitem", { name: /Back to More actions/ })).toBeInTheDocument();
        await user.click(screen.getByRole("menuitem", { name: new RegExp(`^${name.replace(/[.]/g, "\\.")}`) }));
        expect(actions[action]).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("moves with the arrow keys, opens a submenu with Right and leaves it with Left or Escape", async () => {
        const { user, trigger } = setup();
        trigger.focus();
        await user.keyboard("{ArrowDown}");
        expect(screen.getByRole("menuitem", { name: "Other reply actions" })).toHaveFocus();
        await user.keyboard("{ArrowDown}");
        expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
        await user.keyboard("{ArrowUp}{ArrowUp}");
        // Wraps to the last row.
        expect(screen.getByRole("menuitem", { name: "Advanced actions" })).toHaveFocus();
        await user.keyboard("{Home}{ArrowRight}");
        expect(screen.getByRole("menuitem", { name: /Reply all/ })).toHaveFocus();
        await user.keyboard("{ArrowLeft}");
        expect(screen.getByRole("menuitem", { name: "Other reply actions" })).toHaveFocus();
        await user.keyboard("{ArrowRight}{Escape}");
        // Escape leaves the submenu only.
        expect(screen.getByRole("menu")).toBeInTheDocument();
        expect(screen.getByRole("menuitem", { name: "Other reply actions" })).toHaveFocus();
        await user.keyboard("{End}");
        expect(screen.getByRole("menuitem", { name: "Advanced actions" })).toHaveFocus();
    });

    it("closes on Escape with the focus back on the button", async () => {
        const { user, trigger } = setup();
        await user.click(trigger);
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });

    it("closes on a click outside", async () => {
        const { user, trigger } = setup();
        await user.click(trigger);
        expect(screen.getByRole("menu")).toBeInTheDocument();
        await user.click(screen.getByText("outside"));
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("truncates a long address in the Block rows and keeps all of it as the tooltip", async () => {
        const address = "a-very-long-address-indeed-that-goes-on@some-really-long-domain-name.example.com";
        const { user, trigger } = setup({ senderAddress: address });
        await user.click(trigger);
        await user.click(screen.getByRole("menuitem", { name: "Block" }));
        const row = screen.getByRole("menuitem", { name: `Block ${address}` });
        expect(row).toHaveAttribute("title", `Block ${address}`);
        expect(within(row).getByText(`Block ${address}`)).toHaveClass("truncate");
        expect(screen.getByRole("menuitem", { name: `Never block ${address}` })).toHaveAttribute("title", `Never block ${address}`);
    });

    describe("what cannot be done", () => {
        async function open(overrides: Partial<MessageMoreMenuProps>) {
            const context = setup(overrides);
            await context.user.click(context.trigger);
            return context;
        }
        async function submenu(name: string, user: ReturnType<typeof userEvent.setup>) {
            await user.click(screen.getByRole("menuitem", { name }));
        }

        it("disables what changes the message in a view-only mailbox, saying why", async () => {
            const { user } = await open({ writable: false });
            for (const name of ["Delete", "Mark as read", "Flag"]) {
                expect(screen.getByRole("menuitem", { name: new RegExp(`^${name}`) })).toBeDisabled();
            }
            expect(screen.getByRole("menuitem", { name: /^Delete/ })).toHaveTextContent("View-only mailbox");
            // Reading it is not changing it.
            expect(screen.getByRole("menuitem", { name: "Print" })).toBeEnabled();
            await submenu("Report", user);
            expect(screen.getByRole("menuitem", { name: /^Report junk/ })).toBeDisabled();
            expect(screen.getByRole("menuitem", { name: /^Report phishing/ })).toHaveTextContent("View-only mailbox");
            await user.keyboard("{Escape}");
            await submenu("Block", user);
            expect(screen.getByRole("menuitem", { name: /^Block sender/ })).toBeDisabled();
            expect(screen.getByRole("menuitem", { name: /^Never block/ })).toBeDisabled();
            await user.keyboard("{Escape}");
            await submenu("Advanced actions", user);
            expect(screen.getByRole("menuitem", { name: /^Create rule/ })).toBeDisabled();
        });

        it("disables Report junk and Report phishing for a message already in Junk Email", async () => {
            const { user } = await open({ inJunk: true });
            await submenu("Report", user);
            expect(screen.getByRole("menuitem", { name: /^Report junk/ })).toHaveTextContent("Already in Junk Email");
            expect(screen.getByRole("menuitem", { name: /^Report junk/ })).toBeDisabled();
            expect(screen.getByRole("menuitem", { name: /^Report phishing/ })).toBeDisabled();
            await user.keyboard("{Escape}");
            // Blocking the sender of a message that is already in Junk is still right.
            await submenu("Block", user);
            expect(screen.getByRole("menuitem", { name: /^Block sender/ })).toBeEnabled();
        });

        it("reads Delete permanently, and stays usable, for a message already in Deleted Items", async () => {
            const { actions, user } = await open({ inDeletedItems: true });
            expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
            await user.click(screen.getByRole("menuitem", { name: "Delete permanently" }));
            expect(actions.deleteMessage).toHaveBeenCalledTimes(1);
        });

        it("still holds Delete permanently in a view-only mailbox", async () => {
            await open({ inDeletedItems: true, writable: false });
            expect(screen.getByRole("menuitem", { name: /^Delete permanently/ })).toBeDisabled();
        });

        it("disables Report and Block for mail the reader sent", async () => {
            const { user } = await open({ sent: true });
            await submenu("Report", user);
            expect(screen.getByRole("menuitem", { name: /^Report junk/ })).toHaveTextContent("Not available for mail you sent");
            await user.keyboard("{Escape}");
            await submenu("Block", user);
            expect(screen.getByRole("menuitem", { name: /^Block sender/ })).toBeDisabled();
        });

        it("disables Block for the reader's own address", async () => {
            const { user } = await open({ ownSender: true });
            await submenu("Block", user);
            expect(screen.getByRole("menuitem", { name: /^Never block/ })).toHaveTextContent("This is your own address");
            expect(screen.getByRole("menuitem", { name: /^Never block/ })).toBeDisabled();
        });

        it("holds the changing rows while something is being done to the message", async () => {
            const { user } = await open({ busy: true });
            expect(screen.getByRole("menuitem", { name: /^Delete/ })).toHaveTextContent("Working on this message");
            expect(screen.getByRole("menuitem", { name: /^Flag/ })).toBeDisabled();
            await submenu("Report", user);
            expect(screen.getByRole("menuitem", { name: /^Report junk/ })).toBeDisabled();
        });

        it("disables Print and Save as PDF with the reason a message cannot be printed", async () => {
            const { user } = await open({ printReason: "Unlock this message to print it" });
            expect(screen.getByRole("menuitem", { name: /^Print/ })).toBeDisabled();
            expect(screen.getByRole("menuitem", { name: /^Print/ })).toHaveTextContent("Unlock this message to print it");
            await submenu("Save as", user);
            expect(screen.getByRole("menuitem", { name: /^Save as PDF/ })).toHaveTextContent("Unlock this message to print it");
            // Its source can still be saved.
            expect(screen.getByRole("menuitem", { name: /^Save as \.eml/ })).toBeEnabled();
        });

        it("says Save as PDF opens the print dialog", async () => {
            const { user } = await open({});
            await submenu("Save as", user);
            expect(screen.getByRole("menuitem", { name: /^Save as PDF/ })).toHaveTextContent("Opens the print dialog: choose Save as PDF");
            expect(screen.getByRole("menuitem", { name: /^Save as PDF/ })).toBeEnabled();
        });

        it("holds Reply all and Forward while the compose window is opening", async () => {
            const { user } = await open({ composing: true });
            await submenu("Other reply actions", user);
            expect(screen.getByRole("menuitem", { name: /^Reply all/ })).toBeDisabled();
            expect(screen.getByRole("menuitem", { name: /^Forward/ })).toHaveTextContent("Opening the compose window");
        });
    });
});

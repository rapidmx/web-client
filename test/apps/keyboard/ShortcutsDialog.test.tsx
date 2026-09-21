///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalShortcuts } from "../../../apps/shared/keyboard/GlobalShortcuts.js";
import { SHORTCUTS } from "../../../apps/shared/keyboard/keymap.js";
import { ShortcutProvider } from "../../../apps/shared/keyboard/ShortcutProvider.js";
import ShortcutsDialog from "../../../apps/shared/keyboard/ShortcutsDialog.js";
import { useShortcut } from "../../../apps/shared/keyboard/useShortcut.js";
import { useShortcutProps } from "../../../apps/shared/keyboard/useShortcutProps.js";

function press(key: string, init: KeyboardEventInit = {}, target: Element = document.body): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    act(() => {
        target.dispatchEvent(event);
    });
    return event;
}

function Mail() {
    useShortcut(SHORTCUTS.mail.reply, () => undefined);
    useShortcut(SHORTCUTS.mail.delete, () => undefined);
    useShortcut(SHORTCUTS.mail.create, () => undefined);
    return null;
}

function Compose() {
    useShortcut(SHORTCUTS.compose.send, () => undefined, { scope: "compose" });
    return null;
}

function Harness({ children, authServerUrl }: { children?: React.ReactNode; authServerUrl?: string }) {
    const [open, setOpen] = useState(false);
    return (
        <ShortcutProvider>
            <GlobalShortcuts authServerUrl={authServerUrl} onToggleHelp={() => setOpen((o) => !o)} />
            <ShortcutsDialog open={open} onClose={() => setOpen(false)} />
            <button>opener</button>
            {children}
        </ShortcutProvider>
    );
}

afterEach(() => {
    delete (window as { rapidmx?: unknown }).rapidmx;
    vi.restoreAllMocks();
});

describe("ShortcutsDialog", () => {
    it("renders nothing while closed", () => {
        render(<Harness />);
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("opens on ? and on Ctrl+/, as an accessible modal with a name, and closes on Escape", () => {
        render(<Harness />);
        press("?", { shiftKey: true });
        const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
        expect(dialog).toHaveAttribute("aria-modal", "true");
        press("Escape", {}, dialog);
        expect(screen.queryByRole("dialog")).toBeNull();
        press("/", { ctrlKey: true });
        expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    });

    it("moves focus into the dialog and gives it back to what had it", () => {
        render(<Harness />);
        const opener = screen.getByText("opener");
        opener.focus();
        press("/", { ctrlKey: true });
        expect(screen.getByRole("dialog")).toHaveFocus();
        press("Escape", {}, screen.getByRole("dialog"));
        expect(opener).toHaveFocus();
    });

    it("closes on ? and Ctrl+/ again, and silences every other shortcut while it is open", () => {
        render(<Harness />);
        press("?", { shiftKey: true });
        expect(press("M", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
        press("?", { shiftKey: true });
        expect(screen.queryByRole("dialog")).toBeNull();
        press("/", { ctrlKey: true });
        press("/", { ctrlKey: true });
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("closes from its own close button", () => {
        render(<Harness />);
        press("?", { shiftKey: true });
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("lists only the global shortcuts where the view has none of its own - and Account only with an auth-server", () => {
        const { unmount } = render(<Harness />);
        press("?", { shiftKey: true });
        let dialog = screen.getByRole("dialog");
        expect(within(dialog).getByRole("heading", { name: "Global" })).toBeInTheDocument();
        expect(within(dialog).queryByRole("heading", { name: "Mail" })).toBeNull();
        expect(within(dialog).queryByRole("heading", { name: "Compose" })).toBeNull();
        expect(within(dialog).getByText("Go to Mail")).toBeInTheDocument();
        expect(within(dialog).getByText("Go to Settings")).toBeInTheDocument();
        expect(within(dialog).queryByText("Go to Account")).toBeNull();
        unmount();

        render(<Harness authServerUrl="https://auth.example.com" />);
        press("?", { shiftKey: true });
        dialog = screen.getByRole("dialog");
        expect(within(dialog).getByText("Go to Account")).toBeInTheDocument();
        expect(within(dialog).getByText("Ctrl+Shift+A")).toBeInTheDocument();
    });

    it("lists the view's shortcuts in groups, in the map's order, and follows the view as it mounts and unmounts", () => {
        const { rerender } = render(
            <Harness>
                <Mail />
            </Harness>,
        );
        press("?", { shiftKey: true });
        const dialog = screen.getByRole("dialog");
        const headings = within(dialog).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
        expect(headings).toEqual(["Global", "Mail"]);
        const mail = within(dialog).getByRole("region", { name: "Mail" });
        expect(within(mail).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
            "New messageAlt+N",
            "ReplyCtrl+R",
            "DeleteCtrl+DorDelete",
        ]);
        rerender(
            <Harness>
                <Mail />
                <Compose />
            </Harness>,
        );
        expect(within(screen.getByRole("dialog")).getByRole("heading", { name: "Compose" })).toBeInTheDocument();
        expect(within(screen.getByRole("dialog")).getByText("Send")).toBeInTheDocument();
        expect(within(screen.getByRole("dialog")).getByText("Ctrl+Enter")).toBeInTheDocument();
        rerender(<Harness />);
        expect(within(screen.getByRole("dialog")).queryByRole("heading", { name: "Mail" })).toBeNull();
        expect(within(screen.getByRole("dialog")).queryByRole("heading", { name: "Compose" })).toBeNull();
    });

    it("lists a shortcut once however many components claim it, and never the dialog scope", () => {
        render(
            <Harness>
                <Mail />
                <Mail />
            </Harness>,
        );
        press("?", { shiftKey: true });
        expect(screen.getAllByText("Reply")).toHaveLength(1);
        expect(screen.queryByRole("heading", { name: "Dialog" })).toBeNull();
        // "Keyboard shortcuts" is the dialog's own title and the global shortcut that opens it.
        expect(screen.getAllByText("Keyboard shortcuts").length).toBeGreaterThanOrEqual(1);
    });

    it("uses the platform's own key names: Cmd and Option on a Mac", () => {
        vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
        render(
            <Harness>
                <Mail />
            </Harness>,
        );
        press("?", { shiftKey: true });
        const dialog = screen.getByRole("dialog");
        expect(within(dialog).getByText("⌘R")).toBeInTheDocument();
        expect(within(dialog).getByText("⌥N")).toBeInTheDocument();
        expect(within(dialog).getByText("⌘D")).toBeInTheDocument();
        expect(within(dialog).getByText("⌃⇧M")).toBeInTheDocument();
    });

    it("shows the keys only the desktop client has, alongside the others", () => {
        (window as { rapidmx?: unknown }).rapidmx = {};
        render(
            <Harness>
                <Mail />
            </Harness>,
        );
        press("?", { shiftKey: true });
        const dialog = screen.getByRole("dialog");
        const tasks = within(dialog).getByText("Go to Tasks").closest("li")!;
        expect(tasks).toHaveTextContent("Ctrl+Shift+LorCtrl+Shift+T");
        const create = within(dialog).getByText("New message").closest("li")!;
        expect(create).toHaveTextContent("Alt+NorCtrl+N");
    });

    it("tells that some browsers keep a few keys for themselves", () => {
        render(<Harness />);
        press("?", { shiftKey: true });
        expect(screen.getByText(/Some browsers keep a few keys for themselves/)).toBeInTheDocument();
    });
});

describe("useShortcutProps", () => {
    function Probe({ active }: { active?: boolean }) {
        const props = useShortcutProps("Reply", SHORTCUTS.mail.reply, active);
        return <button {...props}>Reply</button>;
    }

    it("names the shortcut in the tooltip and aria-keyshortcuts, and leaves the accessible name alone", () => {
        render(
            <ShortcutProvider>
                <Probe />
            </ShortcutProvider>,
        );
        const button = screen.getByRole("button", { name: "Reply" });
        expect(button).toHaveAttribute("title", "Reply (Ctrl+R)");
        expect(button).toHaveAttribute("aria-keyshortcuts", "Control+R");
    });

    it("follows the platform after mount", () => {
        vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
        render(
            <ShortcutProvider>
                <Probe />
            </ShortcutProvider>,
        );
        const button = screen.getByRole("button", { name: "Reply" });
        expect(button).toHaveAttribute("title", "Reply (⌘R)");
        expect(button).toHaveAttribute("aria-keyshortcuts", "Meta+R");
    });

    it("is only the plain label when the shortcut is not active", () => {
        render(
            <ShortcutProvider>
                <Probe active={false} />
            </ShortcutProvider>,
        );
        const button = screen.getByRole("button", { name: "Reply" });
        expect(button).toHaveAttribute("title", "Reply");
        expect(button).not.toHaveAttribute("aria-keyshortcuts");
    });

    it("uses the server environment outside a provider", () => {
        render(<Probe />);
        expect(screen.getByRole("button", { name: "Reply" })).toHaveAttribute("title", "Reply (Ctrl+R)");
    });
});

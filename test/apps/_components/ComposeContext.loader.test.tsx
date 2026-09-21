// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The compose window is a chunk of its own, loaded on demand or ahead of time (`prefetchComposeWindow()`). The loader keeps its
// state for the life of the module, so each test gets a fresh copy of `ComposeContext` and a stand-in `ComposeWindow` whose
// "download" the test controls.
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const download = vi.hoisted(() => ({ loads: 0, failures: 0, gate: undefined as Promise<void> | undefined }));

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

beforeEach(() => {
    vi.resetModules();
    download.loads = 0;
    download.failures = 0;
    download.gate = undefined;
    vi.doMock("../../../apps/shared/components/mail/compose/ComposeWindow.js", async () => {
        download.loads++;
        if (download.gate) {
            await download.gate;
        }
        if (download.failures > 0) {
            download.failures--;
            throw new Error("chunk failed");
        }
        return { default: ({ session }: any) => <p data-testid="real-window">window for {session.initialTo}</p> };
    });
});

afterEach(() => {
    vi.doUnmock("../../../apps/shared/components/mail/compose/ComposeWindow.js");
});

async function setup() {
    const context = await import("../../../apps/shared/components/mail/compose/ComposeContext.js");
    function Opener() {
        const { openCompose } = context.useCompose();
        return (
            <button type="button" onClick={() => openCompose({ mailboxUid: "mb1", to: "jane@example.com" })}>
                Open
            </button>
        );
    }
    render(
        <context.default>
            <Opener />
        </context.default>,
    );
    return context;
}

describe("the compose window's code, and what stands in for it", () => {
    it("shows the window's frame at once, with what is already known, while its code is still loading", async () => {
        const user = userEvent.setup();
        const gate = deferred();
        download.gate = gate.promise;
        await setup();
        await user.click(screen.getByRole("button", { name: "Open" }));

        const dialog = await screen.findByRole("dialog", { name: "New Message" });
        expect(dialog).toHaveAttribute("aria-busy", "true");
        expect(dialog).toHaveTextContent("jane@example.com");
        expect(screen.queryByTestId("real-window")).not.toBeInTheDocument();

        gate.resolve();
        expect(await screen.findByTestId("real-window")).toBeInTheDocument();
        expect(screen.queryByText("Opening the compose window")).not.toBeInTheDocument();
    });

    it("goes straight to the window when its code was fetched ahead of the click, downloading it once", async () => {
        const user = userEvent.setup();
        const { prefetchComposeWindow } = await import("../../../apps/shared/components/mail/compose/ComposeContext.js");
        prefetchComposeWindow();
        prefetchComposeWindow();
        await waitFor(() => expect(download.loads).toBe(1));
        await setup();
        await act(async () => undefined);
        await user.click(screen.getByRole("button", { name: "Open" }));
        expect(screen.queryByText("Opening the compose window")).not.toBeInTheDocument();
        expect(await screen.findByTestId("real-window")).toBeInTheDocument();
        expect(download.loads).toBe(1);
    });

    it("says the code couldn't be loaded, and tries again on Retry", async () => {
        const user = userEvent.setup();
        download.failures = 1;
        await setup();
        await user.click(screen.getByRole("button", { name: "Open" }));
        expect(await screen.findByText(/couldn.t be loaded/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Retry" }));
        expect(await screen.findByTestId("real-window")).toBeInTheDocument();
        expect(download.loads).toBe(2);
    });

    it("never rejects from a prefetch that fails, and lets a later attempt try again", async () => {
        download.failures = 1;
        const { prefetchComposeWindow } = await import("../../../apps/shared/components/mail/compose/ComposeContext.js");
        expect(() => prefetchComposeWindow()).not.toThrow();
        await waitFor(() => expect(download.loads).toBe(1));
        await act(async () => undefined);
        prefetchComposeWindow();
        await waitFor(() => expect(download.loads).toBe(2));
    });

    it("lets the placeholder be minimized and closed while the code is still loading", async () => {
        const user = userEvent.setup();
        const gate = deferred();
        download.gate = gate.promise;
        await setup();
        await user.click(screen.getByRole("button", { name: "Open" }));
        await screen.findByRole("dialog", { name: "New Message" });

        await user.click(screen.getByRole("button", { name: "Minimize" }));
        // Minimized, it is the small chip: no Minimize button of its own.
        await waitFor(() => expect(screen.queryByRole("button", { name: "Minimize" })).not.toBeInTheDocument());
        await user.click(screen.getByText("New Message"));
        expect(await screen.findByRole("button", { name: "Minimize" })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Close" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        gate.resolve();
    });

    it.each([
        ["arrives", 0],
        ["fails to arrive", 1],
    ])("does nothing when the page goes away before the code %s", async (_name, failures) => {
        const gate = deferred();
        download.gate = gate.promise;
        download.failures = failures;
        const user = userEvent.setup();
        const context = await import("../../../apps/shared/components/mail/compose/ComposeContext.js");
        function Opener() {
            const { openCompose } = context.useCompose();
            return (
                <button type="button" onClick={() => openCompose({ mailboxUid: "mb1" })}>
                    Open
                </button>
            );
        }
        const first = render(
            <context.default>
                <Opener />
            </context.default>,
        );
        await user.click(screen.getByRole("button", { name: "Open" }));
        await screen.findByRole("dialog");
        first.unmount();
        gate.resolve();
        await act(async () => undefined);
    });

    it("forgets what it loaded on request, as a fresh page load would", async () => {
        const { prefetchComposeWindow, resetComposeWindowLoader } = await import("../../../apps/shared/components/mail/compose/ComposeContext.js");
        prefetchComposeWindow();
        await waitFor(() => expect(download.loads).toBe(1));
        // The module registry keeps the stand-in itself, so a second download of it is served from there.
        resetComposeWindowLoader();
        prefetchComposeWindow();
        await act(async () => undefined);
        expect(download.loads).toBe(1);
    });
});

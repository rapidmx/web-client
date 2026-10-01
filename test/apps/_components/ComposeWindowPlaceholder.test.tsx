// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockMatchMedia } from "../testUtils.js";
import ComposeWindowPlaceholder from "../../../apps/shared/components/mail/compose/ComposeWindowPlaceholder.js";
import type { ComposeSession } from "../../../apps/shared/components/mail/compose/ComposeContext.js";

const perf = vi.hoisted(() => ({ markComposePhase: vi.fn() }));
vi.mock("../../../apps/shared/components/mail/compose/composePerf.js", () => perf);

function renderPlaceholder(session: Partial<ComposeSession> = {}, props: { failed?: boolean; inline?: boolean } = {}) {
    const handlers = { onRetry: vi.fn(), onClose: vi.fn(), onToggleMinimize: vi.fn(), onPopOut: vi.fn() };
    const utils = render(
        <ComposeWindowPlaceholder session={{ id: "s1", signatureContext: "new", minimized: false, ...session }} failed={!!props.failed} inline={props.inline} {...handlers} />,
    );
    return { ...utils, ...handlers };
}

afterEach(() => {
    vi.unstubAllGlobals();
    perf.markComposePhase.mockClear();
});

describe("ComposeWindowPlaceholder", () => {
    describe("inline, as a card in the reading pane", () => {
        it("is a full-width region with Pop out and Close, and no Minimize", async () => {
            const user = userEvent.setup();
            const { onClose, onPopOut, onToggleMinimize } = renderPlaceholder({ initialSubject: "Re: Hi" }, { inline: true });
            const region = screen.getByRole("region", { name: "Re: Hi" });
            expect(region.className).toContain("w-full");
            expect(region.className).not.toContain("fixed");
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Minimize" })).not.toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: "Pop out" }));
            expect(onPopOut).toHaveBeenCalledTimes(1);
            await user.click(screen.getByRole("button", { name: "Close" }));
            expect(onClose).toHaveBeenCalledTimes(1);
            // The header does nothing when clicked.
            await user.click(screen.getAllByText("Re: Hi")[0]);
            expect(onToggleMinimize).not.toHaveBeenCalled();
        });

        it("is not fullscreen on mobile and is not a minimized chip even if the session is minimized", () => {
            mockMatchMedia(true);
            renderPlaceholder({ minimized: true }, { inline: true });
            const region = screen.getByRole("region");
            expect(region.className).not.toContain("fixed");
            expect(screen.getByRole("button", { name: "Pop out" })).toBeInTheDocument();
        });
    });

    it("shows the window's frame with what it will open with, as a busy dialog titled by the subject", () => {
        renderPlaceholder({ initialTo: "sender@example.com", initialSubject: "Re: Hi" });
        const dialog = screen.getByRole("dialog", { name: "Re: Hi" });
        expect(dialog).toHaveAttribute("aria-busy", "true");
        expect(dialog).toHaveTextContent("sender@example.com");
        expect(screen.getByRole("status")).toHaveTextContent("Opening the compose window");
    });

    it("is titled New Message and offers the Subject placeholder when there is no subject", () => {
        renderPlaceholder({});
        expect(screen.getByRole("dialog", { name: "New Message" })).toBeInTheDocument();
        expect(screen.getByText("Subject")).toBeInTheDocument();
    });

    it("marks the shell phase for the performance timeline", () => {
        renderPlaceholder({ id: "abc" });
        expect(perf.markComposePhase).toHaveBeenCalledWith("abc", "shell");
    });

    it("minimizes and closes from its header, without asking about a draft that doesn't exist yet", async () => {
        const user = userEvent.setup();
        const { onClose, onToggleMinimize } = renderPlaceholder({});
        await user.click(screen.getByRole("button", { name: "Minimize" }));
        expect(onToggleMinimize).toHaveBeenCalledTimes(1);
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onToggleMinimize).toHaveBeenCalledTimes(1);
    });

    it("minimizes when the header is clicked", async () => {
        const user = userEvent.setup();
        const { onToggleMinimize } = renderPlaceholder({ initialSubject: "Hi" });
        await user.click(screen.getByText("Hi", { selector: "span#compose-title-s1" }));
        expect(onToggleMinimize).toHaveBeenCalledTimes(1);
    });

    it("is the small chip a minimized window is, restoring on click", async () => {
        const user = userEvent.setup();
        const { onToggleMinimize } = renderPlaceholder({ minimized: true, initialSubject: "Hi" });
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        await user.click(screen.getByText("Hi"));
        expect(onToggleMinimize).toHaveBeenCalledTimes(1);
    });

    it("fills the screen on a phone", () => {
        mockMatchMedia(true);
        renderPlaceholder({});
        expect(screen.getByRole("dialog")).toHaveClass("fixed", "inset-0");
    });

    it("says the code couldn't be loaded, and offers Retry instead of the busy state", async () => {
        const user = userEvent.setup();
        const { onRetry } = renderPlaceholder({}, { failed: true });
        expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "false");
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(screen.getByText(/couldn.t be loaded/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Retry" }));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });
});

// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockLocation } from "../testUtils.js";

// `React.lazy()` keeps its result for the life of the module, so each test loads a fresh copy of the module under test.
const loads = vi.hoisted(() => ({ detail: 0, thread: 0, fail: false, gate: undefined as Promise<void> | undefined }));

beforeEach(() => {
    vi.resetModules();
    loads.detail = 0;
    loads.thread = 0;
    loads.fail = false;
    loads.gate = undefined;
    vi.doMock("../../../apps/shared/components/mail/MessageDetailPane.js", async () => {
        loads.detail++;
        await loads.gate;
        if (loads.fail) {
            throw new Error("chunk failed");
        }
        return { default: ({ message }: any) => <p>detail pane for {message.subject}</p> };
    });
    vi.doMock("../../../apps/shared/components/mail/ConversationThreadPane.js", () => {
        loads.thread++;
        if (loads.fail) {
            throw new Error("chunk failed");
        }
        return { default: ({ conversation }: any) => <p>thread pane for {conversation.conversationId}</p> };
    });
});

afterEach(() => {
    vi.doUnmock("../../../apps/shared/components/mail/MessageDetailPane.js");
    vi.doUnmock("../../../apps/shared/components/mail/ConversationThreadPane.js");
});

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

const load = () => import("../../../apps/shared/components/mail/LazyReadingPane.js");

describe("LazyMessageDetailPane", () => {
    it("shows the empty state without loading the pane's code when no message is selected", async () => {
        const { LazyMessageDetailPane } = await load();
        render(<LazyMessageDetailPane {...({ message: null } as any)} />);
        expect(screen.getByText("Select a message to read it.")).toBeInTheDocument();
        expect(loads.detail).toBe(0);
    });

    it("shows a skeleton while the pane's code loads, then the pane", async () => {
        const { LazyMessageDetailPane } = await load();
        render(<LazyMessageDetailPane {...({ message: { subject: "Hello" } } as any)} />);
        expect(screen.getByRole("status")).toHaveTextContent("Loading the message");
        expect(await screen.findByText("detail pane for Hello")).toBeInTheDocument();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("renders a pane whose code is already loaded on the very first render, with no skeleton in between", async () => {
        const { LazyMessageDetailPane, prefetchReadingPane } = await load();
        prefetchReadingPane();
        await waitFor(() => expect(loads.detail).toBe(1));
        await act(async () => undefined);
        render(<LazyMessageDetailPane {...({ message: { subject: "Hello" } } as any)} />);
        expect(screen.getByText("detail pane for Hello")).toBeInTheDocument();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("does nothing when it is gone before the code arrives - or fails to", async () => {
        const gate = deferred();
        loads.gate = gate.promise;
        const { LazyMessageDetailPane } = await load();
        const first = render(<LazyMessageDetailPane {...({ message: { subject: "Hello" } } as any)} />);
        first.unmount();
        loads.fail = true;
        gate.resolve();
        await act(async () => undefined);
        const second = render(<LazyMessageDetailPane {...({ message: { subject: "Hello" } } as any)} />);
        second.unmount();
        await act(async () => undefined);
    });

    it("says so, with a way out, when the pane's code can't be loaded", async () => {
        loads.fail = true;
        const location = mockLocation();
        const user = userEvent.setup();
        const { LazyMessageDetailPane } = await load();
        render(<LazyMessageDetailPane {...({ message: { subject: "Hello" } } as any)} />);
        expect(await screen.findByText(/couldn.t be loaded/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Reload" }));
        expect(location.reload).toHaveBeenCalledTimes(1);
    });
});

describe("LazyConversationThreadPane", () => {
    it("shows the empty state without loading the pane's code when no conversation is open", async () => {
        const { LazyConversationThreadPane } = await load();
        render(<LazyConversationThreadPane {...({ conversation: null } as any)} />);
        expect(screen.getByText("Select a conversation to read it.")).toBeInTheDocument();
        expect(loads.thread).toBe(0);
    });

    it("loads the thread pane once a conversation is open", async () => {
        const { LazyConversationThreadPane } = await load();
        render(<LazyConversationThreadPane {...({ conversation: { conversationId: "c1" } } as any)} />);
        expect(await screen.findByText("thread pane for c1")).toBeInTheDocument();
    });

    it("says so when the thread pane's code can't be loaded", async () => {
        loads.fail = true;
        const { LazyConversationThreadPane } = await load();
        render(<LazyConversationThreadPane {...({ conversation: { conversationId: "c1" } } as any)} />);
        expect(await screen.findByText(/couldn.t be loaded/)).toBeInTheDocument();
    });
});

describe("prefetchReadingPane", () => {
    it("starts loading both panes' code without showing anything", async () => {
        const { prefetchReadingPane } = await load();
        prefetchReadingPane();
        await waitFor(() => expect(loads.detail).toBe(1));
        expect(loads.thread).toBe(1);
    });

    it("never rejects when the code can't be loaded", async () => {
        loads.fail = true;
        const { prefetchReadingPane } = await load();
        expect(() => prefetchReadingPane()).not.toThrow();
        await waitFor(() => expect(loads.detail).toBe(1));
    });
});

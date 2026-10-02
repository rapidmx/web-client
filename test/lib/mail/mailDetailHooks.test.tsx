// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { useMarkMessageRead, useMessageAttachments } from "../../../lib/mail/mailDetailHooks.js";
import type { Message } from "../../../lib/mail/mailApi.js";

function messageFixture(overrides: Record<string, unknown> = {}): Message {
    return {
        uid: "m1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        messageId: "abc@example.com",
        subject: "Hello there",
        from: { address: "sender@example.com", type: "to" },
        recipients: [],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: "2026-01-01T00:00:00.000Z",
        bodyPreview: "",
        flags: { read: false, flagged: false, answered: false, forwarded: false },
        importance: "normal",
        hasAttachments: false,
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

function AttachmentsHarness({ message }: { message: Message | null }) {
    const attachments = useMessageAttachments(message);
    return <span data-testid="count">{attachments.length}</span>;
}

describe("useMessageAttachments", () => {
    it("returns an empty array when there is no message", () => {
        render(<AttachmentsHarness message={null} />);
        expect(screen.getByTestId("count")).toHaveTextContent("0");
    });

    it("returns an empty array without fetching when the message has no attachments", () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        render(<AttachmentsHarness message={messageFixture({ hasAttachments: false })} />);
        expect(screen.getByTestId("count")).toHaveTextContent("0");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fetches and returns attachments when the message has some", async () => {
        mockFetch((url) =>
            url.startsWith("/api/mail/attachments") ? jsonResponse(200, [{ uid: "a1" }, { uid: "a2" }]) : jsonResponse(404, {}),
        );
        render(<AttachmentsHarness message={messageFixture({ hasAttachments: true })} />);
        await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));
    });

    it("swallows a failed attachment fetch and returns an empty array", async () => {
        mockFetch(() => jsonResponse(500, { message: "boom" }));
        render(<AttachmentsHarness message={messageFixture({ hasAttachments: true })} />);
        await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));
    });

    it("re-fetches when the message changes", async () => {
        mockFetch((url) =>
            url.startsWith("/api/mail/attachments") ? jsonResponse(200, [{ uid: "a1" }]) : jsonResponse(404, {}),
        );
        const { rerender } = render(<AttachmentsHarness message={messageFixture({ uid: "m1", hasAttachments: true })} />);
        await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));

        rerender(<AttachmentsHarness message={messageFixture({ uid: "m2", hasAttachments: false })} />);
        expect(screen.getByTestId("count")).toHaveTextContent("0");
    });

    it("does not re-fetch when only unrelated fields change on a new message object with the same uid/hasAttachments", async () => {
        const fetchMock = mockFetch((url) =>
            url.startsWith("/api/mail/attachments") ? jsonResponse(200, [{ uid: "a1" }]) : jsonResponse(404, {}),
        );
        const { rerender } = render(<AttachmentsHarness message={messageFixture({ uid: "m1", hasAttachments: true })} />);
        await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // A new object reference (e.g. `useMarkMessageRead`'s `onUpdated(updated)`) with the same uid/hasAttachments
        // but a metadata-only patch — must not trigger another fetch.
        rerender(
            <AttachmentsHarness
                message={messageFixture({ uid: "m1", hasAttachments: true, flags: { read: true, flagged: false, answered: false, forwarded: false } })}
            />,
        );
        expect(screen.getByTestId("count")).toHaveTextContent("1");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("re-fetches when only folderUid changes (a move/archive), even with the same uid/hasAttachments", async () => {
        const fetchMock = mockFetch((url) =>
            url.startsWith("/api/mail/attachments") ? jsonResponse(200, [{ uid: "a1" }]) : jsonResponse(404, {}),
        );
        const { rerender } = render(<AttachmentsHarness message={messageFixture({ uid: "m1", folderUid: "inbox", hasAttachments: true })} />);
        await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toContain("folderUid=inbox");

        // Same shape a `moveMessage()`/`archiveMessage()` result has: a new object reference, same uid/hasAttachments,
        // only folderUid changed — must still re-fetch, against the new folder, or a stale fetch would be stuck
        // pointed at the message's old folder after the move.
        rerender(<AttachmentsHarness message={messageFixture({ uid: "m1", folderUid: "archive", hasAttachments: true })} />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(fetchMock.mock.calls[1][0]).toContain("folderUid=archive");
    });
});

function MarkReadHarness({ message }: { message: Message | null }) {
    const [current, setCurrent] = React.useState(message);
    useMarkMessageRead(current, setCurrent);
    return <span data-testid="read">{String(current?.flags.read)}</span>;
}

describe("useMarkMessageRead", () => {
    it("does nothing when there is no message", () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        render(<MarkReadHarness message={null} />);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does nothing when the message is already read", () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        render(<MarkReadHarness message={messageFixture({ flags: { read: true, flagged: false, answered: false, forwarded: false } })} />);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("marks an unread message as read and calls onUpdated with the server's copy", async () => {
        const fetchMock = mockFetch((url, init) => {
            if (url === "/api/mail/messages/m1" && init?.method === "PUT") {
                return jsonResponse(200, messageFixture({ flags: { read: true, flagged: false, answered: false, forwarded: false } }));
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        render(<MarkReadHarness message={messageFixture()} />);

        await waitFor(() => expect(screen.getByTestId("read")).toHaveTextContent("true"));
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1", expect.objectContaining({ method: "PUT" }));
    });

    it("swallows a failed mark-as-read update", async () => {
        mockFetch(() => jsonResponse(500, { message: "boom" }));
        render(<MarkReadHarness message={messageFixture()} />);

        // No assertion target other than "doesn't throw" — `current` simply never updates from its
        // initial unread value, proving the rejection was swallowed rather than propagated.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.getByTestId("read")).toHaveTextContent("false");
    });

    it("does not call onUpdated after unmount, even if the request resolves later", async () => {
        let resolveRequest: (() => void) | undefined;
        mockFetch(
            () =>
                new Promise((resolve) => {
                    resolveRequest = () => resolve(jsonResponse(200, messageFixture({ flags: { read: true, flagged: false, answered: false, forwarded: false } })));
                }),
        );
        const { unmount } = render(<MarkReadHarness message={messageFixture()} />);
        await waitFor(() => expect(resolveRequest).toBeDefined());

        unmount();
        resolveRequest!();

        // Nothing to assert against a torn-down tree beyond "resolving after unmount doesn't throw" —
        // the `cancelled` guard inside the hook is what prevents a React state update on an unmounted
        // component here.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
});

describe("stale responses and re-renders", () => {
    const READ = { read: true, flagged: false, answered: false, forwarded: false };

    it("keeps the attachments of the message now shown when an earlier message's list arrives late", async () => {
        const resolvers: Record<string, () => void> = {};
        mockFetch(
            (url) =>
                new Promise((resolve) => {
                    const uid = url.includes("messageUid=m1") ? "m1" : "m2";
                    resolvers[uid] = () => resolve(jsonResponse(200, uid === "m1" ? [{ uid: "a1" }, { uid: "a2" }, { uid: "a3" }] : [{ uid: "b1" }]));
                }),
        );
        const { rerender } = render(<AttachmentsHarness message={messageFixture({ uid: "m1", hasAttachments: true })} />);
        rerender(<AttachmentsHarness message={messageFixture({ uid: "m2", hasAttachments: true })} />);
        await waitFor(() => expect(resolvers.m2).toBeDefined());

        resolvers.m2();
        await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
        resolvers.m1();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.getByTestId("count")).toHaveTextContent("1");
    });

    it("does not let an earlier message's failed fetch blank the attachments of the one now shown", async () => {
        const resolvers: Record<string, () => void> = {};
        mockFetch(
            (url) =>
                new Promise((resolve) => {
                    const uid = url.includes("messageUid=m1") ? "m1" : "m2";
                    resolvers[uid] = () => resolve(uid === "m1" ? jsonResponse(500, { message: "boom" }) : jsonResponse(200, [{ uid: "b1" }]));
                }),
        );
        const { rerender } = render(<AttachmentsHarness message={messageFixture({ uid: "m1", hasAttachments: true })} />);
        rerender(<AttachmentsHarness message={messageFixture({ uid: "m2", hasAttachments: true })} />);
        await waitFor(() => expect(resolvers.m2).toBeDefined());
        resolvers.m2();
        await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
        resolvers.m1();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.getByTestId("count")).toHaveTextContent("1");
    });

    it("sends one mark-as-read request, and still applies its answer, when a metadata patch swaps the message object meanwhile", async () => {
        let resolveRequest: (() => void) | undefined;
        const fetchMock = mockFetch(
            () =>
                new Promise((resolve) => {
                    resolveRequest = () => resolve(jsonResponse(200, messageFixture({ version: 1, flags: READ })));
                }),
        );
        const onUpdated = vi.fn();
        function Harness({ message }: { message: Message }) {
            useMarkMessageRead(message, onUpdated);
            return null;
        }
        const { rerender } = render(<Harness message={messageFixture()} />);
        await waitFor(() => expect(resolveRequest).toBeDefined());

        rerender(<Harness message={messageFixture({ flags: { read: false, flagged: true, answered: false, forwarded: false } })} />);
        resolveRequest!();
        await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

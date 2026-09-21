// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMarkMessageRead } from "../../../apps/shared/mail/useMarkMessageRead.js";

const { setMessageRead } = vi.hoisted(() => ({ setMessageRead: vi.fn() }));
vi.mock("@rapidmx/react-shared/mail/mailApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/mail/mailApi.js")>()),
    setMessageRead,
}));

const message = (uid: string, read: boolean | undefined, version = 1) =>
    ({ uid, version, folderUid: "f1", mailboxUid: "mb1", flags: read === undefined ? {} : { read } }) as any;

beforeEach(() => {
    setMessageRead.mockReset();
});

describe("useMarkMessageRead", () => {
    it("marks an unread message read as it is opened: the optimistic copy first, the server's after", async () => {
        setMessageRead.mockResolvedValue(message("m1", true, 2));
        const onPatched = vi.fn();
        const { rerender } = renderHook(({ current }) => useMarkMessageRead(current, onPatched), { initialProps: { current: message("m1", false) } });

        expect(onPatched).toHaveBeenNthCalledWith(1, expect.objectContaining({ uid: "m1", flags: { read: true } }), expect.objectContaining({ flags: { read: false } }));
        await waitFor(() => expect(onPatched).toHaveBeenNthCalledWith(2, expect.objectContaining({ version: 2 }), undefined));

        // Being handed the optimistic copy back (the caller's list now holds it) asks for nothing more.
        rerender({ current: message("m1", true) });
        expect(setMessageRead).toHaveBeenCalledTimes(1);
    });

    it("does nothing for a read message, or none at all", () => {
        const onPatched = vi.fn();
        const { rerender } = renderHook(({ current }) => useMarkMessageRead(current, onPatched), { initialProps: { current: null } });
        rerender({ current: message("m1", true) });
        expect(setMessageRead).not.toHaveBeenCalled();
        expect(onPatched).not.toHaveBeenCalled();
    });

    it("counts a message that was already read as asked about: marking it unread while it stays open (Ctrl+U) is not undone", () => {
        const onPatched = vi.fn();
        const { rerender } = renderHook(({ current }) => useMarkMessageRead(current, onPatched), { initialProps: { current: message("m1", true) } });

        rerender({ current: message("m1", false, 2) });
        expect(setMessageRead).not.toHaveBeenCalled();
        expect(onPatched).not.toHaveBeenCalled();

        // Opened again later, it is read as any unread message is.
        setMessageRead.mockResolvedValue(message("m1", true, 3));
        rerender({ current: null });
        rerender({ current: message("m1", false, 2) });
        expect(setMessageRead).toHaveBeenCalledTimes(1);
    });

    it("asks once per opening: a message marked unread while it stays open is left unread, and read again when reopened", async () => {
        setMessageRead.mockResolvedValue(message("m1", true, 2));
        const onPatched = vi.fn();
        const { rerender } = renderHook(({ current }) => useMarkMessageRead(current, onPatched), { initialProps: { current: message("m1", false) } });
        await waitFor(() => expect(onPatched).toHaveBeenCalledTimes(2));

        rerender({ current: message("m1", false, 3) });
        expect(setMessageRead).toHaveBeenCalledTimes(1);

        rerender({ current: null });
        rerender({ current: message("m1", false, 3) });
        expect(setMessageRead).toHaveBeenCalledTimes(2);
    });

    it("does not retry a failed request in a loop: undoing it changes the message, but only reopening asks again", async () => {
        setMessageRead.mockRejectedValue(new Error("409"));
        const onPatched = vi.fn();
        const original = message("m1", false);
        const { rerender } = renderHook(({ current }) => useMarkMessageRead(current, onPatched), { initialProps: { current: original } });
        // The optimistic copy, then the undo.
        await waitFor(() => expect(onPatched).toHaveBeenCalledTimes(2));
        expect(onPatched).toHaveBeenLastCalledWith(original, expect.objectContaining({ flags: { read: true } }));

        rerender({ current: original });
        rerender({ current: message("m1", false, 1) });
        expect(setMessageRead).toHaveBeenCalledTimes(1);

        rerender({ current: message("m2", false) });
        await waitFor(() => expect(setMessageRead).toHaveBeenCalledTimes(2));
    });
});

// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { openSealedRecord } = vi.hoisted(() => ({ openSealedRecord: vi.fn() }));
vi.mock("../../../lib/zeroAccess/sealedRecords.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/zeroAccess/sealedRecords.js")>()),
    openSealedRecord,
}));

const { keyListeners } = vi.hoisted(() => ({ keyListeners: new Set<(event: { mailboxUid: string; state: "locked" | "unlocked" }) => void>() }));
vi.mock("../../../lib/crypto/keySession.js", () => ({
    subscribeKeySession: (listener: (event: { mailboxUid: string; state: "locked" | "unlocked" }) => void) => {
        keyListeners.add(listener);
        return () => keyListeners.delete(listener);
    },
}));
const emit = (mailboxUid: string, state: "locked" | "unlocked") => act(() => keyListeners.forEach((listener) => listener({ mailboxUid, state })));

const { useOpenedRecord } = await import("../../../apps/shared/zeroAccess/useOpenedRecord.js");

afterEach(() => {
    openSealedRecord.mockReset();
});

describe("useOpenedRecord", () => {
    it("hands back a record without protected fields, or none, at once", () => {
        const plain = { mailboxUid: "mb", name: "Plain" };
        expect(renderHook(() => useOpenedRecord(plain)).result.current).toEqual({ record: plain, ready: true });
        expect(renderHook(() => useOpenedRecord(undefined)).result.current).toEqual({ record: undefined, ready: true });
        expect(openSealedRecord).not.toHaveBeenCalled();
    });

    it("opens a protected record, showing the given one until it has, and opens a new one when it changes", async () => {
        const first = { mailboxUid: "mb", name: "jane@example.com", sealedFields: { name: "x" } };
        const second = { ...first, sealedFields: { name: "y" } };
        openSealedRecord.mockImplementation(async (record: any) => ({ ...record, name: `Opened ${record.sealedFields.name}` }));

        const hook = renderHook(({ record }) => useOpenedRecord(record), { initialProps: { record: first } });
        expect(hook.result.current).toEqual({ record: first, ready: false });
        await waitFor(() => expect(hook.result.current.ready).toBe(true));
        expect(hook.result.current.record?.name).toBe("Opened x");

        hook.rerender({ record: second });
        expect(hook.result.current.ready).toBe(false);
        await waitFor(() => expect(hook.result.current.record?.name).toBe("Opened y"));
    });

    it("keeps a record opened while a new object of it (a live update) is opened in turn, then takes the new one", async () => {
        const first = { uid: "c1", version: 1, mailboxUid: "mb", name: "jane@example.com", sealedFields: { name: "x" } };
        let finish: ((value: unknown) => void) | undefined;
        openSealedRecord.mockImplementation(async (record: any) => ({ ...record, name: "Jane" }));
        const hook = renderHook(({ record }) => useOpenedRecord(record), { initialProps: { record: first } });
        await waitFor(() => expect(hook.result.current.ready).toBe(true));

        openSealedRecord.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
        const updated = { ...first, version: 2 };
        hook.rerender({ record: updated });
        // Still ready - a form over it stays mounted - with what was opened.
        expect(hook.result.current).toEqual({ record: { ...first, name: "Jane" }, ready: true });
        await act(async () => finish!({ ...updated, name: "Jane" }));
        expect(hook.result.current.record).toEqual({ ...updated, name: "Jane" });

        // Another record isn't taken for it.
        hook.rerender({ record: { ...first, uid: "c2" } });
        expect(hook.result.current.ready).toBe(false);
    });

    it("drops what it opened the moment the record's mailbox locks, and opens it again on a lock or unlock", async () => {
        const record = { uid: "c1", mailboxUid: "mb", name: "[...]", sealedFields: { name: "x" } };
        openSealedRecord.mockImplementation(async (given: any) => ({ ...given, name: "Jane" }));
        const hook = renderHook(() => useOpenedRecord(record));
        await waitFor(() => expect(hook.result.current.record?.name).toBe("Jane"));
        expect(openSealedRecord).toHaveBeenCalledTimes(1);

        // Another mailbox's lock changes nothing.
        emit("other", "locked");
        expect(hook.result.current.record?.name).toBe("Jane");
        expect(openSealedRecord).toHaveBeenCalledTimes(1);

        // Locked: nothing opened is kept, and it is opened again - which now gives the placeholders.
        openSealedRecord.mockImplementation(async (given: any) => given);
        emit("mb", "locked");
        await waitFor(() => expect(hook.result.current).toEqual({ record, ready: true }));
        expect(openSealedRecord).toHaveBeenCalledTimes(2);

        // Unlocked again: opened again.
        openSealedRecord.mockImplementation(async (given: any) => ({ ...given, name: "Jane" }));
        emit("mb", "unlocked");
        await waitFor(() => expect(hook.result.current.record?.name).toBe("Jane"));

        hook.unmount();
        expect(keyListeners.size).toBe(0);
    });

    it("drops a result that arrives after the record changed", async () => {
        let finish!: (value: unknown) => void;
        openSealedRecord.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
        const first = { mailboxUid: "mb", sealedFields: { a: "1" } };
        const hook = renderHook(({ record }) => useOpenedRecord(record), { initialProps: { record: first as any } });
        hook.rerender({ record: { mailboxUid: "mb", plain: true } });
        finish({ ...first, late: true });
        await waitFor(() => expect(hook.result.current).toEqual({ record: { mailboxUid: "mb", plain: true }, ready: true }));
    });
});

// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { openSealedRecord } = vi.hoisted(() => ({ openSealedRecord: vi.fn() }));
vi.mock("../../../lib/zeroAccess/sealedRecords.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/zeroAccess/sealedRecords.js")>()),
    openSealedRecord,
}));

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

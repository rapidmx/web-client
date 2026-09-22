// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    SIGN_ENROLLMENT_STORAGE_PREFIX,
    readStoredSignEnrollment,
    storeSignEnrollment,
} from "../../../apps/shared/signing/enrollmentStorage.js";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("the stored enrollment id", () => {
    it("is kept per mailbox and forgotten with null", () => {
        expect(readStoredSignEnrollment("mb1")).toBeNull();
        storeSignEnrollment("mb1", "enr-1");
        storeSignEnrollment("mb2", "enr-2");
        expect(localStorage.getItem(`${SIGN_ENROLLMENT_STORAGE_PREFIX}mb1`)).toBe("enr-1");
        expect(readStoredSignEnrollment("mb1")).toBe("enr-1");
        storeSignEnrollment("mb1", null);
        expect(readStoredSignEnrollment("mb1")).toBeNull();
        expect(readStoredSignEnrollment("mb2")).toBe("enr-2");
    });

    it("survives blocked storage: reads nothing and writes nothing without throwing", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        expect(readStoredSignEnrollment("mb1")).toBeNull();
        expect(() => storeSignEnrollment("mb1", "enr-1")).not.toThrow();
        expect(() => storeSignEnrollment("mb1", null)).not.toThrow();
    });
});

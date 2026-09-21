// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { titleWithUnread, useUnreadTitle } from "../../../apps/shared/mail/useUnreadTitle.js";

beforeEach(() => {
    document.title = "Acme: Mail";
});

afterEach(() => {
    document.title = "";
});

describe("titleWithUnread", () => {
    it("puts the count in front, replaces one already there, and takes it off for none", () => {
        expect(titleWithUnread("Acme: Mail", 3)).toBe("(3) Acme: Mail");
        expect(titleWithUnread("(3) Acme: Mail", 5)).toBe("(5) Acme: Mail");
        expect(titleWithUnread("(3) Acme: Mail", 0)).toBe("Acme: Mail");
        expect(titleWithUnread("Acme: Mail", 0)).toBe("Acme: Mail");
    });

    it("stops counting at 99+", () => {
        expect(titleWithUnread("Acme: Mail", 99)).toBe("(99) Acme: Mail");
        expect(titleWithUnread("Acme: Mail", 100)).toBe("(99+) Acme: Mail");
    });

    it("only recognises its own prefix", () => {
        expect(titleWithUnread("(beta) Acme: Mail", 2)).toBe("(2) (beta) Acme: Mail");
    });
});

describe("useUnreadTitle", () => {
    it("keeps the tab title in step with the count, and restores it when it goes away", () => {
        const { rerender, unmount } = renderHook(({ count }) => useUnreadTitle(count), { initialProps: { count: 0 } });
        expect(document.title).toBe("Acme: Mail");

        rerender({ count: 4 });
        expect(document.title).toBe("(4) Acme: Mail");
        rerender({ count: 3 });
        expect(document.title).toBe("(3) Acme: Mail");
        rerender({ count: 0 });
        expect(document.title).toBe("Acme: Mail");

        rerender({ count: 2 });
        unmount();
        expect(document.title).toBe("Acme: Mail");
    });
});

describe("useUnreadTitle in the app frame", () => {
    it("does nothing while it is not the owner of the title, and takes over when it becomes one", () => {
        const { rerender } = renderHook(({ enabled }) => useUnreadTitle(4, { enabled }), { initialProps: { enabled: false } });
        expect(document.title).toBe("Acme: Mail");
        rerender({ enabled: true });
        expect(document.title).toBe("(4) Acme: Mail");
        rerender({ enabled: false });
        expect(document.title).toBe("Acme: Mail");
    });

    it("puts the count back in front of a title something else rewrote, when the reset key changes", () => {
        const { rerender } = renderHook(({ page }) => useUnreadTitle(2, { resetKey: page }), { initialProps: { page: "mail" } });
        expect(document.title).toBe("(2) Acme: Mail");

        // The page changed: the frame rewrites the title (the count goes off first, in this hook's cleanup, as it does in the frame) ...
        rerender({ page: "calendar" });
        document.title = "Acme: Calendar";
        // ... and the next change of key finds the new title and counts on it.
        rerender({ page: "contacts" });
        expect(document.title).toBe("(2) Acme: Calendar");
    });
});

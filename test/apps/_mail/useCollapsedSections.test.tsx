// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ALL_MAILBOXES_SECTION,
    SidebarSectionsOptions,
    collapsedSectionsKey,
    readSectionChoices,
    sectionChosenOpen,
    useSidebarSections,
    writeSectionChoices,
} from "../../../apps/shared/mail/useCollapsedSections.js";

afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
});

const KEY = collapsedSectionsKey("u1");
const stored = (userUid = "u1") => JSON.parse(localStorage.getItem(collapsedSectionsKey(userUid)) ?? "null");
const options = (extra: Partial<SidebarSectionsOptions> = {}): SidebarSectionsOptions => ({ userUid: "u1", primaryUid: "mb-own", activeId: undefined, ...extra });

describe("collapsedSectionsKey", () => {
    it("keeps one user's choices apart from another's", () => {
        expect(KEY).toBe("rapidmx:mail-sidebar-collapsed:u1");
        expect(collapsedSectionsKey("u2")).not.toBe(KEY);
    });
});

describe("readSectionChoices / writeSectionChoices", () => {
    it("reads nothing for a user who has never chosen, or is not known", () => {
        expect(readSectionChoices("u1")).toEqual({});
        expect(readSectionChoices(undefined)).toEqual({});
    });

    it("round-trips what was written, per user", () => {
        writeSectionChoices("u1", { "mb-a": true, all: false });
        expect(readSectionChoices("u1")).toEqual({ "mb-a": true, all: false });
        expect(readSectionChoices("u2")).toEqual({});
    });

    it("writes nothing for a user who is not known", () => {
        const setItem = vi.spyOn(Storage.prototype, "setItem");
        writeSectionChoices(undefined, { "mb-a": true });
        expect(setItem).not.toHaveBeenCalled();
    });

    it.each([["unparsable JSON", "{oops"], ["a string", '"collapsed"'], ["a number", "7"], ["null", "null"], ["an array", "[true]"]])(
        "falls back to no choices for %s",
        (_name, raw) => {
            localStorage.setItem(KEY, raw);
            expect(readSectionChoices("u1")).toEqual({});
        },
    );

    it("keeps the boolean choices of a partly valid record and drops the rest", () => {
        localStorage.setItem(KEY, JSON.stringify({ "mb-a": true, "mb-b": "yes", "mb-c": null, "mb-d": 1, "mb-e": false, nested: { x: true } }));
        expect(readSectionChoices("u1")).toEqual({ "mb-a": true, "mb-e": false });
    });

    it("does not let a stored __proto__ key reach the object's prototype", () => {
        localStorage.setItem(KEY, '{"__proto__":true,"mb-a":true}');
        const choices = readSectionChoices("u1");
        expect(Object.getPrototypeOf(choices)).toBe(Object.prototype);
        expect(choices["mb-a"]).toBe(true);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("tolerates a store that throws on read and on write", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        expect(readSectionChoices("u1")).toEqual({});
        expect(() => writeSectionChoices("u1", { "mb-a": true })).not.toThrow();
    });
});

describe("sectionChosenOpen", () => {
    it("opens All mailboxes and the primary mailbox by default, and nothing else", () => {
        expect(sectionChosenOpen(ALL_MAILBOXES_SECTION, {}, "mb-own")).toBe(true);
        expect(sectionChosenOpen("mb-own", {}, "mb-own")).toBe(true);
        expect(sectionChosenOpen("mb-shared", {}, "mb-own")).toBe(false);
        // No primary mailbox known yet: no mailbox is one.
        expect(sectionChosenOpen("mb-shared", {}, undefined)).toBe(false);
    });

    it("lets a choice replace the default either way", () => {
        expect(sectionChosenOpen("mb-own", { "mb-own": true }, "mb-own")).toBe(false);
        expect(sectionChosenOpen(ALL_MAILBOXES_SECTION, { all: true }, "mb-own")).toBe(false);
        expect(sectionChosenOpen("mb-shared", { "mb-shared": false }, "mb-own")).toBe(true);
    });
});

describe("useSidebarSections", () => {
    it("opens All mailboxes and the primary mailbox and collapses every other mailbox by default", () => {
        const { result } = renderHook(() => useSidebarSections(options()));
        expect(result.current.isExpanded(ALL_MAILBOXES_SECTION)).toBe(true);
        expect(result.current.isExpanded("mb-own")).toBe(true);
        expect(result.current.isExpanded("mb-shared")).toBe(false);
        expect(result.current.isExpanded("mb-brand-new")).toBe(false);
        expect(localStorage.getItem(KEY)).toBeNull();
    });

    it("remembers a toggle in both directions, and it survives a remount", () => {
        const first = renderHook(() => useSidebarSections(options()));
        act(() => first.result.current.toggle("mb-shared"));
        act(() => first.result.current.toggle("mb-own"));
        expect(first.result.current.isExpanded("mb-shared")).toBe(true);
        expect(first.result.current.isExpanded("mb-own")).toBe(false);
        expect(stored()).toEqual({ "mb-shared": false, "mb-own": true });
        first.unmount();

        const second = renderHook(() => useSidebarSections(options()));
        expect(second.result.current.isExpanded("mb-shared")).toBe(true);
        expect(second.result.current.isExpanded("mb-own")).toBe(false);
        // Untouched sections still follow the default.
        expect(second.result.current.isExpanded(ALL_MAILBOXES_SECTION)).toBe(true);

        act(() => second.result.current.toggle("mb-shared"));
        expect(second.result.current.isExpanded("mb-shared")).toBe(false);
        expect(stored()).toEqual({ "mb-shared": true, "mb-own": true });
    });

    it("keeps a choice over a default that later changes: a section chosen closed stays closed if it becomes the primary one", () => {
        localStorage.setItem(KEY, JSON.stringify({ "mb-shared": true }));
        const { result, rerender } = renderHook((props: SidebarSectionsOptions) => useSidebarSections(props), { initialProps: options() });
        expect(result.current.isExpanded("mb-shared")).toBe(false);
        rerender(options({ primaryUid: "mb-shared" }));
        expect(result.current.isExpanded("mb-shared")).toBe(false);
        // ... while a section nobody chose follows the new primary.
        expect(result.current.isExpanded("mb-own")).toBe(false);
    });

    it("counts two toggles made before the next render", () => {
        const { result } = renderHook(() => useSidebarSections(options()));
        act(() => {
            result.current.toggle("mb-a");
            result.current.toggle("mb-b");
        });
        expect(stored()).toEqual({ "mb-a": false, "mb-b": false });
        act(() => {
            result.current.toggle("mb-a");
            result.current.toggle("mb-a");
        });
        expect(stored()).toEqual({ "mb-a": false, "mb-b": false });
    });

    it("keeps one user's choices from another's", () => {
        const u1 = renderHook(() => useSidebarSections(options({ userUid: "u1" })));
        act(() => u1.result.current.toggle("mb-shared"));
        u1.unmount();

        const u2 = renderHook(() => useSidebarSections(options({ userUid: "u2" })));
        expect(u2.result.current.isExpanded("mb-shared")).toBe(false);
        act(() => u2.result.current.toggle("mb-own"));
        expect(stored("u2")).toEqual({ "mb-own": true });
        expect(stored("u1")).toEqual({ "mb-shared": false });
    });

    it("starts over from the next user's choices when another user signs in on the same page", () => {
        localStorage.setItem(collapsedSectionsKey("u1"), JSON.stringify({ "mb-shared": false }));
        localStorage.setItem(collapsedSectionsKey("u2"), JSON.stringify({ "mb-own": true }));
        const { result, rerender } = renderHook((props: SidebarSectionsOptions) => useSidebarSections(props), { initialProps: options({ userUid: "u1" }) });
        expect(result.current.isExpanded("mb-shared")).toBe(true);
        expect(result.current.isExpanded("mb-own")).toBe(true);

        rerender(options({ userUid: "u2" }));
        expect(result.current.isExpanded("mb-shared")).toBe(false);
        expect(result.current.isExpanded("mb-own")).toBe(false);

        act(() => result.current.toggle("mb-shared"));
        expect(stored("u2")).toEqual({ "mb-own": true, "mb-shared": false });
        expect(stored("u1")).toEqual({ "mb-shared": false });
    });

    it("only holds the choices for this page view when no user is known, without touching storage", () => {
        const setItem = vi.spyOn(Storage.prototype, "setItem");
        const { result } = renderHook(() => useSidebarSections(options({ userUid: undefined })));
        act(() => result.current.toggle("mb-shared"));
        expect(result.current.isExpanded("mb-shared")).toBe(true);
        expect(setItem).not.toHaveBeenCalled();
    });

    it("still toggles when the store is corrupt or blocked", () => {
        localStorage.setItem(KEY, "{oops");
        const corrupt = renderHook(() => useSidebarSections(options()));
        expect(corrupt.result.current.isExpanded("mb-shared")).toBe(false);
        act(() => corrupt.result.current.toggle("mb-shared"));
        expect(corrupt.result.current.isExpanded("mb-shared")).toBe(true);
        expect(stored()).toEqual({ "mb-shared": false });
        corrupt.unmount();

        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        const blocked = renderHook(() => useSidebarSections(options()));
        expect(blocked.result.current.isExpanded("mb-own")).toBe(true);
        act(() => blocked.result.current.toggle("mb-own"));
        expect(blocked.result.current.isExpanded("mb-own")).toBe(false);
    });

    describe("the section of the open folder", () => {
        it("is open whatever was chosen or defaulted, and says it is locked", () => {
            localStorage.setItem(KEY, JSON.stringify({ "mb-own": true }));
            const { result } = renderHook(() => useSidebarSections(options({ activeId: "mb-shared" })));
            expect(result.current.isExpanded("mb-shared")).toBe(true);
            expect(result.current.isLocked("mb-shared")).toBe(true);
            expect(result.current.isLocked("mb-own")).toBe(false);
            expect(result.current.isExpanded("mb-own")).toBe(false);
        });

        it("can be All mailboxes, for an aggregate view", () => {
            localStorage.setItem(KEY, JSON.stringify({ all: true }));
            const { result } = renderHook(() => useSidebarSections(options({ activeId: ALL_MAILBOXES_SECTION })));
            expect(result.current.isExpanded(ALL_MAILBOXES_SECTION)).toBe(true);
            expect(result.current.isLocked(ALL_MAILBOXES_SECTION)).toBe(true);
        });

        it("is not written as a choice, and goes back to the default once another folder is open", () => {
            const { result, rerender } = renderHook((props: SidebarSectionsOptions) => useSidebarSections(props), {
                initialProps: options({ activeId: "mb-shared" }),
            });
            expect(result.current.isExpanded("mb-shared")).toBe(true);
            expect(localStorage.getItem(KEY)).toBeNull();

            rerender(options({ activeId: "mb-own" }));
            expect(result.current.isExpanded("mb-shared")).toBe(false);
            expect(result.current.isLocked("mb-shared")).toBe(false);
        });

        it("cannot be collapsed, and the attempt is not remembered", () => {
            const { result, rerender } = renderHook((props: SidebarSectionsOptions) => useSidebarSections(props), {
                initialProps: options({ activeId: "mb-own" }),
            });
            act(() => result.current.toggle("mb-own"));
            expect(result.current.isExpanded("mb-own")).toBe(true);
            expect(localStorage.getItem(KEY)).toBeNull();

            // Not even once the folder is somewhere else.
            rerender(options({ activeId: "mb-shared" }));
            expect(result.current.isExpanded("mb-own")).toBe(true);
        });
    });
});

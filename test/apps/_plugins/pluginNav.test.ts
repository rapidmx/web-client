///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { isSafePluginHref, mergePluginNavItems, PluginUiNavItem } from "../../../apps/shared/plugins/pluginNav.js";

const CORE = [
    { id: "a", href: "/a", label: "A" },
    { id: "b", href: "/b", label: "B" },
];
const identity = (item: PluginUiNavItem) => ({ ...item });

describe("isSafePluginHref", () => {
    it("accepts same-origin absolute paths", () => {
        expect(isSafePluginHref("/settings/booking-types")).toBe(true);
        expect(isSafePluginHref("/")).toBe(true);
    });

    it("rejects relative, protocol-relative and absolute URLs", () => {
        for (const href of ["settings", "//evil.example.com", "/\\evil.example.com", "https://evil.example.com", "javascript:alert(1)", ""]) {
            expect(isSafePluginHref(href)).toBe(false);
        }
    });
});

describe("mergePluginNavItems", () => {
    it("returns the core items unchanged when there are no plugin items", () => {
        expect(mergePluginNavItems(CORE, undefined, identity)).toBe(CORE);
        expect(mergePluginNavItems(CORE, [], identity)).toBe(CORE);
    });

    it("appends plugin items after the core items, in order, through toItem", () => {
        const merged = mergePluginNavItems(
            CORE,
            [
                { id: "p1", href: "/p1", label: "P1" },
                { id: "p2", href: "/p2", label: "P2" },
            ],
            (item) => ({ ...item, label: item.label.toLowerCase() }),
        );
        expect(merged.map((item) => item.id)).toEqual(["a", "b", "p1", "p2"]);
        expect(merged[2].label).toBe("p1");
        // Never mutates the core list.
        expect(CORE).toHaveLength(2);
    });

    it("skips plugin items whose id collides with a core item, a reserved id or an earlier plugin item", () => {
        const merged = mergePluginNavItems(
            CORE,
            [
                { id: "a", href: "/plugin-a", label: "Plugin A" },
                { id: "reserved", href: "/reserved", label: "Reserved" },
                { id: "p", href: "/p", label: "First" },
                { id: "p", href: "/p2", label: "Second" },
            ],
            identity,
            ["reserved"],
        );
        expect(merged).toEqual([...CORE, { id: "p", href: "/p", label: "First" }]);
    });

    it("skips malformed items and items with an unsafe href", () => {
        const merged = mergePluginNavItems(
            CORE,
            [
                null,
                { id: 1, href: "/x", label: "X" },
                { id: "x", href: "/x", label: undefined },
                { id: "x", href: undefined, label: "X" },
                { id: "evil", href: "//evil.example.com", label: "Evil" },
                { id: "ok", href: "/ok", label: "OK" },
            ] as unknown as PluginUiNavItem[],
            identity,
        );
        expect(merged.map((item) => item.id)).toEqual(["a", "b", "ok"]);
    });
});

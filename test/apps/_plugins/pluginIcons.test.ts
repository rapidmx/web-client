///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { HiOutlineCalendarDays, HiOutlinePuzzlePiece, HiOutlineUserGroup } from "react-icons/hi2";
import { DEFAULT_PLUGIN_ICON, PLUGIN_ICONS, pluginIcon } from "../../../apps/shared/plugins/pluginIcons.js";
import { appRailItems } from "../../../apps/shared/components/layout/AppShell.js";
import { adminNavItems } from "../../../apps/shared/components/admin/layout/AdminShell.js";
import { settingsSections } from "../../../apps/shared/components/settings/layout/SettingsShell.js";

describe("pluginIcon", () => {
    it("resolves a listed icon name to its component", () => {
        expect(pluginIcon("HiOutlineUserGroup")).toBe(HiOutlineUserGroup);
        expect(pluginIcon("HiOutlineCalendarDays")).toBe(HiOutlineCalendarDays);
    });

    it("falls back to the puzzle piece for no name, an unlisted name, or an inherited property", () => {
        expect(DEFAULT_PLUGIN_ICON).toBe(HiOutlinePuzzlePiece);
        for (const name of [undefined, "", "HiOutlineNotAnIcon", "constructor", "toString"]) {
            expect(pluginIcon(name)).toBe(HiOutlinePuzzlePiece);
        }
    });

    it("lists only outline icons, each a component", () => {
        for (const [name, icon] of Object.entries(PLUGIN_ICONS)) {
            expect(name).toMatch(/^HiOutline[A-Z]/);
            expect(typeof icon).toBe("function");
        }
    });
});

describe("plugin nav icons in the shells", () => {
    it("gives app rail, admin and settings items their manifest icon, or the puzzle piece", () => {
        const pluginNav = {
            appRail: [{ id: "crm", href: "/crm", label: "CRM", icon: "HiOutlineUserGroup" }],
            adminNav: [{ id: "crm-admin", href: "/admin/crm", label: "CRM", icon: "HiOutlineNope" }],
            settingsSections: [{ id: "booking-types", href: "/settings/booking-types", label: "Booking Links", icon: "HiOutlineCalendarDays" }],
        };

        expect(appRailItems(pluginNav).find((item) => item.id === "crm")?.icon).toBe(HiOutlineUserGroup);
        expect(adminNavItems(pluginNav).find((item) => item.id === "crm-admin")?.icon).toBe(HiOutlinePuzzlePiece);
        expect(settingsSections(pluginNav).find((item) => item.id === "booking-types")?.icon).toBe(HiOutlineCalendarDays);
    });
});

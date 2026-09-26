///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { brandName, pageTitle } from "../../../apps/shared/navigation/pageTitle.js";

describe("brandName", () => {
    it("is the branding's title, else its company name, else RapidMX", () => {
        expect(brandName({ title: "Acme Mail", companyName: "Acme" })).toBe("Acme Mail");
        expect(brandName({ title: "", companyName: "Acme" })).toBe("Acme");
        expect(brandName({ title: "", companyName: "" })).toBe("RapidMX");
        expect(brandName(null)).toBe("RapidMX");
        expect(brandName()).toBe("RapidMX");
    });
});

describe("pageTitle", () => {
    it("makes a page's title export: the brand and the app's name, from the page's branding prop", () => {
        const title = pageTitle("Calendar");
        expect(title({ branding: { title: "Acme Mail", companyName: "Acme" } })).toBe("Acme Mail: Calendar");
        expect(title({ branding: { title: "", companyName: "Acme" } })).toBe("Acme: Calendar");
        expect(title({})).toBe("RapidMX: Calendar");
        expect(title({ branding: null })).toBe("RapidMX: Calendar");
    });
});

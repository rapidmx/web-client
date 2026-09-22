// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import BrandingPage from "../../../../apps/admin/branding/index.js";
import { HEADER_HTML_EXAMPLE } from "../../../../apps/shared/components/admin/settings/BrandingForm.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

function open() {
    mockFetch((url) => {
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        if (url === "/api/system/setup") return jsonResponse(200, { required: false });
        if (url === "/api/system/branding") return jsonResponse(200, { companyName: "Acme", title: "Acme Mail" });
        throw new Error(`unexpected ${url}`);
    });
    render(<BrandingPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
    return screen.findByLabelText("Header HTML");
}

describe("the Branding page's help for the header and footer variables", () => {
    it("says what a header does and documents {USER_MENU} and {APP_TITLE} under the header field", async () => {
        const header = await open();
        const help = header.closest("label")!;
        expect(help).toHaveTextContent("replaces the app's own title bar and the icon at the top of the icon rail");
        expect(within(help).getAllByText("{USER_MENU}", { selector: "code", exact: true }).length).toBeGreaterThan(0);
        expect(within(help).getByText("{APP_TITLE}", { selector: "code", exact: true })).toBeInTheDocument();
        expect(help).toHaveTextContent("replaced once");
        expect(help).toHaveTextContent("small cell at the right end of the header, so it is never lost");
    });

    it("documents the variables under the footer field too", async () => {
        await open();
        const footer = screen.getByLabelText("Footer HTML").closest("label")!;
        expect(footer).toHaveTextContent("{APP_TITLE} works here as well");
        expect(footer).toHaveTextContent("takes the account menu (opening upward) when the header has none");
    });

    it("shows an example header that uses both, and copies it", async () => {
        const user = userEvent.setup();
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
        await open();
        const example = screen.getByRole("group", { name: "Header example" });
        expect(example).toHaveTextContent("{USER_MENU}");
        expect(example).toHaveTextContent("{APP_TITLE}");
        expect(HEADER_HTML_EXAMPLE).toContain("{USER_MENU}");
        await user.click(within(example).getByRole("button", { name: "Copy the example header HTML" }));
        expect(writeText).toHaveBeenCalledWith(HEADER_HTML_EXAMPLE);
        Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    });
});

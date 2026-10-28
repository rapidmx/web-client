// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../../../testUtils.js";
import GiphyPage from "../../../../../apps/admin/integrations/giphy/index.js";
import { integrationsView, MASK, mockIntegrations, setByAdmin } from "../fixtures.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

const renderPage = () => render(<GiphyPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

describe("GiphyPage", () => {
    it("sits in the Integrations section, with every area in its own navigation", async () => {
        mockIntegrations(integrationsView());
        renderPage();

        expect(await screen.findByRole("heading", { name: "Giphy" })).toBeInTheDocument();
        const nav = screen.getByRole("navigation", { name: "Integrations" });
        expect(
            within(nav)
                .getAllByRole("link")
                .map((link) => [link.textContent, link.getAttribute("href")])
        ).toEqual([
            ["DNS providers", "/admin/integrations/dns-providers"],
            ["Giphy", "/admin/integrations/giphy"],
            ["STUN servers", "/admin/integrations/stun"],
            ["S/MIME signing CA", "/admin/integrations/signing-ca"],
            ["DNS resolver", "/admin/integrations/dns-resolver"],
            ["Plugin registry", "/admin/integrations/plugin-registry"],
        ]);
        expect(within(nav).getByRole("link", { name: "Giphy" })).toHaveAttribute("aria-current", "page");
        // The rail highlights Integrations.
        expect(screen.getByRole("link", { name: "Integrations" })).toHaveAttribute("aria-current", "page");
    });

    it("shows the deployment's values beneath each field, with no reset while nothing is set here", async () => {
        mockIntegrations(integrationsView());
        renderPage();

        expect(await screen.findByLabelText("Use Giphy for GIF search")).toBeChecked();
        expect(screen.getByText("Deployment default: on")).toBeInTheDocument();
        expect(screen.getByLabelText("API key")).toHaveValue("");
        expect(screen.getByText("Deployment default: none")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /to the deployment default/ })).not.toBeInTheDocument();
    });

    it("saves a new key write-only, with the version it was read at, and then shows it as set", async () => {
        const saved = setByAdmin(integrationsView(), "giphy", "apiKey", MASK);
        saved.version = 4;
        const { puts } = mockIntegrations(integrationsView(), () => jsonResponse(200, saved));
        const user = userEvent.setup();
        renderPage();

        await user.type(await screen.findByLabelText("API key"), "giphy-key-1");
        expect(screen.getByLabelText("API key")).toHaveAttribute("type", "password");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(puts).toEqual([{ section: "giphy", body: { apiKey: "giphy-key-1", version: 3 } }]);
        // The key is never shown again: only that it is set here, with a way to replace it.
        expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
        expect(screen.getByText("Set")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Replace API key" })).toBeInTheDocument();
    });

    it("replaces a key saved here, or keeps it when the replacement is abandoned", async () => {
        const { puts } = mockIntegrations(setByAdmin(integrationsView(), "giphy", "apiKey", MASK));
        const user = userEvent.setup();
        renderPage();

        await user.click(await screen.findByRole("button", { name: "Replace API key" }));
        await user.type(screen.getByLabelText("API key"), "x");
        await user.click(screen.getByRole("button", { name: "Keep the saved API key" }));
        expect(screen.getByText("Set")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(puts).toEqual([]);

        await user.click(screen.getByRole("button", { name: "Replace API key" }));
        await user.type(screen.getByLabelText("API key"), "new-key");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts).toEqual([{ section: "giphy", body: { apiKey: "new-key", version: 3 } }]));
    });

    it("says a key saved here can't be read, and asks for it again instead of calling it set", async () => {
        const unreadable = { secret: true, unreadable: true };
        const { puts } = mockIntegrations(setByAdmin(integrationsView(), "giphy", "apiKey", unreadable));
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findByText("Set, but can't be read: enter it again")).toBeInTheDocument();
        expect(screen.queryByText("Set")).not.toBeInTheDocument();
        // Saved as it is, the unreadable key is neither sent nor reset: sending nothing keeps it.
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(puts).toEqual([]);

        await user.click(screen.getByRole("button", { name: "Replace API key" }));
        await user.type(screen.getByLabelText("API key"), "entered-again");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts).toEqual([{ section: "giphy", body: { apiKey: "entered-again", version: 3 } }]));
    });

    it("says a key saved here is set, without the warning, while the server can read it", async () => {
        mockIntegrations(setByAdmin(integrationsView(), "giphy", "apiKey", MASK));
        renderPage();

        expect(await screen.findByText("Set")).toBeInTheDocument();
        expect(screen.queryByText(/can't be read/)).not.toBeInTheDocument();
    });

    it("says a key set by the deployment is set, and an override replaces it", async () => {
        const view = integrationsView();
        view.giphy.values.apiKey = MASK;
        view.giphy.defaults.apiKey = MASK;
        const { puts } = mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findByText("Set by this deployment")).toBeInTheDocument();
        expect(screen.getByText("Deployment default: set")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Replace API key" }));
        await user.type(screen.getByLabelText("API key"), "mine");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body)).toEqual([{ apiKey: "mine", version: 3 }]));
    });

    it("puts fields set here back to the deployment's values only when saved", async () => {
        const view = setByAdmin(setByAdmin(integrationsView(), "giphy", "enabled", false), "giphy", "apiKey", MASK);
        const { puts } = mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findByLabelText("Use Giphy for GIF search")).not.toBeChecked();
        await user.click(screen.getByRole("button", { name: "Reset GIF search to the deployment default" }));
        // The form shows the deployment's value; nothing is saved yet.
        expect(screen.getByLabelText("Use Giphy for GIF search")).toBeChecked();
        expect(screen.queryByRole("button", { name: "Reset GIF search to the deployment default" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Reset API key to the deployment default" }));
        expect(screen.getByLabelText("API key")).toHaveValue("");
        expect(puts).toEqual([]);

        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts).toEqual([{ section: "giphy", body: { enabled: null, apiKey: null, version: 3 } }]));
    });

    it("never saves a copy of the deployment's value: a field edited back to it is reset, one never set here is not sent", async () => {
        const { puts } = mockIntegrations(setByAdmin(integrationsView(), "giphy", "enabled", false));
        const user = userEvent.setup();
        renderPage();

        // Set here to off; turned on again it equals the deployment's value, so it is put back to it.
        await user.click(await screen.findByLabelText("Use Giphy for GIF search"));
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body)).toEqual([{ enabled: null, version: 3 }]));
    });

    it("sends nothing for a field changed and changed back", async () => {
        const { puts } = mockIntegrations(integrationsView());
        const user = userEvent.setup();
        renderPage();

        const enabled = await screen.findByLabelText("Use Giphy for GIF search");
        await user.click(enabled);
        expect(screen.getByRole("button", { name: "Reset GIF search to the deployment default" })).toBeInTheDocument();
        await user.click(enabled);
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(puts).toEqual([]);
    });

    it("takes back a key typed for a field the deployment sets, through its reset", async () => {
        const { puts } = mockIntegrations(integrationsView());
        const user = userEvent.setup();
        renderPage();

        await user.type(await screen.findByLabelText("API key"), "typed");
        await user.click(screen.getByRole("button", { name: "Reset API key to the deployment default" }));
        expect(screen.getByLabelText("API key")).toHaveValue("");
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(puts).toEqual([]);
    });

    it("sends nothing for a field set here changed and changed back, or a key typed and erased", async () => {
        const view = setByAdmin(integrationsView(), "giphy", "enabled", true);
        // The deployment turns Giphy off; the administrator turned it on here.
        view.giphy.defaults.enabled = false;
        const { puts } = mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findByText("Deployment default: off")).toBeInTheDocument();
        const enabled = screen.getByLabelText("Use Giphy for GIF search");
        await user.click(enabled);
        await user.click(enabled);
        await user.type(screen.getByLabelText("API key"), "k");
        await user.clear(screen.getByLabelText("API key"));
        expect(screen.queryByRole("button", { name: "Reset API key to the deployment default" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(puts).toEqual([]);
    });

    it("turns Giphy off here", async () => {
        const { puts } = mockIntegrations(integrationsView());
        const user = userEvent.setup();
        renderPage();

        await user.click(await screen.findByLabelText("Use Giphy for GIF search"));
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body)).toEqual([{ enabled: false, version: 3 }]));
    });

    it("asks the administrator to confirm their identity again when the save needs it", async () => {
        mockIntegrations(integrationsView(), () => jsonResponse(403, { message: "Requires elevation.", code: "api-104" }));
        const user = userEvent.setup();
        renderPage();

        await user.click(await screen.findByLabelText("Use Giphy for GIF search"));
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText(/recently confirmed your identity/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Confirm identity again" })).toBeInTheDocument();
        expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
    });

    it("shows the server's refusal of a change made against an older version, and a generic message otherwise", async () => {
        let answer: () => Response = () => jsonResponse(409, { message: "The integrations were changed by someone else. Reload them and try again." });
        mockIntegrations(integrationsView(), () => answer());
        const user = userEvent.setup();
        renderPage();

        await user.click(await screen.findByLabelText("Use Giphy for GIF search"));
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("The integrations were changed by someone else. Reload them and try again.")).toBeInTheDocument();

        answer = () => {
            throw new TypeError("network down");
        };
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Could not save the Giphy settings.")).toBeInTheDocument();
    });

    it("loads the settings again after a refusal for a newer version, so the next save is made against it", async () => {
        const newer = { ...integrationsView(), version: 4 };
        let current: any = integrationsView();
        let refuse = true;
        const { puts } = mockIntegrations(
            () => jsonResponse(200, current),
            () => (refuse ? jsonResponse(409, { message: "The integrations were changed by someone else. Reload them and try again." }) : jsonResponse(200, newer))
        );
        const user = userEvent.setup();
        renderPage();

        await user.click(await screen.findByLabelText("Use Giphy for GIF search"));
        // Another change has moved the version since the page loaded.
        current = newer;
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText(/changed by someone else. They are shown as saved now, with your entries kept/)).toBeInTheDocument();
        refuse = false;
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body.version)).toEqual([3, 4]));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
    });

    it("says why the settings can't be shown", async () => {
        mockIntegrations(() => jsonResponse(500, { message: "Database unavailable." }));
        renderPage();
        expect(await screen.findByText("Database unavailable.")).toBeInTheDocument();
    });

    it("falls back to a generic message when the settings can't be loaded", async () => {
        mockIntegrations(() => {
            throw new TypeError("network down");
        });
        renderPage();
        expect(await screen.findByText("Could not load the integrations.")).toBeInTheDocument();
    });

    it("says when this server has no Integrations to show", async () => {
        mockIntegrations(() => jsonResponse(404, { message: "Not Found" }));
        renderPage();
        expect(await screen.findByText("This server doesn't offer Integrations yet. Upgrade it to manage them here.")).toBeInTheDocument();
    });
});

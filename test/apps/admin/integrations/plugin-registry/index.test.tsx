// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import PluginRegistryPage from "../../../../../apps/admin/integrations/plugin-registry/index.js";
import { integrationsView, MASK, mockIntegrations, setByAdmin } from "../fixtures.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

const renderPage = () => render(<PluginRegistryPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

describe("PluginRegistryPage", () => {
    it("shows the registry, its token, the namespaces and that a change applies to the next install or update", async () => {
        mockIntegrations(integrationsView());
        renderPage();

        expect(await screen.findByRole("heading", { name: "Plugin registry" })).toBeInTheDocument();
        expect(screen.getByLabelText("Registry URL")).toHaveValue("https://registry.npmjs.org/");
        expect(screen.getByLabelText("Registry token")).toHaveValue("");
        expect(screen.getByLabelText("Scope of namespace 1")).toHaveValue("@rapidmx");
        expect(screen.getByLabelText("Registry of namespace 1")).toHaveValue("");
        expect(screen.getByText("Deployment default: @rapidmx")).toBeInTheDocument();
        expect(screen.getByText(/next plugin install or update/)).toBeInTheDocument();
    });

    it("adds a namespace on its own registry with a token, and saves the list with the registry's token", async () => {
        const { puts } = mockIntegrations(integrationsView());
        const user = userEvent.setup();
        renderPage();

        await user.type(await screen.findByLabelText("Registry token"), "npm-token");
        await user.click(screen.getByRole("button", { name: "Add namespace" }));
        await user.type(screen.getByLabelText("Scope of namespace 2"), " @acme ");
        await user.type(screen.getByLabelText("Registry of namespace 2"), "https://npm.acme.example/");
        await user.type(screen.getByLabelText("Token of namespace 2"), "acme-token");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() =>
            expect(puts).toEqual([
                {
                    section: "pluginRegistry",
                    body: {
                        token: "npm-token",
                        namespaces: [{ name: "@rapidmx" }, { name: "@acme", registry: "https://npm.acme.example/", token: "acme-token" }],
                        version: 3,
                    },
                },
            ])
        );
    });

    it("keeps a namespace token saved here by sending the mask back, and drops a removed namespace", async () => {
        const view = setByAdmin(integrationsView(), "pluginRegistry", "namespaces", [
            { name: "@rapidmx" },
            { name: "@acme", registry: "https://npm.acme.example/", token: MASK },
            { name: "@other" },
        ]);
        const { puts } = mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findByText("Set")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Remove namespace 3" }));
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() =>
            expect(puts.map((put) => put.body)).toEqual([
                {
                    namespaces: [{ name: "@rapidmx" }, { name: "@acme", registry: "https://npm.acme.example/", token: MASK }],
                    version: 3,
                },
            ])
        );
    });

    it("says a registry token and a namespace token the server can't read must be entered again, and keeps them unless they are", async () => {
        const unreadable = { secret: true, unreadable: true };
        const view = setByAdmin(
            setByAdmin(integrationsView(), "pluginRegistry", "token", unreadable),
            "pluginRegistry",
            "namespaces",
            [{ name: "@rapidmx" }, { name: "@acme", token: unreadable }]
        );
        const { puts } = mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findAllByText("Set, but can't be read: enter it again")).toHaveLength(2);
        expect(screen.queryByText("Set")).not.toBeInTheDocument();

        // An unrelated change keeps both: the namespace's token goes back as the plain mask, which the server keeps as it is.
        await user.click(screen.getByRole("button", { name: "Add namespace" }));
        await user.type(screen.getByLabelText("Scope of namespace 3"), "@new");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() =>
            expect(puts.map((put) => put.body)).toEqual([{ namespaces: [{ name: "@rapidmx" }, { name: "@acme", token: MASK }, { name: "@new" }], version: 3 }])
        );
    });

    it("saves nothing for a list of namespaces with an unreadable token that was edited and put back", async () => {
        const unreadable = { secret: true, unreadable: true };
        const view = setByAdmin(integrationsView(), "pluginRegistry", "namespaces", [{ name: "@acme", token: unreadable }]);
        const { puts } = mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        await screen.findByText("Set, but can't be read: enter it again");
        // The list as it will be sent has the plain mask where the view has the flag: the two are the same list, so nothing is saved.
        await user.click(screen.getByRole("button", { name: "Add namespace" }));
        await user.click(screen.getByRole("button", { name: "Remove namespace 2" }));
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(puts).toEqual([]);
    });

    it("doesn't call a renamed namespace's token unreadable, since the server doesn't keep it under the new scope", async () => {
        const view = setByAdmin(integrationsView(), "pluginRegistry", "namespaces", [{ name: "@acme", token: { secret: true, unreadable: true } }]);
        mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        await user.type(await screen.findByLabelText("Scope of namespace 1"), "-corp");
        expect(screen.queryByText(/can't be read/)).not.toBeInTheDocument();
    });

    it("says a changed list replaces the deployment's, whose tokens aren't carried over", async () => {
        const view = integrationsView();
        const deployment = [{ name: "@rapidmx" }, { name: "@private", registry: "https://npm.private.example/", token: MASK }];
        view.pluginRegistry.values.namespaces = deployment;
        view.pluginRegistry.defaults.namespaces = deployment;
        const { puts } = mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findByText("Set by this deployment")).toBeInTheDocument();
        expect(screen.getByText(/tokens the deployment sets for them aren’t copied/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Add namespace" }));
        await user.type(screen.getByLabelText("Scope of namespace 3"), "@acme");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() =>
            expect(puts.map((put) => put.body)).toEqual([
                {
                    namespaces: [{ name: "@rapidmx" }, { name: "@private", registry: "https://npm.private.example/" }, { name: "@acme" }],
                    version: 3,
                },
            ])
        );
    });

    it("keeps a namespace token saved here when the list is edited to match the deployment's, which only looks the same", async () => {
        // The deployment's @private token and the one saved here are both shown as the mask: the list isn't the deployment's, and resetting it would
        // delete the token saved here.
        const view = setByAdmin(integrationsView(), "pluginRegistry", "namespaces", [
            { name: "@private", registry: "https://npm.private.example/", token: MASK },
            { name: "@acme" },
        ]);
        view.pluginRegistry.defaults.namespaces = [{ name: "@private", registry: "https://npm.private.example/", token: MASK }];
        const { puts } = mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        await user.click(await screen.findByRole("button", { name: "Remove namespace 2" }));
        expect(screen.getByRole("button", { name: "Reset plugin namespaces to the deployment default" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() =>
            expect(puts.map((put) => put.body)).toEqual([
                {
                    namespaces: [{ name: "@private", registry: "https://npm.private.example/", token: MASK }],
                    version: 3,
                },
            ])
        );
    });

    it("still resets a list edited back to the deployment's when it keeps no token saved here", async () => {
        const view = setByAdmin(integrationsView(), "pluginRegistry", "namespaces", [{ name: "@rapidmx" }, { name: "@acme", token: MASK }]);
        const { puts } = mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        await user.click(await screen.findByRole("button", { name: "Remove namespace 2" }));
        expect(screen.queryByRole("button", { name: "Reset plugin namespaces to the deployment default" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body)).toEqual([{ namespaces: null, version: 3 }]));
    });

    it("doesn't claim a token is kept for a renamed namespace, whose token the server keeps only under its old scope", async () => {
        const view = setByAdmin(integrationsView(), "pluginRegistry", "namespaces", [{ name: "@acme", token: MASK }]);
        const { puts } = mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        await user.type(await screen.findByLabelText("Scope of namespace 1"), "-corp");
        expect(screen.queryByText("Set")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Token of namespace 1")).toHaveValue("");
        expect(screen.getByText(/The token saved for @acme doesn’t follow a new scope/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body)).toEqual([{ namespaces: [{ name: "@acme-corp" }], version: 3 }]));
    });

    it("keeps the token of a namespace renamed back to its scope, written without its @", async () => {
        const view = setByAdmin(integrationsView(), "pluginRegistry", "namespaces", [{ name: "@acme", token: MASK }, { name: "@other" }]);
        const { puts } = mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        const scope = await screen.findByLabelText("Scope of namespace 1");
        await user.clear(scope);
        await user.type(scope, " acme ");
        expect(screen.getByText("Set")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Remove namespace 2" }));
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body)).toEqual([{ namespaces: [{ name: "acme", token: MASK }], version: 3 }]));
    });

    it("says before saving that the deployment's token isn't used with another registry typed in", async () => {
        const view = integrationsView();
        view.pluginRegistry.values.token = MASK;
        view.pluginRegistry.defaults.token = MASK;
        mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findByText("Set by this deployment")).toBeInTheDocument();
        expect(screen.queryByText(/only sent to the deployment’s registry/)).not.toBeInTheDocument();
        await user.clear(screen.getByLabelText("Registry URL"));
        await user.type(screen.getByLabelText("Registry URL"), "https://npm.other.example/");
        expect(screen.getByText(/The deployment’s tokens for its registry are only sent to the deployment’s registry/)).toBeInTheDocument();
        // The same registry with credentials in its URL is still the deployment's.
        await user.clear(screen.getByLabelText("Registry URL"));
        await user.type(screen.getByLabelText("Registry URL"), "https://me:pw@registry.npmjs.org/");
        expect(screen.queryByText(/only sent to the deployment’s registry/)).not.toBeInTheDocument();
    });

    it("says the deployment's namespace tokens for its registry aren't used with another, until a token is typed", async () => {
        const view = integrationsView();
        const deployment = [{ name: "@private", token: MASK }];
        view.pluginRegistry.values.namespaces = deployment;
        view.pluginRegistry.defaults.namespaces = deployment;
        mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        await user.clear(await screen.findByLabelText("Registry URL"));
        expect(screen.getByText(/only sent to the deployment’s registry/)).toBeInTheDocument();
        await user.type(screen.getByLabelText("Registry token"), "other-token");
        expect(screen.queryByText(/only sent to the deployment’s registry/)).not.toBeInTheDocument();
    });

    it("replaces a namespace token and its registry", async () => {
        const view = setByAdmin(integrationsView(), "pluginRegistry", "namespaces", [{ name: "@acme", registry: "https://npm.acme.example/", token: MASK }]);
        const { puts } = mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        await user.click(await screen.findByRole("button", { name: "Replace token of namespace 1" }));
        await user.type(screen.getByLabelText("Token of namespace 1"), "rotated");
        await user.clear(screen.getByLabelText("Registry of namespace 1"));
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body)).toEqual([{ namespaces: [{ name: "@acme", token: "rotated" }], version: 3 }]));
    });

    it("resets the registry, its token and the namespaces set here", async () => {
        let view = setByAdmin(integrationsView(), "pluginRegistry", "url", "https://npm.example.net/");
        view = setByAdmin(view, "pluginRegistry", "token", MASK);
        view = setByAdmin(view, "pluginRegistry", "namespaces", [{ name: "@acme" }]);
        const { puts } = mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        await user.click(await screen.findByRole("button", { name: "Reset registry URL to the deployment default" }));
        await user.click(screen.getByRole("button", { name: "Reset registry token to the deployment default" }));
        await user.click(screen.getByRole("button", { name: "Reset plugin namespaces to the deployment default" }));
        expect(screen.getByLabelText("Registry URL")).toHaveValue("https://registry.npmjs.org/");
        expect(screen.getByLabelText("Scope of namespace 1")).toHaveValue("@rapidmx");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body)).toEqual([{ url: null, token: null, namespaces: null, version: 3 }]));
    });

    it("offers no reset of a token the server reports cleared for a registry elsewhere", async () => {
        // The administrator's registry is another than the deployment's: its token is shown as none, set here (restapi's view), and nothing is saved here.
        const view = setByAdmin(setByAdmin(integrationsView(), "pluginRegistry", "url", "https://npm.example.net/"), "pluginRegistry", "token", null);
        view.pluginRegistry.defaults.token = MASK;
        mockIntegrations(view);
        renderPage();

        expect(await screen.findByLabelText("Registry token")).toHaveValue("");
        expect(screen.getByText(/The deployment’s tokens for its registry are only sent to the deployment’s registry/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Reset registry token to the deployment default" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Reset registry URL to the deployment default" })).toBeInTheDocument();
    });

    it("points plugins at another registry", async () => {
        const { puts } = mockIntegrations(integrationsView());
        const user = userEvent.setup();
        renderPage();

        await user.clear(await screen.findByLabelText("Registry URL"));
        await user.type(screen.getByLabelText("Registry URL"), "https://npm.example.net/");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body)).toEqual([{ url: "https://npm.example.net/", version: 3 }]));
    });

    it("says when the deployment sets no namespaces", async () => {
        const view = integrationsView();
        view.pluginRegistry.values.namespaces = [];
        view.pluginRegistry.defaults.namespaces = [];
        mockIntegrations(view);
        renderPage();

        expect(await screen.findByText("No namespaces: the plugin catalog searches none.")).toBeInTheDocument();
        // The token's and the namespaces'.
        expect(screen.getAllByText("Deployment default: none")).toHaveLength(2);
    });

    it("saves an emptied list", async () => {
        const { puts } = mockIntegrations(integrationsView());
        const user = userEvent.setup();
        renderPage();

        await user.click(await screen.findByRole("button", { name: "Remove namespace 1" }));
        expect(screen.getByText("No namespaces: the plugin catalog searches none.")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body)).toEqual([{ namespaces: [], version: 3 }]));
    });
});

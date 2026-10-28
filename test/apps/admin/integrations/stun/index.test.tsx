// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import StunPage from "../../../../../apps/admin/integrations/stun/index.js";
import { integrationsView, mockIntegrations, setByAdmin } from "../fixtures.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

const renderPage = () => render(<StunPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

describe("StunPage", () => {
    it("says meetings use the meet plugin's built-in servers while neither the deployment nor an administrator sets any", async () => {
        mockIntegrations(integrationsView());
        renderPage();

        expect(await screen.findByRole("heading", { name: "STUN servers" })).toBeInTheDocument();
        expect(screen.getByLabelText("STUN servers")).toHaveValue("");
        expect(screen.getByText("Deployment default: the meet plugin's built-in list")).toBeInTheDocument();
        expect(screen.getByText(/TURN servers stay in the Meet plugin’s settings/)).toBeInTheDocument();
    });

    it("saves one server per line, without blank lines or surrounding spaces", async () => {
        const { puts } = mockIntegrations(integrationsView());
        const user = userEvent.setup();
        renderPage();

        await user.type(await screen.findByLabelText("STUN servers"), "  stun:stun.example.com:3478 {Enter}{Enter}stuns:turn.example.com");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() =>
            expect(puts).toEqual([
                {
                    section: "stun",
                    body: { urls: ["stun:stun.example.com:3478", "stuns:turn.example.com"], version: 3 },
                },
            ])
        );
    });

    it("shows the servers set here one per line and the deployment's list beneath, and resets to it", async () => {
        const view = setByAdmin(integrationsView(), "stun", "urls", ["stun:a.example.com", "stun:b.example.com"]);
        view.stun.defaults.urls = ["stun:deploy.example.com"];
        const { puts } = mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findByLabelText("STUN servers")).toHaveValue("stun:a.example.com\nstun:b.example.com");
        expect(screen.getByText("Deployment default: stun:deploy.example.com")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Reset STUN servers to the deployment default" }));
        expect(screen.getByLabelText("STUN servers")).toHaveValue("stun:deploy.example.com");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body)).toEqual([{ urls: null, version: 3 }]));
    });

    it("takes an emptied list as the deployment's, rather than sending an empty one the server refuses", async () => {
        const { puts } = mockIntegrations(setByAdmin(integrationsView(), "stun", "urls", ["stun:a.example.com"]));
        const user = userEvent.setup();
        renderPage();

        await user.clear(await screen.findByLabelText("STUN servers"));
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body)).toEqual([{ urls: null, version: 3 }]));
    });

    it("saves nothing for a list typed into and emptied again while none is set here", async () => {
        const { puts } = mockIntegrations(integrationsView());
        const user = userEvent.setup();
        renderPage();

        await user.type(await screen.findByLabelText("STUN servers"), "s");
        await user.clear(screen.getByLabelText("STUN servers"));
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(puts).toEqual([]);
    });
});

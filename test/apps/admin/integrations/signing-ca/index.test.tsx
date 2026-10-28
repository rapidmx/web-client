// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import SigningCaPage from "../../../../../apps/admin/integrations/signing-ca/index.js";
import { integrationsView, mockIntegrations, setByAdmin } from "../fixtures.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

const renderPage = () => render(<SigningCaPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

describe("SigningCaPage", () => {
    it("shows how certificates are issued, the CA's directory and contact, and that a change affects new enrollments only", async () => {
        mockIntegrations(integrationsView());
        renderPage();

        expect(await screen.findByRole("heading", { name: "S/MIME signing CA" })).toBeInTheDocument();
        expect(screen.getByLabelText("How signing certificates are issued")).toHaveValue("manual");
        expect(screen.getByText("Deployment default: Manually, by an administrator")).toBeInTheDocument();
        expect(screen.getByLabelText("ACME directory URL")).toHaveValue("https://acme.example.org/directory");
        expect(screen.getByText("Deployment default: https://acme.example.org/directory")).toBeInTheDocument();
        expect(screen.getByLabelText("Contact email")).toHaveValue("");
        expect(screen.getByText("Deployment default: none")).toBeInTheDocument();
        expect(screen.getByText(/new enrollments only/)).toBeInTheDocument();
    });

    it("switches to RFC 8823 with a contact address, sending only what changed", async () => {
        const { puts } = mockIntegrations(integrationsView());
        const user = userEvent.setup();
        renderPage();

        await user.selectOptions(await screen.findByLabelText("How signing certificates are issued"), "rfc8823");
        await user.type(screen.getByLabelText("Contact email"), " pki@example.com ");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts).toEqual([{ section: "signingCa", body: { backend: "rfc8823", contactEmail: "pki@example.com", version: 3 } }]));
    });

    it("offers turning enrollment off, and resets each field set here", async () => {
        const view = setByAdmin(setByAdmin(integrationsView(), "signingCa", "backend", "none"), "signingCa", "contactEmail", "pki@example.com");
        const { puts } = mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findByLabelText("How signing certificates are issued")).toHaveValue("none");
        expect(screen.getByRole("option", { name: "Not offered" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Reset contact email to the deployment default" }));
        expect(screen.getByLabelText("Contact email")).toHaveValue("");
        await user.click(screen.getByRole("button", { name: "Reset certificate issuing to the deployment default" }));
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body)).toEqual([{ backend: null, contactEmail: null, version: 3 }]));
    });

    it("takes an emptied contact address as none, the deployment's when it sets none", async () => {
        const { puts } = mockIntegrations(setByAdmin(integrationsView(), "signingCa", "contactEmail", "pki@example.com"));
        const user = userEvent.setup();
        renderPage();

        await user.clear(await screen.findByLabelText("Contact email"));
        expect(screen.queryByText(/Left empty/)).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body)).toEqual([{ contactEmail: null, version: 3 }]));
    });

    it("says an emptied contact address falls back to the deployment's when it sets one", async () => {
        const view = setByAdmin(integrationsView(), "signingCa", "contactEmail", "ops@corp.example");
        view.signingCa.defaults.contactEmail = "pki@corp.example";
        const { puts } = mockIntegrations(view);
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findByText(/Left empty, the deployment's address \(pki@corp\.example\) is used\./)).toBeInTheDocument();
        await user.clear(screen.getByLabelText("Contact email"));
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body)).toEqual([{ contactEmail: null, version: 3 }]));
    });

    it("sends an emptied field as is, for the server to refuse", async () => {
        const { puts } = mockIntegrations(integrationsView());
        const user = userEvent.setup();
        renderPage();

        await user.clear(await screen.findByLabelText("ACME directory URL"));
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body)).toEqual([{ directoryUrl: "", version: 3 }]));
    });
});

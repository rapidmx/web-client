// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import TransportRuleDetailPage from "../../../../apps/admin/transport-rules/[uid].js";

const rule = {
    uid: "tr1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    name: "Flag external senders",
    enabled: true,
    sequence: 0,
    stopProcessingRules: false,
    conditions: { anyRecipientExternal: true },
    actions: [{ type: "add_header", headerName: "X-External", headerValue: "" }],
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("TransportRuleDetailPage", () => {
    it("renders the loaded rule's name, conditions, and actions in the rule builder", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/transport-rules/tr1") return jsonResponse(200, rule);
            throw new Error(`unexpected ${url}`);
        });
        render(<TransportRuleDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "tr1" }} />);

        expect(await screen.findByRole("heading", { name: "Flag external senders" })).toBeInTheDocument();
        expect(screen.getByLabelText("Name")).toHaveValue("Flag external senders");
        expect(screen.getByRole("checkbox", { name: "Any recipient is external" })).toBeChecked();
        expect(screen.getByLabelText("Header name")).toHaveValue("X-External");
    });

    it("renders empty fields for an action loaded with its optional value(s) unset, rather than 'undefined'", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/transport-rules/tr1") {
                return jsonResponse(200, {
                    ...rule,
                    conditions: {},
                    actions: [{ type: "add_header" }, { type: "add_recipient" }],
                });
            }
            throw new Error(`unexpected ${url}`);
        });
        render(<TransportRuleDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "tr1" }} />);

        expect(await screen.findByLabelText("Header name")).toHaveValue("");
        expect(screen.getByLabelText("Header value")).toHaveValue("");
        expect(screen.getByLabelText("Recipient address")).toHaveValue("");
    });

    it("validates the name before saving", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/transport-rules/tr1") return jsonResponse(200, rule);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<TransportRuleDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "tr1" }} />);
        await screen.findByLabelText("Name");

        await user.clear(screen.getByLabelText("Name"));
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("A name is required.")).toBeInTheDocument();
    });

    it("saves changes and shows a confirmation", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/transport-rules/tr1" && (init?.method ?? "GET") === "GET") {
                return jsonResponse(200, rule);
            }
            if (url === "/api/mail/transport-rules/tr1" && init?.method === "PUT") {
                return jsonResponse(200, { ...rule, version: 1, name: "Renamed rule" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<TransportRuleDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "tr1" }} />);
        await screen.findByLabelText("Name");

        await user.clear(screen.getByLabelText("Name"));
        await user.type(screen.getByLabelText("Name"), "Renamed rule");
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Renamed rule" })).toBeInTheDocument();
    });

    it("shows an error message when saving fails, without discarding the loaded rule", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/transport-rules/tr1" && (init?.method ?? "GET") === "GET") {
                return jsonResponse(200, rule);
            }
            if (url === "/api/mail/transport-rules/tr1" && init?.method === "PUT") {
                return jsonResponse(409, { message: "version conflict" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<TransportRuleDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "tr1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("version conflict")).toBeInTheDocument();
        expect(screen.getByLabelText("Name")).toHaveValue("Flag external senders");
    });

    it("shows a generic error message when saving fails with a non-API error", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/transport-rules/tr1" && (init?.method ?? "GET") === "GET") {
                return jsonResponse(200, rule);
            }
            if (url === "/api/mail/transport-rules/tr1" && init?.method === "PUT") {
                throw new TypeError("network down");
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<TransportRuleDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "tr1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("Could not save this transport rule.")).toBeInTheDocument();
    });

    it("shows an error message when the rule fails to load", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(404, { message: "not found" });
        });
        render(<TransportRuleDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "tr1" }} />);
        expect(await screen.findByText("not found")).toBeInTheDocument();
    });

    it("shows a generic error message when loading the rule fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        render(<TransportRuleDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "tr1" }} />);
        expect(await screen.findByText("Could not load this transport rule.")).toBeInTheDocument();
    });

    it("falls back to 'Transport rule not found.' when the load succeeds with no rule and no error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/transport-rules/tr1") return jsonResponse(200, null);
            throw new Error(`unexpected ${url}`);
        });
        render(<TransportRuleDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "tr1" }} />);
        expect(await screen.findByText("Transport rule not found.")).toBeInTheDocument();
    });
});

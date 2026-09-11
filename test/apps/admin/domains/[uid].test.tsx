// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch, mockLocation } from "../../testUtils.js";
import DomainDetailPage from "../../../../apps/admin/domains/[uid].js";

// jsdom's `navigator.clipboard` is a getter-only property — `Object.assign` throws against it, so
// `writeText` must be installed via `defineProperty` instead.
function mockClipboard(writeText: ReturnType<typeof vi.fn>): void {
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

const domain = {
    uid: "example.com",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    name: "example.com",
    enabled: true,
    verified: false,
    verificationToken: "tok123",
    lastCheckedAt: undefined,
};

const dnsSetup = [
    {
        type: "ownership",
        recordKind: "TXT",
        recordName: "example.com",
        configured: true,
        recommendedValue: "rapidmx-domain-verification=tok123",
        found: false,
        matches: false,
    },
    {
        type: "mx",
        recordKind: "MX",
        recordName: "example.com",
        configured: true,
        recommendedValue: "mail.example.com",
        found: true,
        matches: true,
    },
    {
        type: "dkim",
        recordKind: "TXT",
        recordName: "default._domainkey.example.com",
        configured: false,
        found: false,
        matches: false,
    },
];

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("DomainDetailPage", () => {
    it("renders domain details, the TXT record block, and the DNS setup checklist for an unverified, disabled domain", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, { ...domain, enabled: false });
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, dnsSetup);
            throw new Error(`unexpected ${url}`);
        });
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);

        expect(await screen.findByRole("heading", { name: "example.com" })).toBeInTheDocument();
        expect(screen.getByText("No")).toBeInTheDocument();
        expect(screen.getByText("Unverified")).toBeInTheDocument();
        expect(screen.getByText("Never")).toBeInTheDocument();
        // Appears twice: the copy-able TXT block above, and the DNS setup checklist's ownership row below.
        expect(screen.getAllByText("rapidmx-domain-verification=tok123")).toHaveLength(2);
        expect(screen.getByRole("button", { name: "Verify now" })).toBeInTheDocument();

        expect(screen.getByText("DNS setup checklist")).toBeInTheDocument();
        expect(screen.getByText("Ownership (TXT)")).toBeInTheDocument();
        expect(screen.getByText("MX")).toBeInTheDocument();
        expect(screen.getByText("Live")).toBeInTheDocument();
        expect(screen.getByText("Not found")).toBeInTheDocument();
        expect(screen.getByText("Not configured")).toBeInTheDocument();
    });

    it("falls back to building the TXT value from the domain's own verificationToken when the DNS setup checklist has no ownership entry", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        const writeText = vi.fn().mockResolvedValue(undefined);
        const user = userEvent.setup();
        mockClipboard(writeText);
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);

        expect(await screen.findByText("rapidmx-domain-verification=tok123")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Copy" }));
        expect(writeText).toHaveBeenCalledWith("rapidmx-domain-verification=tok123");
    });

    it("hides the TXT record block and Verify button once the domain is verified", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") {
                return jsonResponse(200, { ...domain, verified: true, lastCheckedAt: "2026-02-01T00:00:00.000Z" });
            }
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);

        expect(await screen.findByText("Verified")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Verify now" })).not.toBeInTheDocument();
        expect(screen.queryByText("DNS setup checklist")).not.toBeInTheDocument();
    });

    it("copies the TXT record value to the clipboard", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, dnsSetup);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        mockClipboard(writeText);
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);

        await user.click(await screen.findByRole("button", { name: "Copy" }));
        expect(writeText).toHaveBeenCalledWith("rapidmx-domain-verification=tok123");
        expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    });

    it("reverts the 'Copied' confirmation back to 'Copy' after a couple of seconds", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const writeText = vi.fn().mockResolvedValue(undefined);
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, dnsSetup);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        mockClipboard(writeText);
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);

        await user.click(await screen.findByRole("button", { name: "Copy" }));
        expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();

        await act(() => vi.advanceTimersByTimeAsync(2000));
        expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    });

    it("silently ignores a clipboard write failure", async () => {
        const writeText = vi.fn().mockRejectedValue(new Error("denied"));
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, dnsSetup);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        mockClipboard(writeText);
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);

        await user.click(await screen.findByRole("button", { name: "Copy" }));
        expect(writeText).toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
    });

    it("verifies the domain and reloads its (now verified) state", async () => {
        let verifyCalled = false;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com/verify" && init?.method === "POST") {
                verifyCalled = true;
                return jsonResponse(200, { ...domain, verified: true });
            }
            if (url === "/api/mail/domains/example.com") {
                return jsonResponse(200, verifyCalled ? { ...domain, verified: true } : domain);
            }
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, []);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);

        await user.click(await screen.findByRole("button", { name: "Verify now" }));
        expect(await screen.findByText("Verified")).toBeInTheDocument();
    });

    it("shows an error message when verification fails", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, []);
            if (url === "/api/mail/domains/example.com/verify" && init?.method === "POST") {
                return jsonResponse(500, { message: "DNS lookup failed" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);

        await user.click(await screen.findByRole("button", { name: "Verify now" }));
        expect(await screen.findByText("DNS lookup failed")).toBeInTheDocument();
    });

    it("shows a generic error message when verification fails with a non-API error", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, []);
            if (url === "/api/mail/domains/example.com/verify" && init?.method === "POST") {
                throw new TypeError("network down");
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);

        await user.click(await screen.findByRole("button", { name: "Verify now" }));
        expect(await screen.findByText("Could not verify this domain.")).toBeInTheDocument();
    });

    it("shows an error message when the domain fails to load", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(404, { message: "not found" });
        });
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);
        expect(await screen.findByText("not found")).toBeInTheDocument();
    });

    it("shows a generic error message when loading the domain fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);
        expect(await screen.findByText("Could not load this domain.")).toBeInTheDocument();
    });

    it("falls back to 'Domain not found.' when the load succeeds with no domain and no error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, null);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);
        expect(await screen.findByText("Domain not found.")).toBeInTheDocument();
    });

    it("closes the delete confirmation modal on Cancel without deleting", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);

        await user.click(await screen.findByRole("button", { name: "Delete domain" }));
        const dialog = within(screen.getByRole("dialog", { name: "Delete domain" }));
        await user.click(dialog.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog", { name: "Delete domain" })).not.toBeInTheDocument();
    });

    it("shows an error message in the modal when deletion fails", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, []);
            if (url === "/api/mail/domains/example.com?version=0" && init?.method === "DELETE") {
                return jsonResponse(409, { message: "Domain still has active mailboxes." });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);

        await user.click(await screen.findByRole("button", { name: "Delete domain" }));
        const dialog = within(screen.getByRole("dialog", { name: "Delete domain" }));
        await user.click(dialog.getByRole("button", { name: "Delete" }));
        expect(await dialog.findByText("Domain still has active mailboxes.")).toBeInTheDocument();
    });

    it("shows a generic error message in the modal when deletion fails with a non-API error", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, []);
            if (url === "/api/mail/domains/example.com?version=0" && init?.method === "DELETE") {
                throw new TypeError("network down");
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);

        await user.click(await screen.findByRole("button", { name: "Delete domain" }));
        const dialog = within(screen.getByRole("dialog", { name: "Delete domain" }));
        await user.click(dialog.getByRole("button", { name: "Delete" }));
        expect(await dialog.findByText("Could not delete this domain.")).toBeInTheDocument();
    });

    // Mocks window.location wholesale (see testUtils.mockLocation), which isn't undone between tests
    // (unlike vi.stubGlobal) — must run last in this file, same convention as mailboxes/[uid]'s own
    // impersonation-redirect test.
    it("opens a confirmation modal from 'Delete domain', deletes the domain, and navigates back to the list", async () => {
        let deleteCalled = false;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, []);
            if (url === "/api/mail/domains/example.com?version=0" && init?.method === "DELETE") {
                deleteCalled = true;
                return emptyResponse(200);
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);

        const deleteButton = await screen.findByRole("button", { name: "Delete domain" });
        const location = mockLocation();
        await user.click(deleteButton);
        const dialog = within(screen.getByRole("dialog", { name: "Delete domain" }));
        expect(dialog.getByText(/Are you sure you want to delete/)).toBeInTheDocument();

        await user.click(dialog.getByRole("button", { name: "Delete" }));
        expect(deleteCalled).toBe(true);
        await vi.waitFor(() => expect(location.href).toBe("/admin/domains"));
    });
});

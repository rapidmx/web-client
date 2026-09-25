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
function mockClipboard(writeText: ReturnType<typeof vi.fn> | undefined): void {
    Object.defineProperty(navigator, "clipboard", { value: writeText ? { writeText } : undefined, configurable: true });
}

/** jsdom implements no `document.execCommand`; the copy fallback needs one. */
function mockExecCommand(impl: (() => boolean) | undefined): ReturnType<typeof vi.fn> | undefined {
    const mock = impl ? vi.fn(impl) : undefined;
    Object.defineProperty(document, "execCommand", { value: mock, configurable: true, writable: true });
    return mock;
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
    mockClipboard(undefined);
    mockExecCommand(undefined);
});

// A domain with every record type configured, MX in its real "<priority> <server>" form and a long DKIM key.
const DKIM_VALUE = `v=DKIM1; k=rsa; p=${"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A".repeat(8)}`;
const fullDnsSetup = [
    { ...dnsSetup[0] },
    { type: "mx", recordKind: "MX", recordName: "example.com", configured: true, recommendedValue: "10 mx.example.net", found: false, matches: false },
    { type: "spf", recordKind: "TXT", recordName: "example.com", configured: true, recommendedValue: "v=spf1 mx ~all", found: false, matches: false },
    {
        type: "dkim",
        recordKind: "TXT",
        recordName: "default._domainkey.example.com",
        configured: true,
        recommendedValue: DKIM_VALUE,
        found: false,
        matches: false,
    },
    {
        type: "dmarc",
        recordKind: "TXT",
        recordName: "_dmarc.example.com",
        configured: true,
        recommendedValue: "v=DMARC1; p=none;",
        found: false,
        matches: false,
    },
    {
        type: "autodiscover_cname",
        recordKind: "CNAME",
        recordName: "autodiscover.example.com",
        configured: true,
        recommendedValue: "mail.example.com",
        found: false,
        matches: false,
    },
    {
        type: "autodiscover_srv",
        recordKind: "SRV",
        recordName: "_autodiscover._tcp.example.com",
        configured: true,
        recommendedValue: "0 0 443 mail.example.com",
        found: false,
        matches: false,
    },
];

function renderDomainPage() {
    return render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);
}

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

    it("falls back to building the TXT value and name from the domain itself when the DNS setup checklist has no ownership entry", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        const writeText = vi.fn().mockResolvedValue(undefined);
        const user = userEvent.setup();
        mockClipboard(writeText);
        renderDomainPage();

        expect(await screen.findByText("rapidmx-domain-verification=tok123")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Copy value for the ownership TXT record" }));
        expect(writeText).toHaveBeenLastCalledWith("rapidmx-domain-verification=tok123");
        await user.click(screen.getByRole("button", { name: "Copy name for the ownership TXT record" }));
        expect(writeText).toHaveBeenLastCalledWith("example.com");
    });

    it("uses the ownership record's own name, when the server names one, for the TXT record to add", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, [{ ...dnsSetup[0], recordName: "_verify.example.com" }]);
            throw new Error(`unexpected ${url}`);
        });
        const writeText = vi.fn().mockResolvedValue(undefined);
        const user = userEvent.setup();
        mockClipboard(writeText);
        renderDomainPage();

        await user.click(await screen.findAllByRole("button", { name: "Copy name for the ownership TXT record" }).then((buttons) => buttons[0]));
        expect(writeText).toHaveBeenCalledWith("_verify.example.com");
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

    it("puts a Copy button on every value to type into a DNS form: each record's name, value, and an MX record's priority and server", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, fullDnsSetup);
            throw new Error(`unexpected ${url}`);
        });
        const writeText = vi.fn().mockResolvedValue(undefined);
        const user = userEvent.setup();
        mockClipboard(writeText);
        renderDomainPage();
        await screen.findByText("DNS setup checklist");
        // The name column keeps a floor, so a long DKIM key beside it can't squeeze a record name into one letter per line.
        expect(screen.getByRole("button", { name: "Copy name for the DKIM record" }).closest("td")?.className).toContain("min-w-[10rem]");

        const expected: Array<[string, string]> = [
            // The TXT block above the checklist.
            ["Copy name for the ownership TXT record", "example.com"],
            ["Copy value for the ownership TXT record", "rapidmx-domain-verification=tok123"],
            // The checklist: the ownership row appears in both places.
            ["Copy priority for the MX record", "10"],
            ["Copy mail server for the MX record", "mx.example.net"],
            ["Copy name for the SPF record", "example.com"],
            ["Copy value for the SPF record", "v=spf1 mx ~all"],
            ["Copy name for the DKIM record", "default._domainkey.example.com"],
            ["Copy value for the DKIM record", DKIM_VALUE],
            ["Copy name for the DMARC record", "_dmarc.example.com"],
            ["Copy value for the DMARC record", "v=DMARC1; p=none;"],
            ["Copy name for the Autodiscover CNAME record", "autodiscover.example.com"],
            ["Copy value for the Autodiscover CNAME record", "mail.example.com"],
            ["Copy name for the Autodiscover SRV record", "_autodiscover._tcp.example.com"],
            ["Copy priority for the Autodiscover SRV record", "0"],
            ["Copy weight for the Autodiscover SRV record", "0"],
            ["Copy port for the Autodiscover SRV record", "443"],
            ["Copy target for the Autodiscover SRV record", "mail.example.com"],
        ];
        for (const [name, value] of expected) {
            const button = screen.getAllByRole("button", { name })[0];
            await user.click(button);
            expect(writeText).toHaveBeenLastCalledWith(value);
        }
        // Nothing else offers a copy: ownership's two buttons appear twice (block and checklist row), the MX row has a name,
        // a priority and a server button but no whole-value one, each of SPF/DKIM/DMARC/the autodiscover CNAME has a name
        // and a value button, and the autodiscover SRV row has a name plus its four split fields.
        expect(screen.getAllByRole("button", { name: /^Copy / })).toHaveLength(2 + 2 + 3 + 2 + 2 + 2 + 2 + 5);
        expect(screen.queryByRole("button", { name: "Copy value for the MX record" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Copy value for the Autodiscover SRV record" })).not.toBeInTheDocument();
        expect(screen.getByText(/Some DNS providers want the name relative/)).toBeInTheDocument();
        // The two autodiscover rows get a "why this matters" explanation the well-known record types don't.
        expect(screen.getByText(/So EAS and Outlook clients can find this server automatically/)).toBeInTheDocument();
        expect(screen.getByText(/needs no extra TLS certificate/)).toBeInTheDocument();
    });

    it("copies a malformed autodiscover SRV value whole instead of splitting it into fields", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") {
                return jsonResponse(200, [
                    {
                        type: "autodiscover_srv",
                        recordKind: "SRV",
                        recordName: "_autodiscover._tcp.example.com",
                        configured: true,
                        recommendedValue: "not-a-valid-srv-value",
                        found: false,
                        matches: false,
                    },
                ]);
            }
            throw new Error(`unexpected ${url}`);
        });
        const writeText = vi.fn().mockResolvedValue(undefined);
        const user = userEvent.setup();
        mockClipboard(writeText);
        renderDomainPage();

        await user.click(await screen.findByRole("button", { name: "Copy value for the Autodiscover SRV record" }));
        expect(writeText).toHaveBeenLastCalledWith("not-a-valid-srv-value");
        expect(screen.queryByRole("button", { name: /priority/i })).not.toBeInTheDocument();
    });

    it("shows each record's type and name, and leaves a dash where there is nothing to copy yet", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, dnsSetup.map((c) => (c.type === "dkim" ? { ...c, recordName: "" } : c)));
            throw new Error(`unexpected ${url}`);
        });
        renderDomainPage();
        await screen.findByText("DNS setup checklist");

        const table = within(screen.getByRole("table"));
        expect(table.getByText("Name / host", { selector: "th" })).toBeInTheDocument();
        expect(table.getAllByText("Type: TXT")).toHaveLength(2);
        expect(table.getByText("Type: MX")).toBeInTheDocument();
        // The unconfigured DKIM row has no name and no value: no Copy buttons, dashes instead.
        expect(table.getAllByText("\u2014")).toHaveLength(2);
        expect(table.queryByRole("button", { name: /DKIM/ })).not.toBeInTheDocument();
        // An MX value with no priority is copied whole.
        expect(table.getByRole("button", { name: "Copy value for the MX record" })).toBeInTheDocument();
        expect(table.queryByRole("button", { name: /priority/ })).not.toBeInTheDocument();
    });

    it("says Copied in a live region next to the button that was used, then goes quiet after a couple of seconds", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, dnsSetup);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        mockClipboard(vi.fn().mockResolvedValue(undefined));
        renderDomainPage();

        const button = (await screen.findAllByRole("button", { name: "Copy value for the ownership TXT record" }))[0];
        await user.click(button);
        const status = button.parentElement!.querySelector("[role=status]")!;
        expect(status).toHaveAttribute("aria-live", "polite");
        expect(status).toHaveTextContent("Copied");
        // The other buttons say nothing.
        expect(screen.getAllByText("Copied")).toHaveLength(1);

        await act(() => vi.advanceTimersByTimeAsync(2000));
        expect(status).toBeEmptyDOMElement();
    });

    it("falls back to the legacy copy command when the async clipboard rejects", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, dnsSetup);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        mockClipboard(vi.fn().mockRejectedValue(new Error("denied")));
        const exec = mockExecCommand(() => true)!;
        renderDomainPage();

        const button = (await screen.findAllByRole("button", { name: "Copy value for the ownership TXT record" }))[0];
        await user.click(button);
        expect(exec).toHaveBeenCalledWith("copy");
        expect(await screen.findByText("Copied")).toBeInTheDocument();
    });

    it("falls back to the legacy copy command when there is no async clipboard at all", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, dnsSetup);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        mockClipboard(undefined);
        const exec = mockExecCommand(() => true)!;
        renderDomainPage();

        const button = (await screen.findAllByRole("button", { name: "Copy name for the ownership TXT record" }))[0];
        await user.click(button);
        expect(exec).toHaveBeenCalledWith("copy");
        expect(await screen.findByText("Copied")).toBeInTheDocument();
    });

    it("says it could not copy when neither the clipboard nor the legacy command works, leaving the value on screen to select", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, dnsSetup);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        mockClipboard(vi.fn().mockRejectedValue(new Error("denied")));
        mockExecCommand(() => false);
        renderDomainPage();

        const button = (await screen.findAllByRole("button", { name: "Copy value for the ownership TXT record" }))[0];
        await user.click(button);
        expect(await screen.findByText("Couldn\u2019t copy")).toBeInTheDocument();
        expect(screen.queryByText("Copied")).not.toBeInTheDocument();
        expect(screen.getAllByText("rapidmx-domain-verification=tok123")).toHaveLength(2);
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

    it("shows a verification failure beside the button, keeps the panel, and lets it be retried", async () => {
        let attempts = 0;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, attempts > 1 ? { ...domain, verified: true } : domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, []);
            if (url === "/api/mail/domains/example.com/verify" && init?.method === "POST") {
                attempts++;
                return attempts === 1 ? jsonResponse(500, { message: "DNS lookup failed" }) : jsonResponse(200, { ...domain, verified: true });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);

        await user.click(await screen.findByRole("button", { name: "Verify now" }));
        expect(await screen.findByText("DNS lookup failed")).toBeInTheDocument();
        expect(screen.getByText("rapidmx-domain-verification=tok123")).toBeInTheDocument();
        expect(screen.getByText("Unverified")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByText("Verified")).toBeInTheDocument();
        expect(screen.queryByText("DNS lookup failed")).not.toBeInTheDocument();
    });

    it("keeps the panel when refreshing after a successful verification fails", async () => {
        let verified = false;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com/verify" && init?.method === "POST") {
                verified = true;
                return jsonResponse(200, domain);
            }
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") {
                if (verified) throw new TypeError("network down");
                return jsonResponse(200, []);
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);

        await user.click(await screen.findByRole("button", { name: "Verify now" }));
        expect(await screen.findByText("Could not verify this domain.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
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

    it("shows an 'Alias of' row in the status panel once the domain has one", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, { ...domain, verified: true, aliasOf: "powerlevel.gg" });
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        renderDomainPage();

        expect(await screen.findByText("Alias of", { selector: "dt" })).toBeInTheDocument();
        expect(screen.getByText(/powerlevel\.gg/)).toBeInTheDocument();
    });

    it("saves a new Alias of value and reflects it in the status panel", async () => {
        let updateBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com" && init?.method === "PUT") {
                updateBody = JSON.parse(init.body as string);
                return jsonResponse(200, { ...domain, aliasOf: "powerlevel.gg", version: 1 });
            }
            if (url === "/api/mail/domains/example.com") {
                return jsonResponse(200, updateBody ? { ...domain, aliasOf: "powerlevel.gg", version: 1 } : domain);
            }
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, []);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        renderDomainPage();

        const input = await screen.findByLabelText("Alias of");
        const saveButton = screen.getByRole("button", { name: "Save" });
        expect(saveButton).toBeDisabled();

        await user.type(input, "powerlevel.gg");
        expect(saveButton).toBeEnabled();
        await user.click(saveButton);

        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(updateBody).toEqual({ uid: "example.com", version: 0, aliasOf: "powerlevel.gg" });
        expect(await screen.findByText(/powerlevel\.gg/)).toBeInTheDocument();
    });

    it("clearing Alias of back to blank sends aliasOf: undefined", async () => {
        let updateBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com" && init?.method === "PUT") {
                updateBody = JSON.parse(init.body as string);
                return jsonResponse(200, { ...domain, version: 1 });
            }
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, { ...domain, aliasOf: "powerlevel.gg" });
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, []);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        renderDomainPage();

        const input = await screen.findByLabelText("Alias of");
        await vi.waitFor(() => expect(input).toHaveValue("powerlevel.gg"));
        await user.clear(input);
        await user.click(screen.getByRole("button", { name: "Save" }));

        await vi.waitFor(() => expect(updateBody).toEqual({ uid: "example.com", version: 0, aliasOf: undefined }));
    });

    it("shows an error message when saving Alias of fails", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com" && init?.method === "PUT") {
                return jsonResponse(400, { message: "'no-such-domain.gg' is not a domain known to this server - add it first." });
            }
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, []);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        renderDomainPage();

        const input = await screen.findByLabelText("Alias of");
        await user.type(input, "no-such-domain.gg");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("'no-such-domain.gg' is not a domain known to this server - add it first.")).toBeInTheDocument();
    });

    it("shows a generic message, and keeps the typed value, when saving Alias of fails without an API error", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains/example.com" && init?.method === "PUT") throw new TypeError("network down");
            if (url === "/api/mail/domains/example.com") return jsonResponse(200, domain);
            if (url === "/api/mail/domains/example.com/dns-setup") return jsonResponse(200, []);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        renderDomainPage();

        const input = await screen.findByLabelText("Alias of");
        await user.type(input, "powerlevel.gg");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Could not update this domain.")).toBeInTheDocument();
        expect(input).toHaveValue("powerlevel.gg");
        expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
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

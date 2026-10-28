// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The domain page's DKIM rotation panel (spec dns_publishing_and_integrations.md, 6.2 and 14): the phase and its next step, "Rotate now", "Key compromised",
// "Cancel rotation", the pause, and the record a manual domain publishes by hand.
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import DomainDetailPageBase from "../../../../apps/admin/domains/[uid].js";
import { withTestRouter } from "../../routerTestUtils.js";

const DomainDetailPage = withTestRouter(DomainDetailPageBase);

afterEach(() => {
    vi.unstubAllGlobals();
});

const DAY = 24 * 60 * 60 * 1000;
const ELEVATION = { code: "api-104", message: "Requires elevation." };

/** An ISO date `days` days before now (negative: after). */
function daysAgo(days: number): string {
    return new Date(Date.now() - days * DAY).toISOString();
}

function dateOf(iso: string): string {
    return new Date(iso).toLocaleDateString();
}

const domain = {
    uid: "example.com",
    version: 2,
    dateCreated: daysAgo(400),
    dateModified: daysAgo(1),
    name: "example.com",
    enabled: true,
    verified: true,
    verificationToken: "tok123",
    dkimSelector: "default",
    dkimPublicKey: "OLDKEY",
};

function check(type: string, over: Record<string, unknown> = {}) {
    const names: Record<string, string> = {
        dkim: "default._domainkey.example.com",
        dkim_next: "rmx20260601._domainkey.example.com",
        dkim_previous: "default._domainkey.example.com",
    };
    return {
        type,
        recordKind: "TXT",
        recordName: names[type] ?? `${type}.example.com`,
        configured: true,
        recommendedValue: `v=DKIM1; k=rsa; p=${type}`,
        found: true,
        matches: true,
        ...over,
    };
}

const next = { selector: "rmx20260601", publicKey: "NEWKEY", createdAt: daysAgo(1), reason: "manual" };

interface Api {
    domain?: Record<string, unknown>;
    /** What `GET /:id/dkim/rotation` answers, a response, or a function of the request count. */
    rotation?: unknown | Response | (() => unknown);
    checks?: unknown[];
    /** Answers to the writes, by `METHOD path`; a write not listed answers the domain. */
    writes?: Record<string, (body: any) => Response>;
}

/** Serves the admin shell's checks and the domain routes; every request is recorded in `calls`. */
function mockApi(api: Api = {}) {
    const calls: { method: string; url: string; body?: any }[] = [];
    const own = "/api/mail/domains/example.com";
    mockFetch((url, init) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        if (url === "/api/system/setup") return jsonResponse(200, { required: false });
        if (url.startsWith("/api/")) calls.push({ method, url: url.replace("/api", ""), body });
        const current = { ...domain, ...api.domain };
        if (method === "GET" && url === own) return jsonResponse(200, current);
        if (method === "GET" && url === `${own}/dns-setup`) return jsonResponse(200, api.checks ?? [check("dkim")]);
        if (method === "GET" && url === "/api/system/dns-providers") return jsonResponse(404, { code: "api-102", message: "Not found" });
        if (method === "GET" && url === `${own}/dkim/rotation`) {
            const view = typeof api.rotation === "function" ? (api.rotation as () => unknown)() : api.rotation;
            if (view instanceof Response) return view.clone();
            return view === undefined ? jsonResponse(404, { code: "api-102", message: "Not found" }) : jsonResponse(200, view);
        }
        const write = api.writes?.[`${method} ${url.replace("/api", "")}`];
        if (write) return write(body);
        return jsonResponse(200, current);
    });
    return calls;
}

function renderPage() {
    return render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "example.com" }} />);
}

async function panel(): Promise<ReturnType<typeof within>> {
    return within((await screen.findByRole("heading", { name: "DKIM key rotation" })).closest("div")!);
}

describe("the panel's availability", () => {
    it("is left out where the server has no rotation route", async () => {
        mockApi({});
        renderPage();
        await screen.findByText("DNS setup checklist");
        expect(screen.queryByRole("heading", { name: "DKIM key rotation" })).not.toBeInTheDocument();
    });

    it("keeps the card and offers to try again when the first read fails for any reason but a missing route", async () => {
        const user = userEvent.setup();
        let reads = 0;
        mockApi({
            rotation: () => {
                reads += 1;
                return reads === 1 ? jsonResponse(503, { code: "api-100", message: "Unavailable" }) : { rotation: { phase: "idle" }, rotatable: true };
            },
        });
        renderPage();
        const dkim = await panel();
        expect(await dkim.findByText("Could not load the DKIM rotation.")).toBeInTheDocument();
        expect(dkim.queryByRole("button", { name: "Rotate now" })).not.toBeInTheDocument();

        await user.click(dkim.getByRole("button", { name: "Reload the rotation" }));
        expect(await dkim.findByRole("button", { name: "Rotate now" })).toBeInTheDocument();
        expect(dkim.queryByText("Could not load the DKIM rotation.")).not.toBeInTheDocument();
    });

    it.each([
        ["unsupported", /key provider doesn't rotate keys/],
        ["ses", /Amazon SES.*rotates its own keys/],
        ["no_key", /no DKIM key yet/],
        ["imported", /imported by hand/],
        ["unknown_key", /can't tell whether it holds this domain's key/],
    ])("says why a domain whose key is %s can't rotate, and offers nothing to do", async (blocker, reason) => {
        mockApi({ rotation: { rotation: null, rotatable: false, blocker } });
        renderPage();
        const dkim = await panel();
        expect(dkim.getByText(reason)).toBeInTheDocument();
        expect(dkim.queryByRole("button")).not.toBeInTheDocument();
    });
});

describe("while no rotation is in progress", () => {
    const idle = (over: Record<string, unknown> = {}, rotation: Record<string, unknown> = {}) => ({
        rotation: { phase: "idle", lastRotatedAt: daysAgo(100), ...rotation },
        rotatable: true,
        nextScheduledAt: daysAgo(-80),
        ...over,
    });

    it("shows the active selector and its age, when the next rotation is due, and the actions", async () => {
        mockApi({ rotation: idle() });
        renderPage();
        const dkim = await panel();
        expect(dkim.getByText("default", { selector: "code" })).toBeInTheDocument();
        expect(dkim.getByText(/in use for 100 days/)).toBeInTheDocument();
        expect(dkim.getByText(/No rotation is in progress/)).toBeInTheDocument();
        expect(dkim.getByText(new RegExp(`Next scheduled rotation: ${dateOf(daysAgo(-80))}`))).toBeInTheDocument();
        expect(dkim.getByRole("button", { name: "Rotate now" })).toBeInTheDocument();
        expect(dkim.getByRole("button", { name: "Key compromised: rotate now" })).toBeInTheDocument();
        expect(dkim.getByRole("button", { name: "Pause scheduled rotation" })).toBeInTheDocument();
        expect(dkim.queryByRole("button", { name: "Cancel rotation" })).not.toBeInTheDocument();
    });

    it("counts the key's age from the domain's creation when it has never rotated", async () => {
        mockApi({ rotation: idle({}, { lastRotatedAt: undefined }) });
        renderPage();
        expect((await panel()).getByText(/in use for 400 days/)).toBeInTheDocument();
    });

    it("says no rotation is scheduled when the server gives no date", async () => {
        mockApi({ rotation: idle({ nextScheduledAt: undefined }) });
        renderPage();
        expect((await panel()).getByText(/No rotation is scheduled/)).toBeInTheDocument();
    });

    it("says scheduled rotation is paused and offers to resume it", async () => {
        const user = userEvent.setup();
        const calls = mockApi({ rotation: idle({ nextScheduledAt: undefined }, { paused: true }) });
        renderPage();
        const dkim = await panel();
        expect(dkim.getByText(/Scheduled rotation is paused/)).toBeInTheDocument();
        expect(dkim.queryByRole("button", { name: "Pause scheduled rotation" })).not.toBeInTheDocument();
        await user.click(dkim.getByRole("button", { name: "Resume scheduled rotation" }));
        await waitFor(() => expect(calls.find((call) => call.method === "PUT")).toEqual({ method: "PUT", url: "/mail/domains/example.com/dkim/rotation", body: { paused: false } }));
    });

    it("pauses scheduled rotation", async () => {
        const user = userEvent.setup();
        const calls = mockApi({ rotation: idle() });
        renderPage();
        await user.click((await panel()).getByRole("button", { name: "Pause scheduled rotation" }));
        await waitFor(() => expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ paused: true }));
    });

    it("starts a rotation with Rotate now, then shows the rotation and loads the checklist again", async () => {
        const user = userEvent.setup();
        let started = false;
        const calls = mockApi({
            rotation: () => (started ? { rotation: { phase: "pending", next }, rotatable: true } : idle()),
            writes: {
                "POST /mail/domains/example.com/dkim/rotate": () => {
                    started = true;
                    return jsonResponse(200, { ...domain, dkimRotation: { phase: "pending", next } });
                },
            },
        });
        renderPage();
        const dkim = await panel();
        await screen.findByText("DNS setup checklist");
        const before = calls.filter((call) => call.url.endsWith("/dns-setup")).length;
        await user.click(dkim.getByRole("button", { name: "Rotate now" }));

        expect(await dkim.findByText(/Waiting for the new record/)).toBeInTheDocument();
        expect(calls.find((call) => call.method === "POST")).toEqual({ method: "POST", url: "/mail/domains/example.com/dkim/rotate", body: {} });
        await waitFor(() => expect(calls.filter((call) => call.url.endsWith("/dns-setup")).length).toBe(before + 1));
        expect(dkim.queryByRole("button", { name: "Rotate now" })).not.toBeInTheDocument();
    });

    it("shows the server's reason when Rotate now is refused, and keeps the buttons", async () => {
        const user = userEvent.setup();
        mockApi({
            rotation: idle(),
            writes: { "POST /mail/domains/example.com/dkim/rotate": () => jsonResponse(409, { code: "api-109", message: "A DKIM key rotation is already in progress for this domain." }) },
        });
        renderPage();
        const dkim = await panel();
        await user.click(dkim.getByRole("button", { name: "Rotate now" }));
        expect(await dkim.findByText(/already in progress/)).toBeInTheDocument();
        expect(dkim.getByRole("button", { name: "Rotate now" })).toBeEnabled();
    });

    it("says to confirm the identity again when the action needs an elevated token", async () => {
        const user = userEvent.setup();
        mockApi({ rotation: idle(), writes: { "PUT /mail/domains/example.com/dkim/rotation": () => jsonResponse(403, ELEVATION) } });
        renderPage();
        await user.click((await panel()).getByRole("button", { name: "Pause scheduled rotation" }));
        expect(await screen.findByText(/recently confirmed your identity/)).toBeInTheDocument();
    });

    it("asks before rotating for a compromised key, and sends the flag only when confirmed", async () => {
        const user = userEvent.setup();
        const calls = mockApi({ rotation: idle() });
        renderPage();
        const dkim = await panel();

        await user.click(dkim.getByRole("button", { name: "Key compromised: rotate now" }));
        let dialog = within(screen.getByRole("dialog", { name: "Key compromised" }));
        expect(dialog.getByText(/publish wait is skipped/)).toBeInTheDocument();
        await user.click(dialog.getByRole("button", { name: "Back" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(calls.some((call) => call.method === "POST")).toBe(false);

        await user.click(dkim.getByRole("button", { name: "Key compromised: rotate now" }));
        dialog = within(screen.getByRole("dialog", { name: "Key compromised" }));
        await user.click(dialog.getByRole("button", { name: "Confirm" }));
        await waitFor(() => expect(calls.find((call) => call.method === "POST")?.body).toEqual({ compromised: true }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("keeps the dialog open with the reason when the compromised rotation is refused", async () => {
        const user = userEvent.setup();
        mockApi({
            rotation: idle(),
            writes: { "POST /mail/domains/example.com/dkim/rotate": () => jsonResponse(409, { code: "api-109", message: "This domain's DKIM key was imported by hand, so RapidMX can't rotate it." }) },
        });
        renderPage();
        await user.click((await panel()).getByRole("button", { name: "Key compromised: rotate now" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
        expect(await within(screen.getByRole("dialog")).findByText(/imported by hand/)).toBeInTheDocument();
    });
});

describe("while the new key is pending", () => {
    const pending = (nextOver: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
        rotation: { phase: "pending", next: { ...next, ...nextOver }, ...over },
        rotatable: true,
    });

    it("says it is creating the new key while it has none", async () => {
        mockApi({ rotation: pending({ publicKey: "" }) });
        renderPage();
        expect((await panel()).getByText(/Creating the new key/)).toBeInTheDocument();
    });

    it("says it waits for the new record to be live, and why it started", async () => {
        mockApi({ rotation: pending() });
        renderPage();
        const dkim = await panel();
        expect(dkim.getByText(/Waiting for the new record for/)).toBeInTheDocument();
        expect(dkim.getByText("rmx20260601", { selector: "code" })).toBeInTheDocument();
        expect(dkim.getByText(/Started by an administrator/)).toBeInTheDocument();
        expect(dkim.getByText(/Signing keeps using the current key/)).toBeInTheDocument();
    });

    it("says once the record is live, and that signing waits out the publish grace", async () => {
        const liveSince = daysAgo(1);
        mockApi({ rotation: pending({ liveSince }) });
        renderPage();
        const dkim = await panel();
        expect(dkim.getByText(new RegExp(`live since ${dateOf(liveSince)}`))).toBeInTheDocument();
        expect(dkim.getByText(/long enough for resolvers to drop any cached negative answer/)).toBeInTheDocument();
    });

    it("says a compromised rotation switches as soon as the record is live", async () => {
        mockApi({ rotation: pending({ liveSince: daysAgo(0), reason: "compromised" }) });
        renderPage();
        const dkim = await panel();
        expect(dkim.getByText(/Started because the key was reported compromised/)).toBeInTheDocument();
        expect(dkim.getByText(/switches to the new key next/)).toBeInTheDocument();
        // Already treated as compromised: nothing more to report.
        expect(dkim.queryByRole("button", { name: "Key compromised: rotate now" })).not.toBeInTheDocument();
    });

    it("names a scheduled start", async () => {
        mockApi({ rotation: pending({ reason: "scheduled" }) });
        renderPage();
        expect((await panel()).getByText(/Started by the schedule/)).toBeInTheDocument();
    });

    it("offers cancel, pause and the compromised key, but not Rotate now", async () => {
        mockApi({ rotation: pending() });
        renderPage();
        const dkim = await panel();
        expect(dkim.queryByRole("button", { name: "Rotate now" })).not.toBeInTheDocument();
        expect(dkim.getByRole("button", { name: "Cancel rotation" })).toBeInTheDocument();
        expect(dkim.getByRole("button", { name: "Key compromised: rotate now" })).toBeInTheDocument();
        expect(dkim.getByRole("button", { name: "Pause scheduled rotation" })).toBeInTheDocument();
    });

    it("reports the key compromised during the rotation", async () => {
        const user = userEvent.setup();
        const calls = mockApi({ rotation: pending() });
        renderPage();
        await user.click((await panel()).getByRole("button", { name: "Key compromised: rotate now" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
        await waitFor(() => expect(calls.find((call) => call.method === "POST")?.body).toEqual({ compromised: true }));
    });

    it("asks before cancelling, then cancels and shows the idle state", async () => {
        const user = userEvent.setup();
        let cancelled = false;
        const calls = mockApi({
            rotation: () => (cancelled ? { rotation: { phase: "idle", lastCancelledAt: daysAgo(0) }, rotatable: true } : pending()),
            writes: {
                "POST /mail/domains/example.com/dkim/rotation/cancel": () => {
                    cancelled = true;
                    return jsonResponse(200, domain);
                },
            },
        });
        renderPage();
        const dkim = await panel();

        await user.click(dkim.getByRole("button", { name: "Cancel rotation" }));
        let dialog = within(screen.getByRole("dialog", { name: "Cancel rotation" }));
        expect(dialog.getByText(/new key is deleted/)).toBeInTheDocument();
        await user.click(dialog.getByRole("button", { name: "Back" }));
        expect(calls.some((call) => call.method === "POST")).toBe(false);

        await user.click(dkim.getByRole("button", { name: "Cancel rotation" }));
        dialog = within(screen.getByRole("dialog", { name: "Cancel rotation" }));
        await user.click(dialog.getByRole("button", { name: "Confirm" }));
        expect(await dkim.findByText(/No rotation is in progress/)).toBeInTheDocument();
        expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    });

    it("takes a refusal of the cancel off the card with its dialog", async () => {
        const user = userEvent.setup();
        mockApi({
            rotation: pending(),
            writes: { "POST /mail/domains/example.com/dkim/rotation/cancel": () => jsonResponse(409, { code: "api-109", message: "The previous DKIM key is gone." }) },
        });
        renderPage();
        const dkim = await panel();
        await user.click(dkim.getByRole("button", { name: "Cancel rotation" }));
        const dialog = within(screen.getByRole("dialog", { name: "Cancel rotation" }));
        await user.click(dialog.getByRole("button", { name: "Confirm" }));
        expect(await dialog.findByText("The previous DKIM key is gone.")).toBeInTheDocument();

        await user.click(dialog.getByRole("button", { name: "Back" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(screen.queryByText("The previous DKIM key is gone.")).not.toBeInTheDocument();
    });

    it("still shows a rotation under way and lets it be cancelled when the key can no longer rotate", async () => {
        const user = userEvent.setup();
        mockApi({ rotation: { ...pending({}, { lastError: "The new DKIM key could not be generated." }), rotatable: false, blocker: "unsupported" } });
        renderPage();
        const dkim = await panel();
        expect(dkim.getByText(/key provider doesn't rotate keys/)).toBeInTheDocument();
        expect(dkim.getByText(/Waiting for the new record/)).toBeInTheDocument();
        expect(dkim.queryByRole("button", { name: "Rotate now" })).not.toBeInTheDocument();
        expect(dkim.queryByRole("button", { name: "Key compromised: rotate now" })).not.toBeInTheDocument();
        expect(dkim.queryByRole("button", { name: /scheduled rotation/ })).not.toBeInTheDocument();
        expect(dkim.getByText("The new DKIM key could not be generated.")).toBeInTheDocument();

        await user.click(dkim.getByRole("button", { name: "Cancel rotation" }));
        expect(screen.getByRole("dialog", { name: "Cancel rotation" })).toBeInTheDocument();
    });

    it("shows what holds the rotation up", async () => {
        mockApi({ rotation: pending({}, { lastError: "The new DKIM key could not be generated." }) });
        renderPage();
        expect((await panel()).getByText("The new DKIM key could not be generated.")).toBeInTheDocument();
    });
});

describe("while signing switches", () => {
    const switching = (over: Record<string, unknown> = {}) => ({
        rotation: { phase: "switching", previous: { selector: "default", publicKey: "OLDKEY" }, reason: "manual", switchedAt: daysAgo(0.01), ...over },
        rotatable: true,
    });
    const domainNow = { dkimSelector: "rmx20260601", dkimPublicKey: "NEWKEY" };

    it("says it waits for the mail server to confirm the new selector", async () => {
        mockApi({ domain: domainNow, rotation: switching() });
        renderPage();
        const dkim = await panel();
        expect(dkim.getByText(/Switching: signing has moved to the new key/)).toBeInTheDocument();
        expect(dkim.getByText(/hasn.t confirmed it yet/)).toBeInTheDocument();
        // The active key is the new one, in use since the switch.
        expect(dkim.getByText("rmx20260601", { selector: "code" })).toBeInTheDocument();
        expect(dkim.getByText(/in use for less than a day/)).toBeInTheDocument();
    });

    it("says a cancel goes back to the previous key", async () => {
        const user = userEvent.setup();
        mockApi({ domain: domainNow, rotation: switching() });
        renderPage();
        await user.click((await panel()).getByRole("button", { name: "Cancel rotation" }));
        expect(within(screen.getByRole("dialog")).getByText(/Signing goes back to the previous key/)).toBeInTheDocument();
    });

    it("offers the compromised key unless the switch already treats it so", async () => {
        mockApi({ domain: domainNow, rotation: switching({ reason: "compromised" }) });
        renderPage();
        const dkim = await panel();
        await dkim.findByText(/Switching/);
        expect(dkim.queryByRole("button", { name: "Key compromised: rotate now" })).not.toBeInTheDocument();
        expect(dkim.getByRole("button", { name: "Cancel rotation" })).toBeInTheDocument();
    });

    it("shows the error of a switch the mail server never confirmed", async () => {
        mockApi({ domain: domainNow, rotation: switching({ lastError: "The mail server has not confirmed the switch." }) });
        renderPage();
        expect((await panel()).getByText("The mail server has not confirmed the switch.")).toBeInTheDocument();
    });
});

describe("during the overlap", () => {
    const retireAt = daysAgo(-5);
    const overlap = (previous: Record<string, unknown> = {}) => ({
        rotation: { phase: "overlap", previous: { selector: "default", publicKey: "OLDKEY", retireAt, ...previous }, reason: "manual", switchedAt: daysAgo(2) },
        rotatable: true,
    });
    const domainNow = { dkimSelector: "rmx20260601", dkimPublicKey: "NEWKEY" };

    it("says when the old key retires, and offers no cancel", async () => {
        mockApi({ domain: domainNow, rotation: overlap() });
        renderPage();
        const dkim = await panel();
        expect(dkim.getByText(new RegExp(`old key retires on ${dateOf(retireAt)}`))).toBeInTheDocument();
        expect(dkim.queryByRole("button", { name: "Cancel rotation" })).not.toBeInTheDocument();
        expect(dkim.queryByRole("button", { name: "Rotate now" })).not.toBeInTheDocument();
    });

    it("retires the old key at once when the key is reported compromised", async () => {
        const user = userEvent.setup();
        const calls = mockApi({ domain: domainNow, rotation: overlap() });
        renderPage();
        await user.click((await panel()).getByRole("button", { name: "Key compromised: rotate now" }));
        const dialog = within(screen.getByRole("dialog", { name: "Key compromised" }));
        expect(dialog.getByText(/old record and key are removed now/)).toBeInTheDocument();
        await user.click(dialog.getByRole("button", { name: "Confirm" }));
        await waitFor(() => expect(calls.find((call) => call.method === "POST")?.body).toEqual({ compromised: true }));
    });

    it("says the old key retires shortly when it has no date", async () => {
        mockApi({ domain: domainNow, rotation: overlap({ retireAt: undefined }) });
        renderPage();
        expect((await panel()).getByText(/old key retires shortly/)).toBeInTheDocument();
    });
});

describe("the record a manual domain publishes", () => {
    it("shows the new record with its name and value to copy, and that signing waits for it", async () => {
        mockApi({
            rotation: { rotation: { phase: "pending", next }, rotatable: true },
            checks: [check("dkim"), check("dkim_next", { publication: "manual", manualReason: "no_provider", matches: false, found: false })],
        });
        renderPage();
        const dkim = await panel();
        expect(dkim.getByText("Publish this record to finish rotating")).toBeInTheDocument();
        expect(dkim.getByRole("button", { name: "Copy name for the new DKIM key record" })).toBeInTheDocument();
        expect(dkim.getByText("rmx20260601._domainkey.example.com")).toBeInTheDocument();
        expect(dkim.getByText("v=DKIM1; k=rsa; p=dkim_next")).toBeInTheDocument();
        expect(dkim.getByRole("button", { name: "Copy value for the new DKIM key record" })).toBeInTheDocument();
        expect(dkim.getByText("Not found yet")).toBeInTheDocument();
        expect(dkim.queryByText(/has been waiting/)).not.toBeInTheDocument();
    });

    it("says the record is live once the live check sees it", async () => {
        mockApi({
            rotation: { rotation: { phase: "pending", next: { ...next, liveSince: daysAgo(0.1) } }, rotatable: true },
            checks: [check("dkim_next", { publication: "manual" })],
        });
        renderPage();
        const dkim = await panel();
        expect(dkim.getByText("Live")).toBeInTheDocument();
        expect(dkim.queryByText("Publish this record to finish rotating")).not.toBeInTheDocument();
    });

    it("reminds the administrator after 7 days of waiting for it", async () => {
        mockApi({
            rotation: { rotation: { phase: "pending", next: { ...next, createdAt: daysAgo(8) } }, rotatable: true },
            checks: [check("dkim_next", { publication: "manual", matches: false, found: false })],
        });
        renderPage();
        const dkim = await panel();
        expect(dkim.getByText(/This record has been waiting for 8 days/)).toBeInTheDocument();
        expect(dkim.getByText(/Signing doesn't switch until it is live/)).toBeInTheDocument();
    });

    it("shows the record to publish when the checklist has no word on how it is published", async () => {
        mockApi({
            rotation: { rotation: { phase: "pending", next }, rotatable: true },
            checks: [check("dkim_next", { matches: false, found: false })],
        });
        renderPage();
        expect((await panel()).getByText("Publish this record to finish rotating")).toBeInTheDocument();
    });

    it.each(["pending", "published"])("doesn't ask for the record of a domain whose provider publishes it (%s)", async (publication) => {
        mockApi({
            rotation: { rotation: { phase: "pending", next: { ...next, createdAt: daysAgo(9) } }, rotatable: true },
            checks: [check("dkim_next", { publication, matches: false, found: false })],
        });
        renderPage();
        const dkim = await panel();
        await dkim.findByText(/Waiting for the new record/);
        expect(dkim.queryByText("Publish this record to finish rotating")).not.toBeInTheDocument();
        expect(dkim.queryByText(/has been waiting/)).not.toBeInTheDocument();
        expect(dkim.getByText(/published automatically by the DNS provider/)).toBeInTheDocument();
    });

    it("says a record in conflict is not published until the one in the way is taken over", async () => {
        mockApi({
            rotation: { rotation: { phase: "pending", next }, rotatable: true },
            checks: [check("dkim_next", { publication: "conflict", matches: false, found: false })],
        });
        renderPage();
        const dkim = await panel();
        expect(await dkim.findByText(/can.t publish this record while another one is in the way/)).toBeInTheDocument();
        expect(dkim.queryByText("Publish this record to finish rotating")).not.toBeInTheDocument();
        expect(dkim.queryByText(/published automatically by the DNS provider/)).not.toBeInTheDocument();
    });

    it("says to keep the old record until the old key retires, and that it may be removed after", async () => {
        const retireAt = daysAgo(-3);
        mockApi({
            domain: { dkimSelector: "rmx20260601", dkimPublicKey: "NEWKEY" },
            rotation: { rotation: { phase: "overlap", previous: { selector: "default", publicKey: "OLDKEY", retireAt }, reason: "manual", switchedAt: daysAgo(4) }, rotatable: true },
            checks: [check("dkim_previous", { publication: "manual" })],
        });
        renderPage();
        const dkim = await panel();
        expect(dkim.getByText(new RegExp(`Keep this record published until ${dateOf(retireAt)}`))).toBeInTheDocument();
        expect(dkim.getByText("default._domainkey.example.com")).toBeInTheDocument();
        expect(dkim.getByText(/then you may remove it/)).toBeInTheDocument();
    });

    it("says the old record may be removed once its retirement date has passed", async () => {
        mockApi({
            domain: { dkimSelector: "rmx20260601", dkimPublicKey: "NEWKEY" },
            rotation: { rotation: { phase: "overlap", previous: { selector: "default", publicKey: "OLDKEY", retireAt: daysAgo(0.5) }, reason: "manual", switchedAt: daysAgo(8) }, rotatable: true },
            checks: [check("dkim_previous", { publication: "manual" })],
        });
        renderPage();
        expect((await panel()).getByText(/The old key has retired: you may now remove this record/)).toBeInTheDocument();
    });

    it("shows nothing to publish while the checklist can't be read or lacks the record", async () => {
        mockApi({ rotation: { rotation: { phase: "pending", next }, rotatable: true }, checks: [check("dkim")] });
        renderPage();
        const dkim = await panel();
        await dkim.findByText(/Waiting for the new record/);
        expect(dkim.queryByText("Publish this record to finish rotating")).not.toBeInTheDocument();
    });
});

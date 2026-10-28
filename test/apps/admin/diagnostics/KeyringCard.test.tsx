// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigKeys } from "../../../../lib/admin/configKeysApi.js";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import KeyringCard, { loadKeyring } from "../../../../apps/shared/components/admin/diagnostics/KeyringCard.js";
import { configKeysFixture } from "./fixtures.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW - days * DAY_MS - 3_600_000).toISOString();

const show = (data: ConfigKeys | null | undefined, extra: { error?: string; loading?: boolean } = {}) =>
    render(<KeyringCard keyring={{ data, error: extra.error, loading: extra.loading ?? false }} now={NOW} />);

/** The ring while `bbbb2222` replaces `aaaa1111`, in `phase`. */
function rotating(phase: "adding" | "activating" | "reencrypting" | "retiring" | "done" | "failed", over: Partial<ConfigKeys["rotation"] & object> = {}): ConfigKeys {
    return configKeysFixture(NOW, {
        keys: [
            { kid: "aaaa1111", createdAt: ago(190), active: phase !== "reencrypting" && phase !== "retiring" && phase !== "done", envelopes: 12 },
            { kid: "bbbb2222", createdAt: ago(0), active: phase === "reencrypting" || phase === "retiring" || phase === "done", envelopes: 4 },
        ],
        rotation: {
            kid: "bbbb2222",
            previousKids: ["aaaa1111"],
            compromised: false,
            requestedBy: "admin-1",
            requestedAt: ago(0),
            phase,
            ...(phase === "reencrypting" || phase === "retiring" || phase === "done" ? { activatedAt: ago(0) } : {}),
            ...over,
        },
    });
}

describe("KeyringCard", () => {
    it("lists each key by its id with when it was made, its age and how many values it encrypts", () => {
        show(
            configKeysFixture(NOW, {
                keys: [
                    { kid: "aaaa1111", createdAt: ago(190), active: true, envelopes: 12 },
                    { kid: "cccc3333", createdAt: ago(0), active: false, envelopes: 1 },
                ],
            })
        );
        const card = within(screen.getByRole("region", { name: "Configuration keyring" }));
        const rows = card.getAllByRole("row");
        expect(rows).toHaveLength(3);
        const first = within(rows[1]);
        expect(first.getByText("aaaa1111")).toBeInTheDocument();
        expect(first.getByText(new Date(ago(190)).toLocaleString())).toBeInTheDocument();
        expect(first.getByText("190 days")).toBeInTheDocument();
        expect(first.getByText("12")).toBeInTheDocument();
        expect(first.getByText("Active")).toBeInTheDocument();
        const second = within(rows[2]);
        expect(second.getByText("less than a day")).toBeInTheDocument();
        expect(second.getByText("1")).toBeInTheDocument();
        expect(second.queryByText("Active")).not.toBeInTheDocument();
        expect(card.getByText(`Values were last counted ${new Date(NOW - 5 * 60_000).toLocaleString()}.`)).toBeInTheDocument();
    });

    it("says a key's values are not counted yet when no pass has counted them", () => {
        show(configKeysFixture(NOW, { countedAt: null, keys: [{ kid: "aaaa1111", createdAt: ago(3), active: true }] }));
        expect(screen.getByText("Not counted yet")).toBeInTheDocument();
        expect(screen.getByText("Values have not been counted yet.")).toBeInTheDocument();
    });

    it("shows only the id, date, age, count and state of each key", () => {
        show(configKeysFixture(NOW, { keys: [{ kid: "aaaa1111", createdAt: ago(1), active: true, envelopes: 2, key: "c2VjcmV0" } as never] }));
        const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
        expect(cells.map((cell) => cell.textContent)).toEqual(["aaaa1111", new Date(ago(1)).toLocaleString(), "1 day", "2", "Active"]);
    });

    it("marks the key the deployment encrypts with from the rotation, not from the copy that answered", () => {
        // The copy that answered already encrypts with the new key, but the rotation has not activated it for the others.
        const view = rotating("activating");
        view.keys[0].active = false;
        view.keys[1].active = true;
        show(view);
        const rows = screen.getAllByRole("row");
        expect(within(rows[1]).getByText("Active")).toBeInTheDocument();
        expect(within(rows[2]).queryByText("Active")).not.toBeInTheDocument();
        expect(within(rows[2]).getByText("Waiting to be activated")).toBeInTheDocument();
    });

    it("points to the Configuration Encryption page while a rotation runs and says where it is", () => {
        const phases: [Parameters<typeof rotating>[0], string][] = [
            ["adding", "adding the new key"],
            ["activating", "waiting for the server copies to load the new key"],
            ["reencrypting", "re-encrypting the saved values"],
            ["retiring", "removing the old key"],
        ];
        for (const [phase, words] of phases) {
            const { unmount } = show(rotating(phase));
            const note = screen.getByRole("note");
            expect(note).toHaveTextContent(`A key rotation is in progress: ${words}.`);
            expect(within(note).getByRole("link", { name: "Configuration Encryption" })).toHaveAttribute("href", "/admin/configuration-encryption");
            unmount();
        }
    });

    it("says nothing of a rotation that is done, and reports one that failed", () => {
        const { unmount } = show(rotating("done"));
        expect(screen.queryByRole("note")).not.toBeInTheDocument();
        unmount();
        show(rotating("failed", { lastError: "The keyring Secret could not be written." }));
        expect(screen.queryByText(/is in progress/)).not.toBeInTheDocument();
        expect(screen.getByRole("note")).toHaveTextContent("The last key rotation failed: The keyring Secret could not be written.");
    });

    it("says how many saved values the last pass couldn't read, never which value, and when that list was made", () => {
        show(
            configKeysFixture(NOW, {
                reencryption: {
                    targetKid: "aaaa1111",
                    complete: true,
                    startedAt: ago(1),
                    finishedAt: ago(1),
                    unreadable: [
                        { record: "DnsProvider", uid: "p1", field: "credentials.apiToken", kid: "dead0000" },
                        { record: "Plugin", uid: "p2", field: "settings.apiKey", kid: "dead0000" },
                    ],
                },
            })
        );
        const alert = screen.getByRole("alert");
        expect(alert).toHaveTextContent(`The re-encryption pass that finished ${new Date(ago(1)).toLocaleString()} could not read 2 saved values with the keys in this keyring.`);
        expect(alert).toHaveTextContent("only a later pass updates this, so a value entered again stays counted until then");
        expect(alert).not.toHaveTextContent("apiToken");
    });

    it("words the unreadable count without a time when the pass has no finish time", () => {
        show(
            configKeysFixture(NOW, {
                reencryption: { targetKid: "aaaa1111", complete: false, startedAt: ago(0), unreadable: [{ record: "Plugin", uid: "p2", field: "settings.apiKey", kid: "dead0000" }] },
            })
        );
        expect(screen.getByRole("alert")).toHaveTextContent("The last re-encryption pass could not read 1 saved value with the keys in this keyring.");
    });

    it("says nothing about unreadable values when there are none", () => {
        show(configKeysFixture(NOW, { reencryption: { targetKid: "aaaa1111", complete: true, startedAt: ago(0), unreadable: [] } }));
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("says a server without the route doesn't offer configuration encryption", () => {
        show(null);
        expect(screen.getByText(/This server doesn.t offer configuration encryption yet/)).toBeInTheDocument();
        expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });

    it("shows what the server could not be asked, and that it is loading", () => {
        const { unmount } = show(undefined, { error: "Could not read the configuration keyring." });
        expect(screen.getByText("Could not read the configuration keyring.")).toBeInTheDocument();
        unmount();
        const loading = show(undefined, { loading: true });
        expect(screen.getByText(/Loading/)).toBeInTheDocument();
        loading.unmount();
        show(undefined);
        expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
    });

    it("copes with an answer that leaves its lists out", () => {
        show({ available: true, activeKid: null } as ConfigKeys);
        expect(screen.getByText("The keyring holds no keys.")).toBeInTheDocument();
    });

    it("keeps what it had on screen next to the reason a reload failed", () => {
        show(configKeysFixture(NOW), { error: "Could not read the configuration keyring." });
        expect(screen.getByText("Could not read the configuration keyring.")).toBeInTheDocument();
        expect(screen.getByText("aaaa1111")).toBeInTheDocument();
    });
});

describe("loadKeyring", () => {
    it("reads the keys with the configuration keys client", async () => {
        const view = configKeysFixture(NOW);
        const fetchMock = mockFetch((url) => {
            if (url === "/api/system/config-keys") return jsonResponse(200, view);
            throw new Error(`unexpected ${url}`);
        });
        expect(await loadKeyring()).toEqual(view);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("answers null for a server that has no such route, and fails for anything else", async () => {
        mockFetch(() => jsonResponse(404, { message: "Not found." }));
        expect(await loadKeyring()).toBeNull();
        mockFetch(() => jsonResponse(500, { message: "Broken." }));
        await expect(loadKeyring()).rejects.toThrow("Broken.");
        mockFetch(() => jsonResponse(403, { message: "No." }));
        await expect(loadKeyring()).rejects.toMatchObject({ status: 403 });
    });
});

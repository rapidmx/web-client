// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import ConfigurationEncryptionPage from "../../../../apps/admin/configuration-encryption/index.js";

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const DAY_MS = 24 * 60 * 60 * 1000;
/** An ISO time `days` days (and an hour, so rounding down gives `days`) before now. */
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS - 60 * 60 * 1000).toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

/** What `GET /api/system/config-keys` answers (restapi `PublicConfigKeys`) for a deployment on its original key that has never rotated. */
function keysView(over: Record<string, unknown> = {}): any {
    return {
        available: true,
        activeKid: "aaaa1111",
        keys: [{ kid: "aaaa1111", createdAt: daysAgo(190), active: true, envelopes: 12 }],
        countedAt: minutesAgo(5),
        rotation: null,
        reencryption: null,
        pluginSecrets: { encryptedAt: daysAgo(30) },
        ...over,
    };
}

/** A rotation in `phase` from `aaaa1111` to `bbbb2222`, with the fields restapi's `ConfigKeyRotation` carries. */
function rotationOf(phase: string, over: Record<string, unknown> = {}): any {
    return {
        kid: "bbbb2222",
        previousKids: ["aaaa1111"],
        compromised: false,
        requestedBy: "admin-1",
        requestedAt: minutesAgo(3),
        phase,
        ...over,
    };
}

/** The ring while `bbbb2222` is being added: both keys, the old one still encrypting. */
const TWO_KEYS = [
    { kid: "aaaa1111", createdAt: daysAgo(190), active: true, envelopes: 12 },
    { kid: "bbbb2222", createdAt: minutesAgo(3), active: false, envelopes: 0 },
];

/** A fetch mock answering the admin shell's checks and the key console; every POST is recorded in `posts`. `view` is called for each read. */
function mockKeys(view: () => Response | any, post?: (path: string, body: any) => Response) {
    const posts: { path: string; body: any }[] = [];
    const reads = { count: 0 };
    const fetchMock = mockFetch((url, init) => {
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        if (url === "/api/system/setup") return jsonResponse(200, { required: false });
        if (url === "/api/system/config-keys" && (init?.method ?? "GET") === "GET") {
            reads.count++;
            const answer = view();
            return answer instanceof Response ? answer : jsonResponse(200, answer);
        }
        const path = /^\/api\/system\/config-keys\/(rotate|activate)$/.exec(url)?.[1];
        if (path && init?.method === "POST") {
            const body = JSON.parse(init.body as string);
            posts.push({ path, body });
            return post ? post(path, body) : jsonResponse(202, keysView());
        }
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
    return { fetchMock, posts, reads };
}

const renderPage = () =>
    render(<ConfigurationEncryptionPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

describe("ConfigurationEncryptionPage", () => {
    it("sits in the admin rail as Configuration Encryption", async () => {
        mockKeys(() => keysView());
        renderPage();

        expect(await screen.findByRole("heading", { name: "Configuration encryption" })).toBeInTheDocument();
        const link = screen.getByRole("link", { name: "Configuration Encryption" });
        expect(link).toHaveAttribute("href", "/admin/configuration-encryption");
        expect(link).toHaveAttribute("aria-current", "page");
    });

    describe("the keys", () => {
        it("lists each key with its age and how many values it encrypts, and which one is active", async () => {
            mockKeys(() =>
                keysView({
                    keys: [
                        { kid: "aaaa1111", createdAt: daysAgo(190), active: false, envelopes: 2 },
                        { kid: "bbbb2222", createdAt: daysAgo(1), active: true, envelopes: 10 },
                    ],
                })
            );
            renderPage();

            const rows = await screen.findAllByRole("row");
            // The header, then a row per key.
            expect(rows).toHaveLength(3);
            const [first, second] = rows.slice(1).map((row) =>
                within(row)
                    .getAllByRole("cell")
                    .map((cell) => cell.textContent)
            );
            expect(first).toEqual(["aaaa1111", new Date(daysAgo(190)).toLocaleDateString(), "190 days", "2"]);
            expect(second).toEqual(["bbbb2222Active", new Date(daysAgo(1)).toLocaleDateString(), "1 day", "10"]);
            expect(screen.getByText(/Values were last counted/)).toBeInTheDocument();
        });

        it("marks the new key active from the moment the rotation activated it, whichever copy answered", async () => {
            // A copy that has not reloaded the keyring yet still reports the old key as the one it encrypts with.
            mockKeys(() =>
                keysView({ keys: TWO_KEYS, rotation: rotationOf("reencrypting", { activatedAt: minutesAgo(1) }) })
            );
            renderPage();

            const rows = await screen.findAllByRole("row");
            const cells = rows.slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent);
            expect(cells).toEqual(["aaaa1111", "bbbb2222Active"]);
        });

        it("keeps the old key active until the rotation activates the new one, though a copy already encrypts with the new key", async () => {
            const keysOf = [
                { kid: "aaaa1111", createdAt: daysAgo(190), active: false, envelopes: 12 },
                { kid: "bbbb2222", createdAt: minutesAgo(3), active: true, envelopes: 0 },
            ];
            mockKeys(() =>
                keysView({
                    keys: keysOf,
                    activeKid: "bbbb2222",
                    rotation: rotationOf("activating", { waitingFor: ["mail-7d9f:1"] }),
                })
            );
            renderPage();

            const rows = await screen.findAllByRole("row");
            // The flag of the copy that answered isn't shown: the old key is the cluster's until the rotation activates.
            expect(rows.slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual([
                "aaaa1111Active",
                "bbbb2222",
            ]);
        });

        it("says so when the values have not been counted yet, and never shows key material", async () => {
            mockKeys(() =>
                keysView({ keys: [{ kid: "aaaa1111", createdAt: daysAgo(0), active: true }], countedAt: null })
            );
            renderPage();

            const row = (await screen.findAllByRole("row"))[1];
            expect(within(row).getByText("Not counted yet")).toBeInTheDocument();
            expect(within(row).getByText("less than a day")).toBeInTheDocument();
            expect(screen.queryByText(/Values were last counted/)).not.toBeInTheDocument();
        });

        it("tells a server without the route that it can't manage the keys yet", async () => {
            mockKeys(() => jsonResponse(404, { message: "Not Found" }));
            renderPage();

            expect(
                await screen.findByText(/This server doesn.t offer configuration encryption yet/)
            ).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Rotate configuration key" })).not.toBeInTheDocument();
        });

        it("shows another failure to read the keys, with a way to try again", async () => {
            let fails = true;
            const { reads } = mockKeys(() =>
                fails ? jsonResponse(500, { message: "The database is down." }) : keysView()
            );
            const user = userEvent.setup();
            renderPage();

            expect(await screen.findByText("The database is down.")).toBeInTheDocument();
            fails = false;
            await user.click(screen.getByRole("button", { name: "Try again" }));
            expect(await screen.findByRole("button", { name: "Rotate configuration key" })).toBeInTheDocument();
            expect(reads.count).toBe(2);
        });

        it("drops the failure of a read that is still on its way when the page is closed", async () => {
            let answer: ((response: Response) => void) | undefined;
            mockFetch((url) => {
                if (url === "/api/admin/release-notes") return jsonResponse(200, {});
                if (url === "/api/system/setup") return jsonResponse(200, { required: false });
                if (url !== "/api/system/config-keys") return jsonResponse(404, {});
                return new Promise<Response>((resolve) => (answer = resolve));
            });
            const { unmount } = renderPage();

            await vi.waitFor(() => expect(answer).toBeDefined());
            unmount();
            // The failure is decoded after the answer arrives, so let it get all the way to the page.
            await act(async () => {
                answer!(jsonResponse(500, { message: "The database is down." }));
                await new Promise((resolve) => setTimeout(resolve, 50));
            });
            expect(screen.queryByText("The database is down.")).not.toBeInTheDocument();
        });

        it("reminds the administrator to back up the keyring with the database", async () => {
            mockKeys(() => keysView());
            renderPage();

            expect(await screen.findByText(/A database backup can.t be read without the keyring/)).toBeInTheDocument();
            expect(screen.queryByText(/Back up the keyring again/)).not.toBeInTheDocument();
        });
    });

    describe("starting a rotation", () => {
        it("rotates on one click and then shows the rotation's progress", async () => {
            const { posts } = mockKeys(
                () => keysView(),
                () =>
                    jsonResponse(202, keysView({ keys: TWO_KEYS, rotation: rotationOf("adding", { kid: undefined }) }))
            );
            const user = userEvent.setup();
            renderPage();

            expect(await screen.findByText("No rotation is in progress.")).toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: "Rotate configuration key" }));

            expect(await screen.findByText("Adding the new key to the keyring.")).toBeInTheDocument();
            expect(posts).toEqual([{ path: "rotate", body: {} }]);
            // Nothing starts a second one, and the key can still be reported compromised.
            expect(screen.queryByRole("button", { name: "Rotate configuration key" })).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Key compromised: rotate now" })).toBeInTheDocument();
        });

        it("shows why a rotation can't start where the keyring can't be changed, and offers nothing", async () => {
            mockKeys(() => keysView({ available: false }));
            renderPage();

            expect(await screen.findByText(/Keys can.t be rotated on this server/)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Rotate configuration key" })).toBeDisabled();
            expect(screen.getByRole("button", { name: "Key compromised: rotate now" })).toBeDisabled();
        });

        it("shows the server's refusal", async () => {
            mockKeys(
                () => keysView(),
                () => jsonResponse(503, { message: "The configuration keyring can't be read." })
            );
            const user = userEvent.setup();
            renderPage();

            await user.click(await screen.findByRole("button", { name: "Rotate configuration key" }));
            expect(await screen.findByText("The configuration keyring can't be read.")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Rotate configuration key" })).toBeEnabled();
        });

        it("asks the administrator to confirm their identity again when the server needs it", async () => {
            mockKeys(
                () => keysView(),
                () => jsonResponse(403, { message: "Requires elevation.", code: "api-104" })
            );
            const user = userEvent.setup();
            renderPage();

            await user.click(await screen.findByRole("button", { name: "Rotate configuration key" }));
            expect(await screen.findByText(/recently confirmed your identity/)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Confirm identity again" })).toBeInTheDocument();
        });

        it("takes the running rotation's progress from a 409 instead of starting another", async () => {
            const running = keysView({ keys: TWO_KEYS, rotation: rotationOf("adding") });
            mockKeys(
                () => keysView(),
                () => jsonResponse(409, running)
            );
            const user = userEvent.setup();
            renderPage();

            await user.click(await screen.findByRole("button", { name: "Rotate configuration key" }));
            expect(await screen.findByText("Adding the new key to the keyring.")).toBeInTheDocument();
            expect(screen.getByText(/A rotation was already in progress/)).toBeInTheDocument();
        });

        it("starts a compromised rotation only after a confirmation", async () => {
            const { posts } = mockKeys(
                () => keysView(),
                () =>
                    jsonResponse(
                        202,
                        keysView({ keys: TWO_KEYS, rotation: rotationOf("adding", { compromised: true }) })
                    )
            );
            const user = userEvent.setup();
            renderPage();

            await user.click(await screen.findByRole("button", { name: "Key compromised: rotate now" }));
            const dialog = await screen.findByRole("dialog", { name: "Key compromised" });
            expect(posts).toEqual([]);
            expect(within(dialog).getByText(/replace the credentials/)).toBeInTheDocument();
            await user.click(within(dialog).getByRole("button", { name: "Rotate now" }));

            await vi.waitFor(() => expect(posts).toEqual([{ path: "rotate", body: { compromised: true } }]));
            expect(await screen.findByText("Adding the new key to the keyring.")).toBeInTheDocument();
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });

        it("keeps the confirmation open with the server's refusal, and closes it with the refusal cleared", async () => {
            mockKeys(
                () => keysView(),
                () => jsonResponse(503, { message: "Redis is not available." })
            );
            const user = userEvent.setup();
            renderPage();

            await user.click(await screen.findByRole("button", { name: "Key compromised: rotate now" }));
            const dialog = await screen.findByRole("dialog", { name: "Key compromised" });
            await user.click(within(dialog).getByRole("button", { name: "Rotate now" }));
            expect(await within(dialog).findByText("Redis is not available.")).toBeInTheDocument();

            await user.click(within(dialog).getByRole("button", { name: "Back" }));
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
            // The refusal belonged to the dialog.
            expect(screen.queryByText("Redis is not available.")).not.toBeInTheDocument();
        });

        it("offers Key compromised during a rotation that is not yet compromised, and not when it already is", async () => {
            const { posts } = mockKeys(
                () => keysView({ keys: TWO_KEYS, rotation: rotationOf("activating", { waitingFor: ["server-a:1"] }) }),
                () =>
                    jsonResponse(
                        200,
                        keysView({
                            keys: TWO_KEYS,
                            rotation: rotationOf("activating", { compromised: true, waitingFor: ["server-a:1"] }),
                        })
                    )
            );
            const user = userEvent.setup();
            renderPage();

            await user.click(await screen.findByRole("button", { name: "Key compromised: rotate now" }));
            await user.click(
                within(await screen.findByRole("dialog", { name: "Key compromised" })).getByRole("button", {
                    name: "Rotate now",
                })
            );

            await vi.waitFor(() => expect(posts).toEqual([{ path: "rotate", body: { compromised: true } }]));
            await vi.waitFor(() =>
                expect(screen.queryByRole("button", { name: "Key compromised: rotate now" })).not.toBeInTheDocument()
            );
            expect(screen.getByText(/replace the credentials saved here/)).toBeInTheDocument();
        });
    });

    describe("a rotation in progress", () => {
        it("names the copies the new key waits for", async () => {
            mockKeys(() =>
                keysView({
                    keys: TWO_KEYS,
                    rotation: rotationOf("activating", { waitingFor: ["mail-7d9f:1", "mail-9c2b:1"] }),
                })
            );
            renderPage();

            expect(await screen.findByText("Waiting for 2 copies to load the new key")).toBeInTheDocument();
            const copies = screen.getByRole("list", { name: "Copies that haven't loaded the new key" });
            expect(
                within(copies)
                    .getAllByRole("listitem")
                    .map((item) => item.textContent)
            ).toEqual(["mail-7d9f:1", "mail-9c2b:1"]);
            expect(screen.getByText(/Nothing breaks while it waits/)).toBeInTheDocument();
            // No warning yet: the server sends it once the wait has gone on too long.
            expect(screen.queryByText(/restarting the named pods/)).not.toBeInTheDocument();
        });

        it("says a single copy in the singular", async () => {
            mockKeys(() =>
                keysView({ keys: TWO_KEYS, rotation: rotationOf("activating", { waitingFor: ["mail-7d9f:1"] }) })
            );
            renderPage();

            expect(await screen.findByText("Waiting for 1 copy to load the new key")).toBeInTheDocument();
        });

        it("shows the server's warning once the wait has gone on too long", async () => {
            const warning =
                "The new key has waited more than 15 minutes for mail-7d9f:1 to load it. The usual cause is a node whose kubelet hasn't refreshed the keyring Secret; restarting the named pods resolves it.";
            mockKeys(() =>
                keysView({
                    keys: TWO_KEYS,
                    rotation: rotationOf("activating", { waitingFor: ["mail-7d9f:1"], warning }),
                })
            );
            renderPage();

            const note = await screen.findByText(warning);
            expect(note).toHaveAttribute("role", "note");
        });

        it("activates anyway only after a confirmation that names the copies and what they can't read", async () => {
            const { posts } = mockKeys(
                () =>
                    keysView({
                        keys: TWO_KEYS,
                        rotation: rotationOf("activating", { waitingFor: ["mail-7d9f:1", "mail-9c2b:1"] }),
                    }),
                () =>
                    jsonResponse(
                        200,
                        keysView({
                            keys: [
                                { kid: "aaaa1111", createdAt: daysAgo(190), active: false, envelopes: 12 },
                                { kid: "bbbb2222", createdAt: minutesAgo(3), active: true, envelopes: 0 },
                            ],
                            rotation: rotationOf("reencrypting", {
                                waitingFor: ["mail-7d9f:1", "mail-9c2b:1"],
                                activatedAt: minutesAgo(0),
                                activationForced: {
                                    by: "admin-1",
                                    at: minutesAgo(0),
                                    staleCopies: ["mail-7d9f:1", "mail-9c2b:1"],
                                },
                            }),
                        })
                    )
            );
            const user = userEvent.setup();
            renderPage();

            await user.click(await screen.findByRole("button", { name: "Activate anyway" }));
            const dialog = await screen.findByRole("dialog", { name: "Activate the new key anyway" });
            expect(posts).toEqual([]);
            expect(
                within(dialog).getByText(/can.t read values saved with the new key until they are replaced/)
            ).toBeInTheDocument();
            expect(
                within(dialog)
                    .getAllByRole("listitem")
                    .map((item) => item.textContent)
            ).toEqual(["mail-7d9f:1", "mail-9c2b:1"]);
            await user.click(within(dialog).getByRole("button", { name: "Activate anyway" }));

            await vi.waitFor(() => expect(posts).toEqual([{ path: "activate", body: { kid: "bbbb2222" } }]));
            await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
            // Re-encryption now waits for the same copies, and says so.
            expect(await screen.findByText("Waiting for 2 copies to start using the new key")).toBeInTheDocument();
            expect(screen.getByText(/activated before every copy had loaded it/)).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Activate anyway" })).not.toBeInTheDocument();
        });

        it("names in the confirmation the copies that were waiting when it opened, whatever a later read says", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
            let waitingFor = ["mail-7d9f:1", "mail-9c2b:1"];
            mockKeys(() => keysView({ keys: TWO_KEYS, rotation: rotationOf("activating", { waitingFor }) }));
            renderPage();

            fireEvent.click(await screen.findByRole("button", { name: "Activate anyway" }));
            const dialog = await screen.findByRole("dialog", { name: "Activate the new key anyway" });
            waitingFor = ["mail-aaaa:1"];
            await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
            // The page behind has moved on; the dialog still names what the administrator was shown.
            await screen.findByText("Waiting for 1 copy to load the new key", {}, { hidden: true });
            expect(
                within(dialog)
                    .getAllByRole("listitem")
                    .map((item) => item.textContent)
            ).toEqual(["mail-7d9f:1", "mail-9c2b:1"]);
        });

        it("says in the confirmation that no copy is left to wait for when the list was empty as it opened", async () => {
            mockKeys(() => keysView({ keys: TWO_KEYS, rotation: rotationOf("activating", { waitingFor: [] }) }));
            const user = userEvent.setup();
            renderPage();

            await user.click(await screen.findByRole("button", { name: "Activate anyway" }));
            const dialog = await screen.findByRole("dialog", { name: "Activate the new key anyway" });
            expect(within(dialog).queryByRole("list")).not.toBeInTheDocument();
            expect(within(dialog).getByText(/No copy is waiting for the new key now/)).toBeInTheDocument();
        });

        it("keeps the confirmation open with the server's refusal", async () => {
            mockKeys(
                () => keysView({ keys: TWO_KEYS, rotation: rotationOf("activating", { waitingFor: ["mail-7d9f:1"] }) }),
                () => jsonResponse(403, { message: "Requires elevation.", code: "api-104" })
            );
            const user = userEvent.setup();
            renderPage();

            await user.click(await screen.findByRole("button", { name: "Activate anyway" }));
            const dialog = await screen.findByRole("dialog", { name: "Activate the new key anyway" });
            await user.click(within(dialog).getByRole("button", { name: "Activate anyway" }));

            expect(await within(dialog).findByText(/recently confirmed your identity/)).toBeInTheDocument();
            expect(screen.getByRole("dialog")).toBeInTheDocument();
        });

        it("follows a 409 when the key was activated meanwhile, closing the confirmation", async () => {
            mockKeys(
                () => keysView({ keys: TWO_KEYS, rotation: rotationOf("activating", { waitingFor: ["mail-7d9f:1"] }) }),
                () => jsonResponse(409, keysView({ keys: TWO_KEYS, rotation: rotationOf("reencrypting") }))
            );
            const user = userEvent.setup();
            renderPage();

            await user.click(await screen.findByRole("button", { name: "Activate anyway" }));
            await user.click(
                within(await screen.findByRole("dialog")).getByRole("button", { name: "Activate anyway" })
            );

            expect(await screen.findByText("Re-encrypting saved values with the new key.")).toBeInTheDocument();
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
            expect(screen.getByText(/no longer waiting to be activated/)).toBeInTheDocument();
        });

        it("offers Activate anyway only while the key waits to be activated", async () => {
            mockKeys(() => keysView({ keys: TWO_KEYS, rotation: rotationOf("reencrypting") }));
            renderPage();

            await screen.findByText("Re-encrypting saved values with the new key.");
            expect(screen.queryByRole("button", { name: "Activate anyway" })).not.toBeInTheDocument();
        });

        it("counts the values left on an earlier key while re-encrypting", async () => {
            mockKeys(() =>
                keysView({
                    keys: [
                        { kid: "aaaa1111", createdAt: daysAgo(190), active: false, envelopes: 3 },
                        { kid: "bbbb2222", createdAt: minutesAgo(10), active: true, envelopes: 9 },
                    ],
                    rotation: rotationOf("reencrypting"),
                })
            );
            renderPage();

            expect(
                await screen.findByText("3 values are still on an earlier key; 9 are on the new one.")
            ).toBeInTheDocument();
        });

        it("says the new key is being activated once no copy is left to wait for", async () => {
            mockKeys(() => keysView({ keys: TWO_KEYS, rotation: rotationOf("activating", { waitingFor: [] }) }));
            renderPage();

            expect(await screen.findByText("Activating the new key.")).toBeInTheDocument();
            expect(
                screen.queryByRole("list", { name: "Copies that haven't loaded the new key" })
            ).not.toBeInTheDocument();
        });

        it("counts a single value in the singular, and a key with no count as none", async () => {
            mockKeys(() =>
                keysView({
                    keys: [
                        { kid: "aaaa1111", createdAt: daysAgo(190), active: false, envelopes: 1 },
                        { kid: "bbbb2222", createdAt: minutesAgo(10), active: true, envelopes: 1 },
                    ],
                    rotation: rotationOf("reencrypting"),
                })
            );
            renderPage();

            expect(
                await screen.findByText("1 value is still on an earlier key; 1 is on the new one.")
            ).toBeInTheDocument();
        });

        it("counts the new key as holding none while only the older key has been counted", async () => {
            mockKeys(() =>
                keysView({
                    keys: [
                        { kid: "aaaa1111", createdAt: daysAgo(190), active: false, envelopes: 4 },
                        { kid: "bbbb2222", createdAt: minutesAgo(10), active: true },
                    ],
                    rotation: rotationOf("reencrypting"),
                })
            );
            renderPage();

            expect(
                await screen.findByText("4 values are still on an earlier key; 0 are on the new one.")
            ).toBeInTheDocument();
        });

        it("says nothing of a count the server has not made", async () => {
            mockKeys(() =>
                keysView({
                    keys: [
                        { kid: "aaaa1111", createdAt: daysAgo(190), active: false },
                        { kid: "bbbb2222", createdAt: minutesAgo(10), active: true },
                    ],
                    rotation: rotationOf("reencrypting"),
                })
            );
            renderPage();

            await screen.findByText("Re-encrypting saved values with the new key.");
            expect(screen.queryByText(/still on an earlier key/)).not.toBeInTheDocument();
        });

        it("says the old key is being removed while retiring", async () => {
            mockKeys(() => keysView({ keys: TWO_KEYS, rotation: rotationOf("retiring") }));
            renderPage();

            expect(await screen.findByText("Removing the old key from the keyring.")).toBeInTheDocument();
        });

        it("shows what the rotation failed on, and offers to start again", async () => {
            mockKeys(() =>
                keysView({
                    rotation: rotationOf("failed", { kid: undefined, lastError: "The keyring can't be parsed." }),
                })
            );
            renderPage();

            expect(await screen.findByText("The keyring can't be parsed.")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Rotate configuration key" })).toBeEnabled();
        });

        it("shows the error of a rotation that is still running", async () => {
            mockKeys(() =>
                keysView({
                    keys: TWO_KEYS,
                    rotation: rotationOf("adding", { lastError: "The keyring write was refused." }),
                })
            );
            renderPage();

            expect(await screen.findByText("The keyring write was refused.")).toBeInTheDocument();
        });

        it("lists the values re-encryption could not decrypt, by record and field, never by value", async () => {
            mockKeys(() =>
                keysView({
                    reencryption: {
                        targetKid: "bbbb2222",
                        complete: true,
                        startedAt: minutesAgo(2),
                        unreadable: [
                            {
                                record: "DnsProvider",
                                uid: "cloudflare-ab12cd34",
                                field: "credentials.apiToken",
                                kid: "cccc3333",
                            },
                        ],
                    },
                })
            );
            renderPage();

            expect(await screen.findByText(/couldn.t be decrypted/)).toBeInTheDocument();
            expect(
                screen.getByText("DnsProvider cloudflare-ab12cd34, credentials.apiToken (key cccc3333)")
            ).toBeInTheDocument();
        });

        it("says when the list of values that can't be read was made, and that it changes only when a pass runs", async () => {
            mockKeys(() =>
                keysView({
                    reencryption: {
                        targetKid: "bbbb2222",
                        complete: true,
                        startedAt: minutesAgo(91),
                        finishedAt: minutesAgo(90),
                        unreadable: [
                            {
                                record: "DnsProvider",
                                uid: "cloudflare-ab12cd34",
                                field: "credentials.apiToken",
                                kid: "cccc3333",
                            },
                        ],
                    },
                })
            );
            renderPage();

            expect(
                await screen.findByText(/This list was made by the re-encryption pass that finished/)
            ).toBeInTheDocument();
            expect(screen.getByText(/only a later pass updates it/)).toBeInTheDocument();
        });

        it("reads the progress again every few seconds while a rotation runs, and stops when it is done", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
            let state: any = keysView({
                keys: TWO_KEYS,
                rotation: rotationOf("activating", { waitingFor: ["mail-7d9f:1"] }),
            });
            const { reads } = mockKeys(() => state);
            renderPage();

            expect(await screen.findByText("Waiting for 1 copy to load the new key")).toBeInTheDocument();
            expect(reads.count).toBe(1);

            state = keysView({ keys: TWO_KEYS, rotation: rotationOf("reencrypting") });
            await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
            expect(await screen.findByText("Re-encrypting saved values with the new key.")).toBeInTheDocument();
            expect(reads.count).toBe(2);

            state = keysView({
                keys: [{ kid: "bbbb2222", createdAt: minutesAgo(10), active: true, envelopes: 12 }],
                rotation: rotationOf("done", { finishedAt: minutesAgo(0) }),
            });
            await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
            expect(await screen.findByText(/The last rotation finished/)).toBeInTheDocument();
            expect(reads.count).toBe(3);

            // Nothing is running, so nothing is asked again.
            await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
            expect(reads.count).toBe(3);
        });

        it("says so when a later read fails, keeps what is shown and recovers on the next one", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
            const running = keysView({
                keys: TWO_KEYS,
                rotation: rotationOf("activating", { waitingFor: ["mail-7d9f:1"] }),
            });
            let answer: () => Response | any = () => running;
            mockKeys(() => answer());
            renderPage();

            expect(await screen.findByText("Waiting for 1 copy to load the new key")).toBeInTheDocument();
            answer = () => jsonResponse(500, { message: "The database is down." });
            await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
            expect(await screen.findByText(/Couldn.t refresh the progress/)).toBeInTheDocument();
            expect(screen.getByText(/The database is down./)).toBeInTheDocument();
            expect(screen.getByText("Waiting for 1 copy to load the new key")).toBeInTheDocument();

            answer = () => running;
            await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
            await vi.waitFor(() => expect(screen.queryByText(/Couldn.t refresh the progress/)).not.toBeInTheDocument());
        });

        it("keeps the page when a later read finds no route, as an older pod answering during an upgrade would", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
            let answer: () => Response | any = () => keysView({ keys: TWO_KEYS, rotation: rotationOf("adding") });
            mockKeys(() => answer());
            renderPage();

            await screen.findByText("Adding the new key to the keyring.");
            answer = () => jsonResponse(404, { message: "Not Found" });
            await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
            expect(await screen.findByText(/Couldn.t refresh the progress/)).toBeInTheDocument();
            expect(screen.getByText("Adding the new key to the keyring.")).toBeInTheDocument();
            expect(screen.queryByText(/doesn.t offer configuration encryption yet/)).not.toBeInTheDocument();
        });

        it("does not poll while no rotation is running", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
            const { reads } = mockKeys(() => keysView());
            renderPage();

            await screen.findByText("No rotation is in progress.");
            await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
            expect(reads.count).toBe(1);
        });

        it("stops polling when the page is closed", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
            const { reads } = mockKeys(() => keysView({ keys: TWO_KEYS, rotation: rotationOf("adding") }));
            const { unmount } = renderPage();

            await screen.findByText("Adding the new key to the keyring.");
            unmount();
            await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
            expect(reads.count).toBe(1);
        });
    });

    describe("after a rotation", () => {
        const finished = (over: Record<string, unknown> = {}) =>
            keysView({
                keys: [{ kid: "bbbb2222", createdAt: daysAgo(1), active: true, envelopes: 12 }],
                rotation: rotationOf("done", { finishedAt: minutesAgo(1), ...over }),
            });

        it("reminds the administrator to back up the keyring again", async () => {
            mockKeys(() => finished());
            renderPage();

            expect(await screen.findByText(/The last rotation finished/)).toBeInTheDocument();
            const note = screen.getByText(/Back up the keyring again/);
            expect(note).toHaveAttribute("role", "note");
            expect(screen.getByRole("button", { name: "Rotate configuration key" })).toBeEnabled();
            // A normal rotation says nothing of the credentials.
            expect(screen.queryByText(/replace the credentials/)).not.toBeInTheDocument();
        });

        it("reminds the administrator to replace the credentials at their providers after a compromised rotation", async () => {
            mockKeys(() => finished({ compromised: true }));
            renderPage();

            const note = await screen.findByText(/replace the credentials saved here at their providers/);
            expect(note).toHaveAttribute("role", "note");
            expect(screen.getByText(/exposed together with a copy of the database/)).toBeInTheDocument();
            expect(screen.getByText(/Back up the keyring again/)).toBeInTheDocument();
        });

        it("keeps the credential reminder for a compromised rotation that failed, and says a plain restart drops the compromise", async () => {
            mockKeys(() =>
                keysView({
                    rotation: rotationOf("failed", {
                        kid: undefined,
                        compromised: true,
                        lastError: "The keyring can't be read.",
                    }),
                })
            );
            renderPage();

            expect(await screen.findByText("The keyring can't be read.")).toBeInTheDocument();
            expect(screen.getByText(/replace the credentials saved here at their providers/)).toBeInTheDocument();
            expect(screen.getByText(/doesn.t carry that over/)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Key compromised: rotate now" })).toBeEnabled();
        });

        it("says nothing of a compromise for a plain rotation that failed", async () => {
            mockKeys(() =>
                keysView({
                    rotation: rotationOf("failed", { kid: undefined, lastError: "The keyring can't be read." }),
                })
            );
            renderPage();

            await screen.findByText("The keyring can't be read.");
            expect(screen.queryByText(/doesn.t carry that over/)).not.toBeInTheDocument();
        });

        it("words a finished rotation with no finish time", async () => {
            mockKeys(() => finished({ finishedAt: undefined }));
            renderPage();

            expect(await screen.findByText("The last rotation has finished.")).toBeInTheDocument();
        });

        it("makes no backup reminder of a rotation that is still running", async () => {
            mockKeys(() => keysView({ keys: TWO_KEYS, rotation: rotationOf("retiring") }));
            renderPage();

            await screen.findByText("Removing the old key from the keyring.");
            expect(screen.queryByText(/Back up the keyring again/)).not.toBeInTheDocument();
        });
    });

    describe("plugin secret settings", () => {
        it("says they are encrypted, and since when", async () => {
            mockKeys(() => keysView({ pluginSecrets: { encryptedAt: "2026-10-01T12:00:00.000Z" } }));
            renderPage();

            expect(await screen.findByRole("heading", { name: "Plugin secret settings" })).toBeInTheDocument();
            expect(
                screen.getByText(`Encrypted since ${new Date("2026-10-01T12:00:00.000Z").toLocaleString()}.`)
            ).toBeInTheDocument();
        });

        it("says they wait for the server's rollout, with the reason", async () => {
            mockKeys(() =>
                keysView({
                    pluginSecrets: {
                        waitingForRollout: true,
                        checkedAt: minutesAgo(1),
                        reason: "Pod mail-old-1 still runs the previous release.",
                    },
                })
            );
            renderPage();

            expect(await screen.findByText(/Not encrypted yet/)).toBeInTheDocument();
            expect(screen.getByText("Pod mail-old-1 still runs the previous release.")).toBeInTheDocument();
            expect(screen.getByText(/saved as plain text until/)).toBeInTheDocument();
        });

        it("says they are not yet encrypted when the server has not recorded anything", async () => {
            mockKeys(() => keysView({ pluginSecrets: null }));
            renderPage();

            expect(await screen.findByText(/Not encrypted yet/)).toBeInTheDocument();
            expect(screen.queryByText(/Encrypted since/)).not.toBeInTheDocument();
        });
    });
});

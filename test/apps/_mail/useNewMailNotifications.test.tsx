// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    DESKTOP_BURST_LIMIT,
    DESKTOP_BURST_WINDOW_MS,
    TOAST_DURATION_MS,
    useNewMailNotifications,
} from "../../../apps/shared/mail/useNewMailNotifications.js";
import { MAX_VISIBLE, dismiss, dismissAll, getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";

/** The mail pop-ups on screen (they are `mail` notifications - the store owns the stack), by message uid. */
const popups = () => getNotificationsSnapshot().visible.filter((item) => item.kind === "mail");
const popupUids = () => popups().map((item) => item.id.replace(/^mail:/, ""));
import { DESKTOP_OFFER_KEY, NEW_MAIL_POPUPS_KEY } from "../../../apps/shared/mail/newMailNotifications.js";

/** A stand-in for the browser's `Notification` that records what was shown. */
class FakeNotification {
    static instances: FakeNotification[] = [];
    static permission: NotificationPermission = "granted";
    static requestPermission = vi.fn(async () => FakeNotification.permission);
    static throwOnCreate = false;
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(
        public title: string,
        public options: NotificationOptions,
    ) {
        if (FakeNotification.throwOnCreate) {
            throw new TypeError("Illegal constructor");
        }
        FakeNotification.instances.push(this);
    }
}

function setTab(state: { visible?: boolean; focused?: boolean }) {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (state.visible === false ? "hidden" : "visible") });
    vi.spyOn(document, "hasFocus").mockReturnValue(state.focused !== false);
}

const MAILBOXES = [{ uid: "mb1", primarySmtpAddress: "me@example.com", aliasAddresses: ["alias@example.com"] }] as any[];
const FOLDERS = [
    {
        mailbox: MAILBOXES[0],
        folders: [
            { uid: "inbox", type: "inbox" },
            { uid: "sent", type: "sent_items" },
        ],
    },
] as any[];

function mail(uid: string, overrides: Record<string, unknown> = {}) {
    return {
        uid,
        folderUid: "inbox",
        mailboxUid: "mb1",
        subject: `Subject ${uid}`,
        from: { address: "jane@example.com", displayName: "Jane Doe", type: "to" },
        receivedDate: new Date().toISOString(),
        bodyPreview: `Preview ${uid}`,
        flags: { read: false },
        ...overrides,
    } as any;
}

function setup(open?: (href: string) => void) {
    return renderHook(() => useNewMailNotifications({ mailboxes: MAILBOXES, mailboxFolders: FOLDERS, open }));
}

beforeEach(() => {
    FakeNotification.instances = [];
    FakeNotification.permission = "granted";
    FakeNotification.throwOnCreate = false;
    FakeNotification.requestPermission.mockClear();
    vi.stubGlobal("Notification", FakeNotification);
    setTab({});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    // @ts-expect-error - restore jsdom's own getter
    delete document.visibilityState;
});

describe("useNewMailNotifications", () => {
    describe("in-app pop-ups", () => {
        it("shows one for unread mail arriving in an Inbox", () => {
            const { result } = setup();
            act(() => result.current.announce(mail("m1")));
            expect(popups()).toEqual([
                expect.objectContaining({
                    id: "mail:m1",
                    kind: "mail",
                    title: "Jane Doe",
                    subtitle: "<jane@example.com>",
                    message: "Subject m1",
                    preview: "Preview m1",
                    href: "/messages/m1",
                    sticky: false,
                    actions: [],
                }),
            ]);
            // Not kept in the history: the inbox holds it.
            expect(getNotificationsSnapshot().history).toEqual([]);
        });

        it("shows the address alone for a sender with no name, and no preview line for an empty one", () => {
            const { result } = setup();
            act(() => result.current.announce(mail("m1", { from: { address: "bare@example.com", type: "to" }, bodyPreview: "" })));
            expect(popups()[0]).toMatchObject({ title: "bare@example.com", subtitle: undefined, preview: undefined });
        });

        it("goes by itself after eight seconds", () => {
            vi.useFakeTimers();
            const { result } = setup();
            act(() => result.current.announce(mail("m1")));
            vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
            expect(popups()).toHaveLength(1);
            vi.advanceTimersByTime(1);
            expect(popups()).toHaveLength(0);
        });

        it("ignores mail that is not worth announcing: another folder, already read, sent by the user (or an alias), or a message it already showed", () => {
            const { result } = setup();
            act(() => {
                result.current.announce(mail("in-sent", { folderUid: "sent" }));
                result.current.announce(mail("read", { flags: { read: true } }));
                result.current.announce(mail("mine", { from: { address: "Me@Example.com", type: "to" } }));
                result.current.announce(mail("alias", { from: { address: "alias@example.com", type: "to" } }));
                result.current.announce(mail("other", { inferenceClassification: "other" }));
            });
            expect(popups()).toEqual([]);

            act(() => {
                result.current.announce(mail("dup"));
                result.current.announce(mail("dup"));
            });
            expect(popups()).toHaveLength(1);

            // Dismissed, and the same message delivered again: still not shown a second time.
            act(() => dismiss("mail:dup"));
            act(() => result.current.announce(mail("dup")));
            expect(popups()).toEqual([]);
        });

        it("shows nothing while the user has turned pop-ups off, and again once they turn them back on", () => {
            const { result } = setup();
            localStorage.setItem(NEW_MAIL_POPUPS_KEY, "off");
            act(() => result.current.announce(mail("m1")));
            expect(popups()).toEqual([]);
            expect(FakeNotification.instances).toEqual([]);

            localStorage.removeItem(NEW_MAIL_POPUPS_KEY);
            act(() => result.current.announce(mail("m2")));
            expect(popups()).toHaveLength(1);
        });

        it(`keeps at most ${MAX_VISIBLE} on screen, the rest waiting their turn`, () => {
            const { result } = setup();
            act(() => {
                for (const uid of ["a", "b", "c", "d"]) result.current.announce(mail(uid));
            });
            expect(popupUids()).toEqual(["a", "b", "c"]);
            expect(getNotificationsSnapshot().queued).toBe(1);
            act(() => dismiss("mail:a"));
            expect(popupUids()).toEqual(["b", "c", "d"]);
        });

        it("remembers only so many uids, so an old message can be announced again after hundreds of others", () => {
            const { result } = setup();
            act(() => {
                for (let i = 0; i < 502; i++) result.current.announce(mail(`m${i}`));
            });
            act(() => dismissAll());
            // A recent one is still remembered (announcing it again shows nothing); the oldest was forgotten.
            act(() => result.current.announce(mail("m501")));
            expect(popupUids()).toEqual([]);
            act(() => result.current.announce(mail("m0")));
            expect(popupUids()).toEqual(["m0"]);
        });

        it("has a stable announce, for the listener that holds on to it", () => {
            const { result, rerender } = setup();
            const announce = result.current.announce;
            rerender();
            expect(result.current.announce).toBe(announce);
        });
    });

    describe("desktop notifications", () => {
        it("shows one, with the same content, when the tab is hidden", () => {
            setTab({ visible: false });
            const { result } = setup();
            act(() => result.current.announce(mail("m1")));
            expect(FakeNotification.instances).toHaveLength(1);
            expect(FakeNotification.instances[0].title).toBe("Jane Doe <jane@example.com>");
            expect(FakeNotification.instances[0].options).toEqual({ body: "Subject m1\nPreview m1", tag: "m1" });
            // And the pop-up too, for when the reader comes back.
            expect(popups()).toHaveLength(1);
        });

        it("shows one when the tab is visible but another window has the focus", () => {
            setTab({ focused: false });
            const { result } = setup();
            act(() => result.current.announce(mail("m1")));
            expect(FakeNotification.instances).toHaveLength(1);
        });

        it("shows none while the reader is looking at the tab", () => {
            const { result } = setup();
            act(() => result.current.announce(mail("m1")));
            expect(FakeNotification.instances).toEqual([]);
        });

        it("shows none unless permission was granted", () => {
            setTab({ visible: false });
            for (const permission of ["default", "denied"] as const) {
                FakeNotification.permission = permission;
                const { result } = setup();
                act(() => result.current.announce(mail(`m-${permission}`)));
            }
            vi.stubGlobal("Notification", undefined);
            const { result } = setup();
            act(() => result.current.announce(mail("m-none")));
            expect(FakeNotification.instances).toEqual([]);
        });

        it("has no body line for an empty preview", () => {
            setTab({ visible: false });
            const { result } = setup();
            act(() => result.current.announce(mail("m1", { bodyPreview: "" })));
            expect(FakeNotification.instances[0].options.body).toBe("Subject m1");
        });

        it("says 'Encrypted message' for an encrypted one, and never quotes its body", () => {
            setTab({ visible: false });
            const { result } = setup();
            act(() => result.current.announce(mail("m1", { encrypted: true, subject: "[...]", bodyPreview: "Y2lwaGVy" })));
            expect(FakeNotification.instances[0].options.body).toBe("(encrypted subject)\nEncrypted message");
        });

        it("focuses the window, closes the notification and opens the message when clicked", () => {
            setTab({ visible: false });
            const open = vi.fn();
            const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
            const { result } = setup(open);
            act(() => result.current.announce(mail("m1")));

            FakeNotification.instances[0].onclick!();
            expect(focus).toHaveBeenCalled();
            expect(FakeNotification.instances[0].close).toHaveBeenCalled();
            expect(open).toHaveBeenCalledWith("/messages/m1");
        });

        it("navigates the page itself by default", () => {
            setTab({ visible: false });
            const original = window.location;
            const assigned = { href: "" };
            Object.defineProperty(window, "location", { configurable: true, value: assigned });
            vi.spyOn(window, "focus").mockImplementation(() => undefined);
            try {
                const { result } = setup();
                act(() => result.current.announce(mail("m1")));
                FakeNotification.instances[0].onclick!();
                expect(assigned.href).toBe("/messages/m1");
            } finally {
                Object.defineProperty(window, "location", { configurable: true, value: original });
            }
        });

        it(`shows at most ${DESKTOP_BURST_LIMIT} in ${DESKTOP_BURST_WINDOW_MS / 1000} seconds - a flood of mail is a few notifications - and then more again`, () => {
            vi.useFakeTimers();
            setTab({ visible: false });
            const { result } = setup();
            act(() => {
                for (let i = 0; i < DESKTOP_BURST_LIMIT + 3; i++) result.current.announce(mail(`m${i}`));
            });
            expect(FakeNotification.instances).toHaveLength(DESKTOP_BURST_LIMIT);

            vi.advanceTimersByTime(DESKTOP_BURST_WINDOW_MS);
            act(() => result.current.announce(mail("later")));
            expect(FakeNotification.instances).toHaveLength(DESKTOP_BURST_LIMIT + 1);
        });

        it("carries on with the pop-up when the browser refuses to construct a notification", () => {
            setTab({ visible: false });
            FakeNotification.throwOnCreate = true;
            const { result } = setup();
            act(() => result.current.announce(mail("m1")));
            expect(popups()).toHaveLength(1);
            expect(FakeNotification.instances).toEqual([]);
        });
    });

    describe("the offer to turn on desktop notifications", () => {
        it("is made on the pop-up itself - with its explanation and two actions - and that pop-up still goes by itself", () => {
            vi.useFakeTimers();
            FakeNotification.permission = "default";
            const { result } = setup();
            act(() => result.current.announce(mail("m1")));
            expect(popups()[0]).toMatchObject({ sticky: false, hint: expect.stringContaining("desktop notification") });
            expect(popups()[0].actions.map((action) => action.label)).toEqual(["Turn on desktop notifications", "Not now"]);
            vi.advanceTimersByTime(TOAST_DURATION_MS);
            expect(popups()).toHaveLength(0);
        });

        it("is made on one pop-up at a time - not repeated on every pop-up of a burst - and again once that one has gone", () => {
            FakeNotification.permission = "default";
            const { result } = setup();
            act(() => {
                result.current.announce(mail("a"));
                result.current.announce(mail("b"));
            });
            expect(popups().find((item) => item.id === "mail:a")!.actions).toHaveLength(2);
            expect(popups().find((item) => item.id === "mail:b")!.actions).toEqual([]);
            act(() => dismiss("mail:a"));
            act(() => result.current.announce(mail("c")));
            expect(popups().find((item) => item.id === "mail:c")!.actions).toHaveLength(2);
        });

        it("'Turn on desktop notifications' asks the browser, and 'Not now' puts the offer away - neither is offered on the next pop-up", async () => {
            FakeNotification.permission = "default";
            const { result } = setup();
            act(() => result.current.announce(mail("m1")));
            FakeNotification.permission = "granted";
            await act(async () => popups()[0].actions[0].onClick!());
            expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
            act(() => result.current.announce(mail("m2")));
            expect(popups().find((item) => item.id === "mail:m2")!.actions).toEqual([]);

            localStorage.clear();
            FakeNotification.permission = "default";
            // (The pop-up view dismisses a pop-up when one of its actions is used; without the view, the test does it.)
            act(() => dismissAll());
            const declined = setup();
            act(() => declined.result.current.announce(mail("m3")));
            act(() => popups().find((item) => item.id === "mail:m3")!.actions[1].onClick!());
            act(() => dismissAll());
            act(() => declined.result.current.announce(mail("m4")));
            expect(popups().find((item) => item.id === "mail:m4")!.actions).toEqual([]);
        });

        it("is made only while the browser can and hasn't been asked, and nobody said 'Not now'", () => {
            FakeNotification.permission = "default";
            const { result } = setup();
            expect(result.current.offerDesktop).toBe(true);

            for (const permission of ["granted", "denied"] as const) {
                FakeNotification.permission = permission;
                expect(setup().result.current.offerDesktop).toBe(false);
            }

            vi.stubGlobal("Notification", undefined);
            expect(setup().result.current.offerDesktop).toBe(false);
        });

        it("is never made once put away", () => {
            FakeNotification.permission = "default";
            localStorage.setItem(DESKTOP_OFFER_KEY, "later");
            expect(setup().result.current.offerDesktop).toBe(false);
        });

        it("asks the browser only when the user accepts, and doesn't ask again", async () => {
            FakeNotification.permission = "default";
            const { result } = setup();
            expect(FakeNotification.requestPermission).not.toHaveBeenCalled();

            FakeNotification.permission = "granted";
            await act(async () => result.current.enableDesktop());
            expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
            expect(result.current.offerDesktop).toBe(false);
            expect(localStorage.getItem(DESKTOP_OFFER_KEY)).not.toBeNull();
        });

        it("goes away, and stays away, when the browser is refused", async () => {
            FakeNotification.permission = "default";
            const { result } = setup();
            FakeNotification.permission = "denied";
            await act(async () => result.current.enableDesktop());
            expect(result.current.offerDesktop).toBe(false);
            expect(setup().result.current.offerDesktop).toBe(false);
        });

        it("goes away, and stays away, on 'Not now' - without asking the browser anything", () => {
            FakeNotification.permission = "default";
            const { result } = setup();
            act(() => result.current.declineDesktop());
            expect(result.current.offerDesktop).toBe(false);
            expect(localStorage.getItem(DESKTOP_OFFER_KEY)).not.toBeNull();
            expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
            expect(setup().result.current.offerDesktop).toBe(false);
        });
    });
});

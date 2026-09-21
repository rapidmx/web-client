// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// MailShell inside the client-side router: which mailbox and folder it shows follows the URL as the router changes it, without the
// page (or the shell) being reloaded - and its Compose button fetches the compose window's code as the pointer or keyboard
// reaches it.
import React, { useEffect } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import MailShell, { useMailShell } from "../../../apps/shared/components/mail/layout/MailShell.js";
import AppRouter, { useNavigate } from "../../../apps/shared/navigation/AppRouter.js";

vi.mock("@rapidmx/react-shared/crypto/keyvaultApi.js", () => ({
    getKeyVault: vi.fn().mockResolvedValue({ wrappedKeys: [{ fingerprint: "already-enrolled" }], masterKeyWraps: [] }),
    enrollKey: vi.fn(),
    getEncryptionPolicy: vi.fn().mockResolvedValue({ encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional" }),
    lookupKeys: vi.fn().mockResolvedValue({ keys: [] }),
    findActivePublicKey: vi.fn().mockReturnValue(undefined),
}));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({
    MASTER_KEY_AAD_PURPOSE: "master-key",
    ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE: "encrypt-private-key",
    getUnlockedKeys: vi.fn().mockReturnValue({ masterKey: new Uint8Array(32) }),
    unlockWithPassword: vi.fn(),
    destroyUnlockedKeys: vi.fn(),
    subscribeKeySession: vi.fn(() => () => undefined),
}));
vi.mock("../../../apps/shared/search/LocalIndexLifecycle.js", () => ({ default: () => null }));

// The chrome is the stand-in the router's own tests use: here only the shell inside it matters.
vi.mock("../../../apps/shared/components/layout/AppShell.js", async () => {
    const react = await import("react");
    return {
        AppChrome: (props: any) => react.createElement("div", { "data-testid": "chrome" }, props.children),
        default: (props: any) => react.createElement(react.Fragment, null, props.children),
    };
});

const prefetch = vi.hoisted(() => ({ prefetchComposeWindow: vi.fn() }));
vi.mock("../../../apps/shared/components/mail/compose/ComposeContext.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../apps/shared/components/mail/compose/ComposeContext.js")>()),
    prefetchComposeWindow: prefetch.prefetchComposeWindow,
}));

const mailboxA = {
    uid: "mb-a",
    version: 0,
    ownerUserUid: "u1",
    primarySmtpAddress: "a@example.com",
    aliasAddresses: [],
    displayName: "Mailbox A",
};
const folder = (uid: string, type: string, name: string) => ({
    uid,
    version: 0,
    mailboxUid: "mb-a",
    name,
    type,
    unreadCount: 0,
    totalCount: 0,
    syncKeyVersion: 0,
});
const folders = [folder("f-inbox", "inbox", "Inbox"), folder("f-sent", "sent_items", "Sent Items")];

let mounts = 0;
let go: (href: string) => void;

function Probe() {
    const { mailboxUid, folderUid, aggregateFolderType } = useMailShell();
    const navigate = useNavigate();
    go = navigate;
    return <output data-testid="probe">{`${mailboxUid}|${folderUid}|${aggregateFolderType}`}</output>;
}

function Page(props: any) {
    useEffect(() => {
        mounts++;
    }, []);
    return (
        <MailShell {...props}>
            <Probe />
        </MailShell>
    );
}

function renderShell() {
    return render(
        <AppRouter
            routes={[{ path: "/", active: "mail", load: () => Promise.resolve({ default: () => null }) }]}
            initialPath="/"
            initialPage={Page}
            pageProps={{ userUid: "u1" }}
        />,
    );
}

beforeEach(() => {
    mounts = 0;
    window.history.replaceState(null, "", "/");
    mockFetch((url) => {
        if (url.startsWith("/api/mail/mailboxes?")) return jsonResponse(200, [mailboxA]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, folders);
        return jsonResponse(200, []);
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    prefetch.prefetchComposeWindow.mockClear();
});

describe("MailShell in the client-side router", () => {
    it("starts on the Inbox and follows the folder in the URL without remounting the page", async () => {
        window.history.replaceState(null, "", "/?mailboxUid=mb-a&folderUid=f-sent");
        renderShell();
        await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("mb-a|f-sent|undefined"));

        // A click on another folder's link changes the URL and the selection, and nothing else.
        fireEvent.click(await screen.findByRole("link", { name: "Inbox" }));
        await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("mb-a|f-inbox|undefined"));
        expect(window.location.search).toBe("?mailboxUid=mb-a&folderUid=f-inbox");
        expect(mounts).toBe(1);

        act(() => go("/?mailboxUid=mb-a&folderUid=f-sent"));
        await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("mb-a|f-sent|undefined"));
        expect(mounts).toBe(1);
    });

    it("follows an all-mailboxes entry in the URL too", async () => {
        renderShell();
        await screen.findByRole("link", { name: "Inbox" });
        act(() => go("/?aggregate=inbox"));
        await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("undefined|undefined|inbox"));
    });

    it("closes the folder drawer (the phone's folder list) when a folder is chosen from it", async () => {
        const user = userEvent.setup();
        renderShell();
        await user.click(await screen.findByRole("button", { name: "Open folders" }));
        const drawer = screen.getByRole("dialog", { name: "Folders" });
        fireEvent.click(within(drawer).getByRole("link", { name: /Sent Items/ }));

        await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("mb-a|f-sent|undefined"));
        expect(screen.queryByRole("dialog", { name: "Folders" })).not.toBeInTheDocument();
    });

    it("fetches the compose window's code as the pointer or the keyboard reaches Compose", async () => {
        renderShell();
        const compose = await screen.findByRole("button", { name: "Compose" });
        fireEvent.pointerEnter(compose);
        expect(prefetch.prefetchComposeWindow).toHaveBeenCalledTimes(1);
        fireEvent.focus(compose);
        expect(prefetch.prefetchComposeWindow).toHaveBeenCalledTimes(2);
    });
});

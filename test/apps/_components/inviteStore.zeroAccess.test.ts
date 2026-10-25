// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSealedInvites, rememberSealedInvite, sealedInviteCalendar } from "../../../lib/calendar/sealedInvites.js";

const { getMessageInvite, keyListeners } = vi.hoisted(() => ({
    getMessageInvite: vi.fn(),
    keyListeners: [] as ((event: { mailboxUid: string; state: "locked" | "unlocked" }) => void)[],
}));
vi.mock("../../../lib/crypto/keySession.js", () => ({
    getUnlockedKeys: () => ({ zeroAccessKeys: [{}] }),
    subscribeKeySession: (listener: (event: { mailboxUid: string; state: "locked" | "unlocked" }) => void) => {
        keyListeners.push(listener);
        return () => undefined;
    },
}));
vi.mock("../../../lib/calendar/inviteApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/calendar/inviteApi.js")>()),
    getMessageInvite,
}));

const { clearInviteCache, loadInvite, useMessageInvite } = await import("../../../apps/shared/components/mail/invite/inviteStore.js");
const { markSigningOut, clearSigningOut } = await import("../../../apps/shared/components/mail/compose/composeFlushRegistry.js");

afterEach(() => {
    clearSealedInvites();
    clearInviteCache();
    getMessageInvite.mockReset();
});

describe("inviteStore and zero-access messages", () => {
    it("asks again for a message it found no invitation in, once its calendar file has been decrypted here", async () => {
        getMessageInvite.mockResolvedValueOnce(null).mockResolvedValueOnce({ uid: "ical-1", attendees: [], conflicts: [], schedule: [] });

        expect(await loadInvite("za-1")).toBeNull();
        expect(await loadInvite("za-1")).toBeNull();
        expect(getMessageInvite).toHaveBeenCalledTimes(1);

        rememberSealedInvite("za-1", "ICS", "mb1");
        expect(await loadInvite("za-1")).toMatchObject({ uid: "ical-1" });
        expect(getMessageInvite).toHaveBeenCalledTimes(2);
    });

    it("forgets the decrypted calendar files and what was read with them on sign-out", async () => {
        getMessageInvite.mockResolvedValue({ uid: "ical-2", summary: "Secret", attendees: [], conflicts: [], schedule: [] });
        rememberSealedInvite("za-2", "ICS", "mb1");
        await loadInvite("za-2");
        markSigningOut();
        clearSigningOut();
        expect(sealedInviteCalendar("za-2")).toBeUndefined();
        await loadInvite("za-2");
        expect(getMessageInvite).toHaveBeenCalledTimes(2);
    });

    it("takes what a zero-access invitation's file showed off screen when its mailbox locks", async () => {
        getMessageInvite.mockResolvedValue({ uid: "ical-3", summary: "Secret", attendees: [], conflicts: [], schedule: [] });
        rememberSealedInvite("za-3", "ICS", "mb1");
        // Its file decrypted, its invitation never asked for: nothing to take down.
        rememberSealedInvite("za-5", "ICS", "mb1");
        getMessageInvite.mockResolvedValueOnce({ uid: "ical-4", summary: "Plain", attendees: [], conflicts: [], schedule: [] });
        await loadInvite("plain-4");
        const { result } = renderHook(() => useMessageInvite("za-3"));
        await waitFor(() => expect(result.current.invite?.summary).toBe("Secret"));

        keyListeners[0]({ mailboxUid: "mb1", state: "locked" });
        await waitFor(() => expect(result.current.invite).toBeNull());
        expect(result.current.settled).toBe(false);
        // Another message's invitation stays.
        await loadInvite("plain-4");
        expect(getMessageInvite).toHaveBeenCalledTimes(2);
    });
});

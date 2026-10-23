// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSealedInvites, rememberSealedInvite, sealedInviteCalendar } from "../../../lib/calendar/sealedInvites.js";

const { getMessageInvite } = vi.hoisted(() => ({ getMessageInvite: vi.fn() }));
vi.mock("../../../lib/calendar/inviteApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/calendar/inviteApi.js")>()),
    getMessageInvite,
}));

const { loadInvite } = await import("../../../apps/shared/components/mail/invite/inviteStore.js");
const { markSigningOut, clearSigningOut } = await import("../../../apps/shared/components/mail/compose/composeFlushRegistry.js");

afterEach(() => {
    clearSealedInvites();
    getMessageInvite.mockReset();
});

describe("inviteStore and zero-access messages", () => {
    it("asks again for a message it found no invitation in, once its calendar file has been decrypted here", async () => {
        getMessageInvite.mockResolvedValueOnce(null).mockResolvedValueOnce({ uid: "ical-1", attendees: [], conflicts: [], schedule: [] });

        expect(await loadInvite("za-1")).toBeNull();
        expect(await loadInvite("za-1")).toBeNull();
        expect(getMessageInvite).toHaveBeenCalledTimes(1);

        rememberSealedInvite("za-1", "ICS");
        expect(await loadInvite("za-1")).toMatchObject({ uid: "ical-1" });
        expect(getMessageInvite).toHaveBeenCalledTimes(2);
    });

    it("forgets the decrypted calendar files on sign-out", () => {
        rememberSealedInvite("za-2", "ICS");
        markSigningOut();
        clearSigningOut();
        expect(sealedInviteCalendar("za-2")).toBeUndefined();
    });
});

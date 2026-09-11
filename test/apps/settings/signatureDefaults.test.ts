// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { clearPreviousDefaults } from "../../../apps/www/settings/signatures/signatureDefaults.js";
import { MailSignature } from "@rapidmx/react-shared/mailSignaturesApi.js";

function signatureFixture(overrides: Partial<MailSignature> = {}): MailSignature {
    return {
        uid: "sig1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        name: "Default",
        contentHtml: "",
        isDefaultForNewMessages: false,
        isDefaultForReplyForward: false,
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("clearPreviousDefaults", () => {
    it("does nothing when no other signature has either default flag set", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        await clearPreviousDefaults([signatureFixture({ uid: "sig2" })], "sig1", true, true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("turns off isDefaultForNewMessages on the other signature that currently has it", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        const other = signatureFixture({ uid: "sig2", version: 3, isDefaultForNewMessages: true });
        await clearPreviousDefaults([other], "sig1", true, false);

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mail-signatures/sig2",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "sig2", version: 3, isDefaultForNewMessages: false }),
            }),
        );
    });

    it("turns off isDefaultForReplyForward on the other signature that currently has it", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        const other = signatureFixture({ uid: "sig2", isDefaultForReplyForward: true });
        await clearPreviousDefaults([other], "sig1", false, true);

        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body).toEqual({ uid: "sig2", version: 0, isDefaultForReplyForward: false });
    });

    it("turns off both flags in one PUT when the same other signature holds both", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        const other = signatureFixture({ uid: "sig2", isDefaultForNewMessages: true, isDefaultForReplyForward: true });
        await clearPreviousDefaults([other], "sig1", true, true);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body).toEqual({ uid: "sig2", version: 0, isDefaultForNewMessages: false, isDefaultForReplyForward: false });
    });

    it("skips the signature currently being saved, even if it already has a default flag set", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        const self = signatureFixture({ uid: "sig1", isDefaultForNewMessages: true });
        await clearPreviousDefaults([self], "sig1", true, false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not toggle a flag that isn't newly being turned on, even if some other signature has it", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        const other = signatureFixture({ uid: "sig2", isDefaultForNewMessages: true });
        // Saving with isDefaultForNewMessages: false — this signature isn't claiming that default, so
        // nothing else needs to give it up.
        await clearPreviousDefaults([other], "sig1", false, false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("handles savingUid being undefined (a brand-new, not-yet-created signature)", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        const other = signatureFixture({ uid: "sig2", isDefaultForNewMessages: true });
        await clearPreviousDefaults([other], undefined, true, false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("updates every other signature that needs clearing, not just the first", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        const a = signatureFixture({ uid: "sig-a", isDefaultForNewMessages: true });
        const b = signatureFixture({ uid: "sig-b", isDefaultForReplyForward: true });
        await clearPreviousDefaults([a, b], "sig1", true, true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

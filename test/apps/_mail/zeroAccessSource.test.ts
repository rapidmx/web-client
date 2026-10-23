// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../testUtils.js";
import { zeroAccessSourceBase64 } from "../../../apps/shared/mail/zeroAccessSource.js";
import { reportNotice } from "../../../apps/shared/mail/reportNotices.js";

const { getUnlockedKeys, openZeroAccessMessage } = vi.hoisted(() => ({ getUnlockedKeys: vi.fn(), openZeroAccessMessage: vi.fn() }));
vi.mock("../../../lib/crypto/keySession.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/crypto/keySession.js")>()),
    getUnlockedKeys,
}));
vi.mock("../../../lib/crypto/messageSecurity.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/crypto/messageSecurity.js")>()),
    openZeroAccessMessage,
}));

const sealed = { uid: "m1", mailboxUid: "mb1", zeroAccess: { keyFingerprint: "fp", sealedSummary: "s" } };

afterEach(() => {
    vi.unstubAllGlobals();
    getUnlockedKeys.mockReset();
    openZeroAccessMessage.mockReset();
});

describe("zeroAccessSourceBase64", () => {
    it("decrypts a zero-access message's stored copy with the unlocked keys and base64-encodes the original's bytes", async () => {
        const keys = { masterKey: new Uint8Array(1) };
        getUnlockedKeys.mockReturnValue(keys);
        openZeroAccessMessage.mockResolvedValue("Subject: é\r\n\r\nbody");
        mockFetch(() => new Response("sealed copy", { status: 200 }));

        const source = await zeroAccessSourceBase64(sealed);

        expect(openZeroAccessMessage).toHaveBeenCalledWith("sealed copy", keys);
        expect(Buffer.from(source!, "base64")).toEqual(Buffer.from("Subject: é\r\n\r\nbody", "latin1"));
    });

    it("has nothing for another message, while the mailbox is locked, or when the copy won't open or load", async () => {
        expect(await zeroAccessSourceBase64({ uid: "m1", mailboxUid: "mb1" })).toBeUndefined();
        expect(await zeroAccessSourceBase64(sealed)).toBeUndefined();

        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(1) });
        openZeroAccessMessage.mockResolvedValue(undefined);
        mockFetch(() => new Response("sealed copy", { status: 200 }));
        expect(await zeroAccessSourceBase64(sealed)).toBeUndefined();

        mockFetch(() => new Response("nope", { status: 500 }));
        expect(await zeroAccessSourceBase64(sealed)).toBeUndefined();
    });
});

describe("reportNotice for a zero-access message reported while locked", () => {
    it("says why the spam filter didn't learn from it", () => {
        const notice = reportNotice({ uid: "m1", kind: "junk", folderUid: "j", moved: true, learned: false, learnSkipped: "zero_access" }, "Hi", false);
        expect(notice.hint).toBe("Not used to train the spam filter: unlock your mailbox to let it learn from protected mail.");
    });
});

// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../../lib/util/api.js";
import {
    VAULT_GENERATION_TTL_MS,
    clearVerificationSealCache,
    currentVerificationSeal,
    getVaultGeneration,
    readVaultGeneration,
    sendVerificationSeal,
    verificationSealPending,
} from "../../../apps/shared/components/mail/verificationSeals.js";

const { getKeyVault, setMessageVerificationSeal, keySessionListeners } = vi.hoisted(() => ({
    getKeyVault: vi.fn(),
    setMessageVerificationSeal: vi.fn(),
    keySessionListeners: new Set<(event: { mailboxUid: string; state: "locked" | "unlocked" }) => void>(),
}));
vi.mock("../../../lib/crypto/keyvaultApi.js", () => ({ getKeyVault }));
vi.mock("../../../lib/mail/mailApi.js", () => ({ setMessageVerificationSeal }));
vi.mock("../../../lib/crypto/keySession.js", () => ({
    subscribeKeySession: (listener: (event: { mailboxUid: string; state: "locked" | "unlocked" }) => void) => {
        keySessionListeners.add(listener);
        return () => keySessionListeners.delete(listener);
    },
}));

afterEach(() => {
    clearVerificationSealCache();
    getKeyVault.mockReset();
    setMessageVerificationSeal.mockReset();
    vi.restoreAllMocks();
});

describe("vault generation", () => {
    it("threads an optional ApiClient through to getKeyVault, for a multi-account host app", async () => {
        const client = {} as never;
        getKeyVault.mockResolvedValue({ masterKeyGeneration: 7 });
        expect(await readVaultGeneration("mb1", client)).toBe(7);
        expect(getKeyVault).toHaveBeenCalledWith("mb1", client);
        expect(await getVaultGeneration("mb2", client)).toBe(7);
        expect(getKeyVault).toHaveBeenCalledWith("mb2", client);
    });

    it("reads a non-negative integer generation, and nothing else", async () => {
        getKeyVault.mockResolvedValueOnce({ masterKeyGeneration: 0 }).mockResolvedValueOnce({ masterKeyGeneration: 1.5 }).mockRejectedValueOnce(new Error("down"));
        expect(await readVaultGeneration("mb1")).toBe(0);
        expect(await readVaultGeneration("mb1")).toBeUndefined();
        expect(await readVaultGeneration("mb1")).toBeUndefined();
    });

    it("caches a mailbox's generation until the TTL runs out or keys lock", async () => {
        getKeyVault.mockResolvedValue({ masterKeyGeneration: 2 });
        expect(await getVaultGeneration("mb1")).toBe(2);
        expect(await getVaultGeneration("mb1")).toBe(2);
        expect(getKeyVault).toHaveBeenCalledTimes(1);

        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now + VAULT_GENERATION_TTL_MS + 1);
        getKeyVault.mockResolvedValue({ masterKeyGeneration: 3 });
        expect(await getVaultGeneration("mb1")).toBe(3);
        expect(getKeyVault).toHaveBeenCalledTimes(2);

        for (const listener of keySessionListeners) listener({ mailboxUid: "mb1", state: "unlocked" });
        expect(await getVaultGeneration("mb1")).toBe(3);
        expect(getKeyVault).toHaveBeenCalledTimes(2);
        for (const listener of keySessionListeners) listener({ mailboxUid: "mb1", state: "locked" });
        getKeyVault.mockResolvedValue({ masterKeyGeneration: 4 });
        expect(await getVaultGeneration("mb1")).toBe(4);
    });

    it("doesn't drop a newer cache entry when an older unavailable read settles", async () => {
        let resolveFirst!: (vault: unknown) => void;
        getKeyVault.mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve))).mockResolvedValue({ masterKeyGeneration: 5 });
        const first = getVaultGeneration("mb1");
        clearVerificationSealCache();
        expect(await getVaultGeneration("mb1")).toBe(5);
        resolveFirst({});
        expect(await first).toBeUndefined();
        expect(await getVaultGeneration("mb1")).toBe(5);
        expect(getKeyVault).toHaveBeenCalledTimes(2);
    });
});

describe("seal writes", () => {
    it("threads an optional ApiClient through to setMessageVerificationSeal, for a multi-account host app", async () => {
        const client = {} as never;
        setMessageVerificationSeal.mockResolvedValue({});
        expect(await sendVerificationSeal("m9", { seal: "s9", masterKeyGeneration: 1 }, client)).toBe(true);
        expect(setMessageVerificationSeal).toHaveBeenCalledWith("m9", "s9", 1, client);
    });

    it("writes once per message and generation, and remembers the stored seal", async () => {
        setMessageVerificationSeal.mockResolvedValue({});
        expect(verificationSealPending("m1", 2)).toBe(true);
        expect(await sendVerificationSeal("m1", { seal: "s2", masterKeyGeneration: 2 })).toBe(true);
        expect(verificationSealPending("m1", 2)).toBe(false);
        expect(await sendVerificationSeal("m1", { seal: "s2b", masterKeyGeneration: 2 })).toBe(false);
        expect(setMessageVerificationSeal).toHaveBeenCalledTimes(1);
        // `undefined`: no explicit `ApiClient` was passed, the same as before this call started passing
        // its (optional) `client` through.
        expect(setMessageVerificationSeal).toHaveBeenCalledWith("m1", "s2", 2, undefined);

        expect(currentVerificationSeal({ uid: "m1" })).toEqual({ seal: "s2", sealGeneration: 2 });
        expect(currentVerificationSeal({ uid: "m1", verificationSeal: "old", verificationSealGeneration: 1 })).toEqual({ seal: "s2", sealGeneration: 2 });
        // The message's own copy caught up (or moved past) the stored one.
        expect(currentVerificationSeal({ uid: "m1", verificationSeal: "server", verificationSealGeneration: 2 })).toEqual({ seal: "server", sealGeneration: 2 });
        expect(currentVerificationSeal({ uid: "m2" })).toEqual({ seal: undefined, sealGeneration: undefined });
    });

    it.each([400, 403, 404, 409])("treats a %s as final", async (status) => {
        setMessageVerificationSeal.mockRejectedValue(new ApiRequestError("no", status));
        expect(await sendVerificationSeal("m1", { seal: "s", masterKeyGeneration: 1 })).toBe(true);
        expect(verificationSealPending("m1", 1)).toBe(false);
        expect(currentVerificationSeal({ uid: "m1" })).toEqual({ seal: undefined, sealGeneration: undefined });
    });

    it.each([new ApiRequestError("down", 503), new Error("network")])("lets a later write retry after %s", async (err) => {
        setMessageVerificationSeal.mockRejectedValueOnce(err).mockResolvedValue({});
        expect(await sendVerificationSeal("m1", { seal: "s", masterKeyGeneration: 1 })).toBe(true);
        expect(verificationSealPending("m1", 1)).toBe(true);
        expect(await sendVerificationSeal("m1", { seal: "s", masterKeyGeneration: 1 })).toBe(true);
        expect(setMessageVerificationSeal).toHaveBeenCalledTimes(2);
    });
});

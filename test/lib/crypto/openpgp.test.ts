// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as openpgp from "openpgp";
import { describe, expect, it } from "vitest";
import { fromBase64, toBase64 } from "../../../lib/crypto/encoding.js";
import {
    armorPublicKey,
    certifyWithPredecessor,
    exportProtectedSecretKey,
    generateOpenPgpKey,
    keyEmails,
    publicKeyBase64,
    readPublicKey,
    readPublicKeys,
    readSecretKey,
} from "../../../lib/crypto/openpgp.js";

describe("openpgp", () => {
    it("generates a v6 key that never expires, with the address as its user ID", async () => {
        const generated = await generateOpenPgpKey("Alice@Example.com", "Alice");
        expect(generated.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(generated.armoredPublicKey).toContain("-----BEGIN PGP PUBLIC KEY BLOCK-----");
        const certificate = (await readPublicKey(generated.publicKey))!;
        expect(certificate.getFingerprint()).toBe(generated.fingerprint);
        expect(certificate.keyPacket.version).toBe(6);
        expect(await certificate.getExpirationTime()).toBe(Infinity);
        expect(certificate.getUserIDs()).toEqual(["Alice <Alice@Example.com>"]);
        expect(await keyEmails(certificate)).toEqual(["alice@example.com"]);

        const secret = await readSecretKey(generated.secretKey);
        expect(secret.isPrivate()).toBe(true);
        expect(publicKeyBase64(secret)).toBe(generated.publicKey);
        expect(publicKeyBase64(certificate)).toBe(generated.publicKey);
        expect(armorPublicKey(certificate)).toBe(generated.armoredPublicKey);
    });

    it("names the address alone when there is no display name", async () => {
        const generated = await generateOpenPgpKey("bob@example.com");
        expect((await readPublicKey(generated.publicKey))!.getUserIDs()).toEqual(["<bob@example.com>"]);
    });

    it("certifies a successor's user ID with the key it replaces", async () => {
        const predecessor = await readSecretKey((await generateOpenPgpKey("alice@example.com")).secretKey);
        const successor = await generateOpenPgpKey("alice@example.com");
        const certified = await certifyWithPredecessor(successor, predecessor);

        expect(certified.fingerprint).toBe(successor.fingerprint);
        const certificate = (await readPublicKey(certified.publicKey))!;
        const [user] = certificate.users;
        expect(user.otherCertifications).toHaveLength(1);
        await expect(user.otherCertifications[0].verify(predecessor.keyPacket, openpgp.enums.signature.certGeneric, { userID: user.userID, key: certificate.keyPacket })).resolves.toBeUndefined();
        expect((await readSecretKey(certified.secretKey)).getFingerprint()).toBe(successor.fingerprint);
        expect(await readPublicKeys(certified.armoredPublicKey)).toHaveLength(1);
    });

    it("reads certificates armored, as base64 or as bytes, and leaves out secret keys and garbage", async () => {
        const alice = await generateOpenPgpKey("alice@example.com");
        const bob = await generateOpenPgpKey("bob@example.com");
        const bytes = new Uint8Array([...fromBase64(alice.publicKey), ...fromBase64(bob.publicKey)]);

        expect((await readPublicKeys(alice.armoredPublicKey)).map((key) => key.getFingerprint())).toEqual([alice.fingerprint]);
        expect((await readPublicKeys(bytes)).map((key) => key.getFingerprint())).toEqual([alice.fingerprint, bob.fingerprint]);
        // Base64 as a MIME part carries it: wrapped across lines.
        const wrapped = toBase64(bytes).replace(/(.{76})/g, "$1\r\n");
        expect(await readPublicKeys(wrapped)).toHaveLength(2);
        expect(await readPublicKeys(alice.secretKey)).toEqual([]);
        expect(await readPublicKeys("not a key")).toEqual([]);
        expect(await readPublicKeys("-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nbroken\n-----END PGP PUBLIC KEY BLOCK-----")).toEqual([]);
        expect(await readPublicKey(toBase64(new Uint8Array([1, 2, 3])))).toBeUndefined();
    });

    it("only names addresses whose user ID carries a valid self-signature", async () => {
        const alice = (await readPublicKey((await generateOpenPgpKey("alice@example.com")).publicKey))!;
        const mallory = (await readPublicKey((await generateOpenPgpKey("mallory@example.com")).publicKey))!;
        // A user ID lifted from another key: its self-signature was made by that other key, so it doesn't verify on this one.
        const [lifted] = mallory.users;
        const forged = new (lifted.constructor as new (userID: unknown, mainKey: unknown) => typeof lifted)(lifted.userID, alice);
        forged.selfCertifications = lifted.selfCertifications;
        alice.users.push(forged);
        expect(await keyEmails(alice)).toEqual(["alice@example.com"]);

        // A user ID that names no address at all.
        const { publicKey } = await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "No address" }], format: "object" });
        expect(await keyEmails(publicKey)).toEqual([]);
    });

    it("exports the secret key protected with a passphrase, leaving the original unlocked", async () => {
        const secret = await readSecretKey((await generateOpenPgpKey("alice@example.com")).secretKey);
        const armored = await exportProtectedSecretKey(secret, "correct horse battery");
        expect(armored).toContain("-----BEGIN PGP PRIVATE KEY BLOCK-----");

        const exported = await openpgp.readPrivateKey({ armoredKey: armored });
        expect(exported.isDecrypted()).toBe(false);
        await expect(openpgp.decryptKey({ privateKey: exported, passphrase: "wrong" })).rejects.toThrow();
        const opened = await openpgp.decryptKey({ privateKey: exported, passphrase: "correct horse battery" });
        expect(opened.getFingerprint()).toBe(secret.getFingerprint());
        expect(secret.isDecrypted()).toBe(true);
    });
});

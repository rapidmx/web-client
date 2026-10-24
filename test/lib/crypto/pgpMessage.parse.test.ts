// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `pgpMessage.ts`'s parsers on messages other OpenPGP apps send, built by hand here: an encrypted message wrapping a separate
// `multipart/signed` (RFC 3156 §6.1, as Thunderbird/Enigmail send it), keys attached deep inside, and malformed input.
import * as openpgp from "openpgp";
import { beforeAll, describe, expect, it } from "vitest";
import { generateOpenPgpKey, readSecretKey, type OpenPgpPrivateKey } from "../../../lib/crypto/openpgp.js";
import { parsePgpCleartextSigned, parsePgpEncryptedMessage, parsePgpInlineEncrypted, parsePgpSignedMessage } from "../../../lib/crypto/pgpMessage.js";

const CRLF = "\r\n";
const SIGNED_TYPE = 'multipart/signed; protocol="application/pgp-signature"; micalg=pgp-sha256; boundary="s"';
const ENCRYPTED_TYPE = 'multipart/encrypted; protocol="application/pgp-encrypted"; boundary="e"';
const bytes = (text: string) => new TextEncoder().encode(text);

let alice: OpenPgpPrivateKey;
let bob: OpenPgpPrivateKey;
let aliceArmored: string;

beforeAll(async () => {
    const generatedAlice = await generateOpenPgpKey("alice@example.com");
    alice = await readSecretKey(generatedAlice.secretKey);
    aliceArmored = generatedAlice.armoredPublicKey.replace(/\r?\n/g, CRLF).trim();
    bob = await readSecretKey((await generateOpenPgpKey("bob@example.com")).secretKey);
});

/** `text` wrapped in `depth` levels of `multipart/mixed`. */
function nest(text: string, depth: number): string {
    let entity = text;
    for (let level = 0; level < depth; level++) {
        entity = [`Content-Type: multipart/mixed; boundary="n${level}"`, "", `--n${level}`, entity, `--n${level}--`].join(CRLF);
    }
    return entity;
}

/** A `multipart/signed` body over `signedPart`, signed by `signer`. */
async function signedBody(signedPart: string, signer: OpenPgpPrivateKey): Promise<string> {
    const signature = await openpgp.sign({ message: await openpgp.createMessage({ binary: bytes(signedPart) }), signingKeys: signer, detached: true });
    return ["--s", signedPart, "--s", "Content-Type: application/pgp-signature", "", String(signature).trim(), "--s--", ""].join(CRLF);
}

/** A `multipart/encrypted` body carrying `entity` encrypted to `recipient`, signed by `signer` when given. */
async function encryptedBody(entity: string, recipient: OpenPgpPrivateKey, signer?: OpenPgpPrivateKey): Promise<string> {
    const armored = await openpgp.encrypt({
        message: await openpgp.createMessage({ binary: bytes(entity) }),
        encryptionKeys: recipient.toPublic(),
        ...(signer ? { signingKeys: signer } : {}),
    });
    return ["--e", "Content-Type: application/pgp-encrypted", "", "Version: 1", "--e", "Content-Type: application/octet-stream", "", String(armored).trim(), "--e--", ""].join(CRLF);
}

const keyPart = () => ["Content-Type: application/pgp-keys", "", aliceArmored].join(CRLF);
const textPart = ["Content-Type: text/plain", "", "Hello"].join(CRLF);

describe("parsePgpSignedMessage", () => {
    it("finds a key attached a few levels down, but no deeper than four", async () => {
        const mixed = ['Content-Type: multipart/mixed; boundary="m"', "", "--m", textPart, "--m", keyPart(), "--m--"].join(CRLF);
        const shallow = nest(mixed, 2);
        expect((await parsePgpSignedMessage(SIGNED_TYPE, await signedBody(shallow, alice), [])).signature).toMatchObject({ status: "verified" });

        const deep = nest(keyPart(), 6);
        expect((await parsePgpSignedMessage(SIGNED_TYPE, await signedBody(deep, alice), [])).signature).toEqual({ status: "unknown_key" });
    });

    it("calls a body that isn't exactly a signed part and a signature invalid", async () => {
        expect(await parsePgpSignedMessage(SIGNED_TYPE, ["--s", textPart, "--s--", ""].join(CRLF), [])).toEqual({ decrypted: true, signature: { status: "invalid" } });
        expect(await parsePgpSignedMessage("multipart/signed", "", [])).toEqual({ decrypted: true, signature: { status: "invalid" } });
    });
});

describe("parsePgpEncryptedMessage", () => {
    it("verifies a multipart/signed message encrypted as a whole", async () => {
        const signed = [`Content-Type: ${SIGNED_TYPE}`, "", await signedBody(textPart, alice)].join(CRLF);
        const parsed = await parsePgpEncryptedMessage(ENCRYPTED_TYPE, await encryptedBody(signed, bob), [bob], [{ key: alice.toPublic(), trusted: true }]);
        expect(parsed.decrypted).toBe(true);
        expect(parsed.entityText).toBe(textPart);
        expect(parsed.signature).toMatchObject({ status: "verified", candidate: { trusted: true } });

        // A broken inner signed message keeps the whole decrypted entity, its signature invalid.
        const broken = [`Content-Type: ${SIGNED_TYPE}`, "", ["--s", textPart, "--s--", ""].join(CRLF)].join(CRLF);
        const parsedBroken = await parsePgpEncryptedMessage(ENCRYPTED_TYPE, await encryptedBody(broken, bob), [bob], []);
        expect(parsedBroken.entityText).toBe(broken);
        expect(parsedBroken.signature).toEqual({ status: "invalid" });
    });

    it("reports a signature nobody's key can check as unknown_key", async () => {
        const parsed = await parsePgpEncryptedMessage(ENCRYPTED_TYPE, await encryptedBody(textPart, bob, alice), [bob], []);
        expect(parsed).toEqual({ decrypted: true, entityText: textPart, signature: { status: "unknown_key" } });
    });
});

describe("inline messages", () => {
    it("can't decrypt without a key, and calls an unreadable cleartext signature invalid", async () => {
        const armored = String(await openpgp.encrypt({ message: await openpgp.createMessage({ text: "secret" }), encryptionKeys: bob.toPublic() }));
        expect(await parsePgpInlineEncrypted(armored, [], [])).toEqual({ decrypted: false });
        expect(await parsePgpCleartextSigned("-----BEGIN PGP SIGNED MESSAGE-----\r\n\r\nnot really\r\n-----END PGP SIGNATURE-----", [])).toEqual({
            decrypted: true,
            signature: { status: "invalid" },
        });
    });
});

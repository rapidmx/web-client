// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { TIER3_DECRYPT_CONCURRENCY, TIER3_MAX_HTML_LENGTH, searchEncryptedCandidates, stripHtml } from "../../../lib/search/searchTier3.js";
import { ParsedSearchQuery } from "../../../lib/search/queryGrammar.js";
import { UnlockedKeys } from "../../../lib/crypto/keySession.js";
import { ProtectedHeaders, applyBaselineOuterHeaders, assembleOutboundMime, buildEncryptedMessage } from "../../../lib/crypto/smimeMessage.js";

x509.cryptoProvider.set(crypto);

interface TestIdentity {
    certDer: Uint8Array;
    privateKey: CryptoKey;
}

async function generateTestIdentity(cn: string): Promise<TestIdentity> {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "01",
        name: `CN=${cn}`,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 86_400_000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys,
    });
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    return { certDer: new Uint8Array(cert.rawData), privateKey };
}

function baseParsedQuery(overrides: Partial<ParsedSearchQuery> = {}): ParsedSearchQuery {
    return { text: "", ...overrides };
}

async function buildEncryptedRawMime(bodyText: string, headers: ProtectedHeaders, recipient: TestIdentity): Promise<string> {
    const part = await buildEncryptedMessage("text/plain; charset=utf-8", bodyText, headers, applyBaselineOuterHeaders(headers), [
        recipient.certDer,
    ]);
    return assembleOutboundMime(headers, part);
}

const HEADERS: ProtectedHeaders = {
    from: "alice@example.com",
    to: "bob@example.com",
    date: "Wed, 11 Jan 2023 16:08:43 -0500",
    subject: "Quarterly budget review",
    messageId: "<abc123@example.com>",
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("searchEncryptedCandidates", () => {
    it("returns [] without making any request when unlocked is undefined", async () => {
        const fetchMock = mockFetch(() => {
            throw new Error("should not be called");
        });
        const result = await searchEncryptedCandidates(baseParsedQuery({ text: "budget" }), undefined);
        expect(result).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns [] without making any request when unlocked was destroyed after it was read (round-4 review)", async () => {
        const fetchMock = mockFetch(() => {
            throw new Error("should not be called");
        });
        const stale = { masterKey: new Uint8Array(32), destroyed: true } as UnlockedKeys;
        expect(await searchEncryptedCandidates(baseParsedQuery({ text: "budget" }), stale)).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns [] when unlocked is destroyed while candidates are being fetched/decrypted (round-5 review)", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const raw = await buildEncryptedRawMime("Here is the quarterly budget figures.", HEADERS, bob);
        mockFetch((url) => {
            if (url.includes("/search/candidates")) {
                return jsonResponse(200, {
                    candidates: [
                        { entityType: "message", entityUid: "m1" },
                        { entityType: "message", entityUid: "m2" },
                    ],
                });
            }
            if (url.includes("/messages/m2/raw")) {
                unlocked.destroyed = true;
            }
            return new Response(raw, { status: 200 });
        });

        expect(await searchEncryptedCandidates(baseParsedQuery({ text: "budget" }), unlocked)).toEqual([]);
    });

    it("returns [] without making any request when the query has no free text and no structured filter", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const fetchMock = mockFetch(() => {
            throw new Error("should not be called");
        });
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const result = await searchEncryptedCandidates(baseParsedQuery(), unlocked);
        expect(result).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("finds a match that only exists in the decrypted body, discards a non-matching candidate", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;

        const matchingRaw = await buildEncryptedRawMime("Here is the quarterly budget figures.", HEADERS, bob);
        const nonMatchingRaw = await buildEncryptedRawMime("Just checking in, no relation.", { ...HEADERS, subject: "Hi" }, bob);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) {
                return jsonResponse(200, {
                    candidates: [
                        { entityType: "message", entityUid: "m1" },
                        { entityType: "message", entityUid: "m2" },
                    ],
                });
            }
            if (url.includes("/messages/m1/raw")) return new Response(matchingRaw, { status: 200 });
            if (url.includes("/messages/m2/raw")) return new Response(nonMatchingRaw, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        const result = await searchEncryptedCandidates(baseParsedQuery({ text: "budget" }), unlocked);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ entityType: "message", entityUid: "m1", source: "candidate", metadataOnly: false });
        expect(result[0].score).toBeGreaterThan(0);
        expect(result[0].snippet).toContain("budget");
    });

    it("builds a snippet with ellipses on both sides when the match is in the middle of a long body", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const longBody = `${"padding ".repeat(20)}the actual budget figure is here${" trailing".repeat(20)}`;
        const raw = await buildEncryptedRawMime(longBody, HEADERS, bob);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) return jsonResponse(200, { candidates: [{ entityType: "message", entityUid: "m1" }] });
            if (url.includes("/messages/m1/raw")) return new Response(raw, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        const result = await searchEncryptedCandidates(baseParsedQuery({ text: "budget" }), unlocked);
        expect(result[0].snippet).toMatch(/^…/);
        expect(result[0].snippet).toMatch(/…$/);
        expect(result[0].snippet).toContain("budget");
    });

    it("falls back to matching/snippeting the subject when the body is empty", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const raw = await buildEncryptedRawMime("", { ...HEADERS, subject: "Quarterly budget review" }, bob);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) return jsonResponse(200, { candidates: [{ entityType: "message", entityUid: "m1" }] });
            if (url.includes("/messages/m1/raw")) return new Response(raw, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        const result = await searchEncryptedCandidates(baseParsedQuery({ text: "budget" }), unlocked);
        expect(result).toHaveLength(1);
        expect(result[0].snippet).toContain("Quarterly budget review");
    });

    it("snippets around whichever query term matches earliest, regardless of the order terms were typed in", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const raw = await buildEncryptedRawMime("alpha appears first, and zeta appears much later in the text.", HEADERS, bob);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) return jsonResponse(200, { candidates: [{ entityType: "message", entityUid: "m1" }] });
            if (url.includes("/messages/m1/raw")) return new Response(raw, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        // "zeta" is typed first but "alpha" appears earlier in the body - the snippet should still be
        // built around "alpha" (the earliest actual match), not the first-typed term.
        const result = await searchEncryptedCandidates(baseParsedQuery({ text: "zeta alpha" }), unlocked);
        expect(result[0].snippet).toContain("alpha appears first");
    });

    it("keeps the earliest match when a later-checked term matches further along in the text", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const raw = await buildEncryptedRawMime("alpha appears first, and zeta appears much later in the text.", HEADERS, bob);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) return jsonResponse(200, { candidates: [{ entityType: "message", entityUid: "m1" }] });
            if (url.includes("/messages/m1/raw")) return new Response(raw, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        // "alpha" is typed first and also appears first in the body - "zeta" (checked second) matches
        // later in the text and must NOT displace the already-found earlier match.
        const result = await searchEncryptedCandidates(baseParsedQuery({ text: "alpha zeta" }), unlocked);
        expect(result[0].snippet).toContain("alpha appears first");
    });

    it("builds a snippet from the start of the body for a pure-operator query with no free text", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const raw = await buildEncryptedRawMime("Completely unrelated content up front.", HEADERS, bob);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) return jsonResponse(200, { candidates: [{ entityType: "message", entityUid: "m1" }] });
            if (url.includes("/messages/m1/raw")) return new Response(raw, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        const result = await searchEncryptedCandidates(baseParsedQuery({ flags: ["flagged"] }), unlocked);
        expect(result[0].snippet).toContain("Completely unrelated content up front.");
    });

    it("skips a candidate that fails to fetch, without discarding the rest", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const matchingRaw = await buildEncryptedRawMime("Here is the quarterly budget figures.", HEADERS, bob);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) {
                return jsonResponse(200, {
                    candidates: [
                        { entityType: "message", entityUid: "gone" },
                        { entityType: "message", entityUid: "m1" },
                    ],
                });
            }
            if (url.includes("/messages/gone/raw")) return new Response(null, { status: 404, statusText: "not found" });
            if (url.includes("/messages/m1/raw")) return new Response(matchingRaw, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        const result = await searchEncryptedCandidates(baseParsedQuery({ text: "budget" }), unlocked);
        expect(result).toHaveLength(1);
        expect(result[0].entityUid).toBe("m1");
    });

    it("derives candidate participants from from/to/cc and forwards every other structured filter", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const fetchMock = mockFetch((url) => {
            if (url.includes("/search/candidates")) return jsonResponse(200, { candidates: [] });
            throw new Error(`unexpected ${url}`);
        });

        const before = new Date("2026-06-01T00:00:00.000Z");
        const after = new Date("2026-01-01T00:00:00.000Z");
        await searchEncryptedCandidates(
            baseParsedQuery({
                from: "alice@example.com",
                to: "bob@example.com",
                cc: "carol@example.com",
                before,
                after,
                folderUid: "f1",
                flags: ["flagged"],
                labels: ["l1"],
            }),
            unlocked,
        );

        const [url] = fetchMock.mock.calls[0];
        const params = new URLSearchParams((url as string).split("?")[1]);
        expect(params.get("types")).toBe("message");
        expect(params.get("participants")).toBe("alice@example.com,bob@example.com,carol@example.com");
        expect(params.get("before")).toBe(before.toISOString());
        expect(params.get("after")).toBe(after.toISOString());
        expect(params.get("in")).toBe("f1");
        expect(params.get("is")).toBe("flagged");
        expect(params.get("label")).toBe("l1");
    });

    it("treats every successfully decrypted candidate as a match for a pure-operator query (no free text)", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const raw = await buildEncryptedRawMime("Completely unrelated content.", HEADERS, bob);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) return jsonResponse(200, { candidates: [{ entityType: "message", entityUid: "m1" }] });
            if (url.includes("/messages/m1/raw")) return new Response(raw, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        const result = await searchEncryptedCandidates(baseParsedQuery({ flags: ["flagged"] }), unlocked);
        expect(result).toHaveLength(1);
        expect(result[0].entityUid).toBe("m1");
    });

    it("skips a candidate whose content couldn't be recovered at all (e.g. unprotected or a failed decrypt)", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;

        mockFetch((url) => {
            if (url.includes("/search/candidates")) return jsonResponse(200, { candidates: [{ entityType: "message", entityUid: "m1" }] });
            if (url.includes("/messages/m1/raw")) {
                return new Response("From: alice@example.com\r\nContent-Type: text/plain\r\n\r\nplain text, not protected at all", {
                    status: 200,
                });
            }
            throw new Error(`unexpected ${url}`);
        });

        const result = await searchEncryptedCandidates(baseParsedQuery({ text: "plain" }), unlocked);
        expect(result).toEqual([]);
    });

    it("matches a quoted phrase only when it appears as a whole, not as separate words in any order", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        // A neutral subject (not HEADERS's own "Quarterly budget review") - otherwise the subject alone
        // would satisfy the phrase for both messages regardless of body content.
        const neutralHeaders: ProtectedHeaders = { ...HEADERS, subject: "Update" };
        const matchingRaw = await buildEncryptedRawMime("The quarterly budget review is attached.", neutralHeaders, bob);
        const nonMatchingRaw = await buildEncryptedRawMime("The budget for this quarterly review is separate.", neutralHeaders, bob);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) {
                return jsonResponse(200, {
                    candidates: [
                        { entityType: "message", entityUid: "m1" },
                        { entityType: "message", entityUid: "m2" },
                    ],
                });
            }
            if (url.includes("/messages/m1/raw")) return new Response(matchingRaw, { status: 200 });
            if (url.includes("/messages/m2/raw")) return new Response(nonMatchingRaw, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        const result = await searchEncryptedCandidates(baseParsedQuery({ text: '"quarterly budget"' }), unlocked);
        expect(result).toHaveLength(1);
        expect(result[0].entityUid).toBe("m1");
        expect(result[0].snippet).toContain("quarterly budget review");
    });

    it("excludes a candidate whose content contains a negated term", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const excludedRaw = await buildEncryptedRawMime("Here is the draft budget figures.", HEADERS, bob);
        const keptRaw = await buildEncryptedRawMime("Here is the final budget figures.", HEADERS, bob);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) {
                return jsonResponse(200, {
                    candidates: [
                        { entityType: "message", entityUid: "m1" },
                        { entityType: "message", entityUid: "m2" },
                    ],
                });
            }
            if (url.includes("/messages/m1/raw")) return new Response(excludedRaw, { status: 200 });
            if (url.includes("/messages/m2/raw")) return new Response(keptRaw, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        const result = await searchEncryptedCandidates(baseParsedQuery({ text: "budget -draft" }), unlocked);
        expect(result).toHaveLength(1);
        expect(result[0].entityUid).toBe("m2");
    });

    it("matches a candidate satisfying either side of an OR query", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        // A neutral subject (not HEADERS's own "Quarterly budget review") - otherwise "budget" in the
        // subject would satisfy the query for every message regardless of body content.
        const neutralHeaders: ProtectedHeaders = { ...HEADERS, subject: "Update" };
        const forecastRaw = await buildEncryptedRawMime("The forecast numbers are attached.", neutralHeaders, bob);
        const budgetRaw = await buildEncryptedRawMime("The budget numbers are attached.", neutralHeaders, bob);
        const neitherRaw = await buildEncryptedRawMime("Nothing relevant here at all.", neutralHeaders, bob);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) {
                return jsonResponse(200, {
                    candidates: [
                        { entityType: "message", entityUid: "m1" },
                        { entityType: "message", entityUid: "m2" },
                        { entityType: "message", entityUid: "m3" },
                    ],
                });
            }
            if (url.includes("/messages/m1/raw")) return new Response(forecastRaw, { status: 200 });
            if (url.includes("/messages/m2/raw")) return new Response(budgetRaw, { status: 200 });
            if (url.includes("/messages/m3/raw")) return new Response(neitherRaw, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        const result = await searchEncryptedCandidates(baseParsedQuery({ text: "budget OR forecast" }), unlocked);
        expect(result.map((r) => r.entityUid).sort()).toEqual(["m1", "m2"]);
    });

    it("treats a literal quoted \"OR\" as a phrase to match, not as a group separator", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const raw = await buildEncryptedRawMime("Approved OR denied, pending review.", HEADERS, bob);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) return jsonResponse(200, { candidates: [{ entityType: "message", entityUid: "m1" }] });
            if (url.includes("/messages/m1/raw")) return new Response(raw, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        const result = await searchEncryptedCandidates(baseParsedQuery({ text: '"approved OR denied"' }), unlocked);
        expect(result).toHaveLength(1);
    });

    it("matches unconditionally when the free text is nothing but a bare OR (no actual terms on either side)", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const raw = await buildEncryptedRawMime("Completely unrelated content.", HEADERS, bob);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) return jsonResponse(200, { candidates: [{ entityType: "message", entityUid: "m1" }] });
            if (url.includes("/messages/m1/raw")) return new Response(raw, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        // An edge case with no real terms at all (every OR-separated group ends up empty) - falls back to
        // matching unconditionally, the same as an empty query text.
        const result = await searchEncryptedCandidates(baseParsedQuery({ text: "OR" }), unlocked);
        expect(result).toHaveLength(1);
    });

    it("ignores an empty quoted phrase in the free text rather than treating it as a real term", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const raw = await buildEncryptedRawMime("Here is the quarterly budget figures.", HEADERS, bob);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) return jsonResponse(200, { candidates: [{ entityType: "message", entityUid: "m1" }] });
            if (url.includes("/messages/m1/raw")) return new Response(raw, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        // An accidental empty pair of quotes alongside a real term - the empty phrase must contribute no
        // requirement of its own (an empty string is trivially a substring of anything, so treating it as
        // a real term would be harmless here, but it must not be counted/highlighted as a match either).
        const result = await searchEncryptedCandidates(baseParsedQuery({ text: '"" budget' }), unlocked);
        expect(result).toHaveLength(1);
        expect(result[0].snippet).toContain("budget");
    });

    it("gives every candidate the same flat score for an all-negated query, matching Tier 1's own degenerate ts_rank for the same query shape", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const neutralHeaders: ProtectedHeaders = { ...HEADERS, subject: "Update" };
        const rawA = await buildEncryptedRawMime("Here is the final report, nothing excluded.", neutralHeaders, bob);
        const rawB = await buildEncryptedRawMime("Here is a much longer final report with extra unrelated padding.", neutralHeaders, bob);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) {
                return jsonResponse(200, {
                    candidates: [
                        { entityType: "message", entityUid: "m1" },
                        { entityType: "message", entityUid: "m2" },
                    ],
                });
            }
            if (url.includes("/messages/m1/raw")) return new Response(rawA, { status: 200 });
            if (url.includes("/messages/m2/raw")) return new Response(rawB, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        // No positive term exists to differentiate on - both candidates that pass the negation filter
        // get the same flat score, exactly like a pure-operator query with no free text at all. This is
        // intentional (see countTermOccurrences()'s own doc comment), not an oversight: Tier 1's
        // ts_rank() degrades identically for an all-negative tsquery, so both tiers tie together rather
        // than Tier 3 being unfairly disadvantaged relative to a genuinely-differentiated Tier 1 batch.
        const result = await searchEncryptedCandidates(baseParsedQuery({ text: "-spam -junk" }), unlocked);
        expect(result).toHaveLength(2);
        expect(result[0].score).toBe(result[1].score);
    });

    it("honors subject: against the decrypted subject, case-insensitively", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const rawA = await buildEncryptedRawMime("Body mentions nothing relevant.", { ...HEADERS, subject: "Quarterly BUDGET review" }, bob);
        const rawB = await buildEncryptedRawMime("This body talks about the budget though.", { ...HEADERS, subject: "Lunch" }, bob);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) {
                return jsonResponse(200, {
                    candidates: [
                        { entityType: "message", entityUid: "m1" },
                        { entityType: "message", entityUid: "m2" },
                    ],
                });
            }
            if (url.includes("/messages/m1/raw")) return new Response(rawA, { status: 200 });
            if (url.includes("/messages/m2/raw")) return new Response(rawB, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        const result = await searchEncryptedCandidates(baseParsedQuery({ subject: "budget" }), unlocked);
        expect(result.map((r) => r.entityUid)).toEqual(["m1"]);
    });

    it("honors has:attachment via Message.hasAttachments, skipping the decrypt for a mismatch", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const raw = await buildEncryptedRawMime("Budget attached.", HEADERS, bob);

        const fetchMock = mockFetch((url) => {
            if (url.includes("/search/candidates")) {
                return jsonResponse(200, {
                    candidates: [
                        { entityType: "message", entityUid: "with" },
                        { entityType: "message", entityUid: "without" },
                    ],
                });
            }
            if (url.endsWith("/messages/with")) return jsonResponse(200, { uid: "with", hasAttachments: true });
            if (url.endsWith("/messages/without")) return jsonResponse(200, { uid: "without", hasAttachments: false });
            if (url.includes("/messages/with/raw")) return new Response(raw, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        const withAttachment = await searchEncryptedCandidates(baseParsedQuery({ hasAttachment: true }), unlocked);
        expect(withAttachment.map((r) => r.entityUid)).toEqual(["with"]);
        expect(fetchMock.mock.calls.some((c) => (c[0] as string).includes("/messages/without/raw"))).toBe(false);

        const withoutAttachment = await searchEncryptedCandidates(baseParsedQuery({ hasAttachment: false }), unlocked);
        expect(withoutAttachment).toEqual([]);
    });

    it("matches against a text/html body's stripped text", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const part = await buildEncryptedMessage(
            "text/html; charset=utf-8",
            "<p>The <b>budget</b> &amp; forecast</p>",
            HEADERS,
            applyBaselineOuterHeaders(HEADERS),
            [bob.certDer],
        );
        const raw = assembleOutboundMime(HEADERS, part);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) return jsonResponse(200, { candidates: [{ entityType: "message", entityUid: "m1" }] });
            if (url.includes("/messages/m1/raw")) return new Response(raw, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        const result = await searchEncryptedCandidates(baseParsedQuery({ text: '"budget & forecast"' }), unlocked);
        expect(result).toHaveLength(1);
        expect(result[0].snippet).not.toContain("<b>");
    });

    it("matches on the decrypted subject alone when the body has no displayable text part", async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const part = await buildEncryptedMessage("application/octet-stream", "opaque bytes", HEADERS, applyBaselineOuterHeaders(HEADERS), [
            bob.certDer,
        ]);
        const raw = assembleOutboundMime(HEADERS, part);

        mockFetch((url) => {
            if (url.includes("/search/candidates")) return jsonResponse(200, { candidates: [{ entityType: "message", entityUid: "m1" }] });
            if (url.includes("/messages/m1/raw")) return new Response(raw, { status: 200 });
            throw new Error(`unexpected ${url}`);
        });

        const result = await searchEncryptedCandidates(baseParsedQuery({ text: "budget" }), unlocked);
        expect(result).toHaveLength(1);
        expect(result[0].snippet).toBe("Quarterly budget review");
    });

    it("forwards mailboxUid to the candidates request", async () => {
        const unlocked = { masterKey: new Uint8Array(32) } as UnlockedKeys;
        const fetchMock = mockFetch(() => jsonResponse(200, { candidates: [] }));
        await searchEncryptedCandidates(baseParsedQuery({ text: "budget" }), unlocked, 10, { mailboxUid: "mb2" });
        const params = new URLSearchParams((fetchMock.mock.calls[0][0] as string).split("?")[1]);
        expect(params.get("mailboxUid")).toBe("mb2");
        expect(params.get("limit")).toBe("10");
    });

    it(`never fetches/decrypts more than ${TIER3_DECRYPT_CONCURRENCY} candidates at once`, async () => {
        const bob = await generateTestIdentity("bob@example.com");
        const unlocked = { masterKey: new Uint8Array(32), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer } as UnlockedKeys;
        const raw = await buildEncryptedRawMime("budget", HEADERS, bob);
        const uids = Array.from({ length: 10 }, (_, i) => `m${i}`);
        let inFlight = 0;
        let maxInFlight = 0;

        mockFetch(async (url) => {
            if (url.includes("/search/candidates")) {
                return jsonResponse(200, { candidates: uids.map((entityUid) => ({ entityType: "message", entityUid })) });
            }
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            return new Response(raw, { status: 200 });
        });

        const result = await searchEncryptedCandidates(baseParsedQuery({ text: "budget" }), unlocked);
        expect(result.map((r) => r.entityUid)).toEqual(uids);
        expect(maxInFlight).toBeLessThanOrEqual(TIER3_DECRYPT_CONCURRENCY);
        expect(maxInFlight).toBeGreaterThan(1);
    });
});

describe("stripHtml (round-4 review)", () => {
    // PoC redos.mjs: the old `/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi` took over a second on 280 KB of
    // repeated unclosed `<style>` tags, growing 4x per doubling.
    it("strips repeated unclosed <style> tags in linear time", () => {
        const hostile = "<style>".repeat(200_000);
        const started = performance.now();
        expect(stripHtml(hostile)).toBe("");
        expect(performance.now() - started).toBeLessThan(500);
    });

    it("drops script/style elements with their content, and other tags become spaces", () => {
        expect(stripHtml('<p>a</p><STYLE type="text/css">p{}</style >b<script>x()</SCRIPT>c<br/>d')).toBe("a b c d");
        expect(stripHtml("<style>one</style>keep<style>two</style>")).toBe("keep");
        expect(stripHtml("<scripts>kept</scripts>")).toBe("kept");
    });

    it("drops only the tag of an unclosed script, keeps `<>` and an unterminated `<` as text, and decodes entities", () => {
        expect(stripHtml("<script>visible")).toBe("visible");
        expect(stripHtml("<style>a</style")).toBe("");
        expect(stripHtml("1 <> 2 &lt;3&gt; &amp; &quot;q&quot; &#039;s&#39; &nbsp;x < 4")).toBe(`1 <> 2 <3> & "q" 's' x < 4`);
    });

    it("ignores content past TIER3_MAX_HTML_LENGTH", () => {
        const html = `${"a".repeat(TIER3_MAX_HTML_LENGTH - 1)} tail-marker`;
        expect(stripHtml(html)).not.toContain("tail-marker");
    });
});

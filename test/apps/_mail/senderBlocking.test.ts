// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    BLOCK_RULE_PREFIX,
    NEVER_BLOCK_RULE_PREFIX,
    blockSender,
    neverBlockSender,
    normalizeAddresses,
    removeSenderRule,
} from "../../../apps/shared/mail/senderBlocking.js";

// Block and Never block are mail filter rules; the rules API is the server, stood in for here.
const api = vi.hoisted(() => ({
    listMailFilterRules: vi.fn(),
    createMailFilterRule: vi.fn(),
    updateMailFilterRule: vi.fn(),
    deleteMailFilterRule: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/mail/mailFilterRulesApi.js", () => api);

const MAILBOX = "mb1";
const JUNK = "f-junk";
const INBOX = "f-inbox";

function rule(overrides: Record<string, unknown> = {}) {
    return {
        uid: "r1",
        version: 3,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: MAILBOX,
        name: "Block a@x.com",
        enabled: true,
        sequence: -1,
        stopProcessingRules: true,
        conditions: { fromContains: ["a@x.com"] },
        actions: [{ type: "move_to_folder", folderUid: JUNK }],
        ...overrides,
    };
}

beforeEach(() => {
    api.listMailFilterRules.mockResolvedValue([]);
    api.createMailFilterRule.mockImplementation(async (input: Record<string, unknown>) => rule({ uid: "new", ...input }));
    api.updateMailFilterRule.mockImplementation(async (input: Record<string, unknown>) => rule({ ...input, version: 4 }));
    api.deleteMailFilterRule.mockResolvedValue(undefined);
});

describe("normalizeAddresses", () => {
    it("lowercases, trims and de-duplicates, and leaves out what is not an address", () => {
        expect(normalizeAddresses([" A@X.com ", "a@x.com", undefined, "", "nobody", "b@y.org"])).toEqual(["a@x.com", "b@y.org"]);
    });
});

describe("blockSender", () => {
    it("makes a rule that moves the sender's mail to Junk and stops, ahead of every other rule", async () => {
        api.listMailFilterRules.mockResolvedValue([rule({ uid: "other", sequence: 4, name: "Files", conditions: { subjectContains: ["x"] } }), rule({ uid: "low", sequence: -3, conditions: { fromContains: ["z@z.com"] } })]);
        const result = await blockSender(MAILBOX, ["a@x.com", "bounce@list.x.com"], JUNK, INBOX);
        expect(result.outcome).toBe("created");
        expect(api.listMailFilterRules).toHaveBeenCalledWith(MAILBOX, { limit: 500 });
        expect(api.createMailFilterRule).toHaveBeenCalledWith({
            mailboxUid: MAILBOX,
            name: `${BLOCK_RULE_PREFIX}a@x.com`,
            sequence: -4,
            stopProcessingRules: true,
            conditions: { fromContains: ["a@x.com", "bounce@list.x.com"] },
            actions: [{ type: "move_to_folder", folderUid: JUNK }],
        });
    });

    it("starts a mailbox with no rules below zero, so it is still first", async () => {
        await blockSender(MAILBOX, ["a@x.com"], JUNK, INBOX);
        expect(api.createMailFilterRule).toHaveBeenCalledWith(expect.objectContaining({ sequence: -1 }));
    });

    it("makes nothing when the sender is already blocked, whatever the rule is called or the case of its address", async () => {
        api.listMailFilterRules.mockResolvedValue([rule({ name: "My own name", conditions: { fromContains: ["A@X.com", "extra@x.com"] } })]);
        const result = await blockSender(MAILBOX, ["a@x.com"], JUNK, INBOX);
        expect(result.outcome).toBe("existing");
        expect(result.rule.uid).toBe("r1");
        expect(api.createMailFilterRule).not.toHaveBeenCalled();
        expect(api.updateMailFilterRule).not.toHaveBeenCalled();
    });

    it("turns a block that was switched off back on, sending the whole rule", async () => {
        api.listMailFilterRules.mockResolvedValue([rule({ enabled: false })]);
        const result = await blockSender(MAILBOX, ["a@x.com"], JUNK, INBOX);
        expect(result.outcome).toBe("enabled");
        expect(api.updateMailFilterRule).toHaveBeenCalledWith({
            uid: "r1",
            version: 3,
            name: "Block a@x.com",
            enabled: true,
            sequence: -1,
            stopProcessingRules: true,
            conditions: { fromContains: ["a@x.com"] },
            actions: [{ type: "move_to_folder", folderUid: JUNK }],
        });
    });

    it.each([
        ["one that does not stop processing", { stopProcessingRules: false }],
        ["one that also matches on the subject", { conditions: { fromContains: ["a@x.com"], subjectContains: ["hi"] } }],
        ["one that files somewhere else", { actions: [{ type: "move_to_folder", folderUid: "f-other" }] }],
        ["one that does more than move", { actions: [{ type: "move_to_folder", folderUid: JUNK }, { type: "mark_as_read" }] }],
        ["one for another sender", { conditions: { fromContains: ["b@x.com"] } }],
        ["one that leaves out the envelope address", { conditions: { fromContains: ["a@x.com"] } }],
    ])("does not take %s for the block, and makes its own", async (_name, overrides) => {
        api.listMailFilterRules.mockResolvedValue([rule(overrides)]);
        const result = await blockSender(MAILBOX, ["a@x.com", "envelope@list.x.com"], JUNK, INBOX);
        expect(result.outcome).toBe("created");
    });

    it("takes away the rule that keeps this sender in the Inbox, since the two would fight", async () => {
        const keep = rule({ uid: "keep", version: 8, name: "Never block a@x.com", actions: [{ type: "move_to_folder", folderUid: INBOX }] });
        api.listMailFilterRules.mockResolvedValue([keep]);
        const result = await blockSender(MAILBOX, ["a@x.com"], JUNK, INBOX);
        expect(api.deleteMailFilterRule).toHaveBeenCalledWith("keep", 8);
        expect(result.outcome).toBe("created");
    });
});

describe("neverBlockSender", () => {
    it("makes a rule that keeps the sender's mail in the Inbox and stops, first", async () => {
        const result = await neverBlockSender(MAILBOX, ["a@x.com"], JUNK, INBOX);
        expect(result).toMatchObject({ outcome: "created", removed: [] });
        expect(api.createMailFilterRule).toHaveBeenCalledWith({
            mailboxUid: MAILBOX,
            name: `${NEVER_BLOCK_RULE_PREFIX}a@x.com`,
            sequence: -1,
            stopProcessingRules: true,
            conditions: { fromContains: ["a@x.com"] },
            actions: [{ type: "move_to_folder", folderUid: INBOX }],
        });
        expect(api.deleteMailFilterRule).not.toHaveBeenCalled();
    });

    it("takes away the block on the sender, and reports it", async () => {
        const block = rule({ uid: "block", version: 5 });
        api.listMailFilterRules.mockResolvedValue([block]);
        const result = await neverBlockSender(MAILBOX, ["a@x.com"], JUNK, INBOX);
        expect(api.deleteMailFilterRule).toHaveBeenCalledWith("block", 5);
        expect(result.removed).toEqual([block]);
        expect(result.outcome).toBe("created");
        // The new rule goes ahead of the rules that are left, not of the one just removed.
        expect(api.createMailFilterRule).toHaveBeenCalledWith(expect.objectContaining({ sequence: -1 }));
    });

    it("makes nothing when the sender is already never blocked", async () => {
        api.listMailFilterRules.mockResolvedValue([rule({ uid: "keep", actions: [{ type: "move_to_folder", folderUid: INBOX }] })]);
        const result = await neverBlockSender(MAILBOX, ["a@x.com"], JUNK, INBOX);
        expect(result).toMatchObject({ outcome: "existing", removed: [] });
        expect(api.createMailFilterRule).not.toHaveBeenCalled();
    });
});

describe("removeSenderRule", () => {
    it("deletes the rule at the version it was made", async () => {
        await removeSenderRule(rule({ uid: "r9", version: 2 }) as never);
        expect(api.deleteMailFilterRule).toHaveBeenCalledWith("r9", 2);
    });
});

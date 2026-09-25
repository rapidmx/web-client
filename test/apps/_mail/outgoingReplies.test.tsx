// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Mailbox, Message } from "@rapidmx/react-shared/mail/mailApi.js";
import {
    MAX_SETTLE_MISSES,
    adoptedOutgoing,
    belongsToThread,
    failOutgoing,
    forgetOutgoing,
    getOutgoingReplies,
    markOutgoingSending,
    markOutgoingSent,
    resetOutgoingReplies,
    settleOutgoing,
    trackOutgoing,
    useOutgoingReplies,
} from "../../../apps/shared/mail/outbox/outgoingReplies.js";
import type { SendRequest } from "../../../apps/shared/mail/outbox/sendJob.js";

const mailbox = { uid: "mb1", primarySmtpAddress: "me@example.com", displayName: "Me Myself" } as unknown as Mailbox;

function request(overrides: Partial<SendRequest> = {}, draft: Partial<Message> = {}): SendRequest {
    return {
        draft: { uid: "d1", version: 1, folderUid: "drafts", mailboxUid: "mb1", ...draft } as Message,
        mailboxUid: "mb1",
        mailbox,
        policy: undefined,
        toText: "bob@example.com",
        ccText: "",
        bccText: "",
        to: [{ address: "bob@example.com", displayName: "Bob" }],
        cc: [{ address: "cc@example.com" }],
        bcc: [],
        subject: "Re: Hello",
        html: "<p>Thanks</p>",
        attachments: [],
        requestReceipt: false,
        signEnabled: false,
        offeredSign: false,
        offeredEncrypt: false,
        encryptRequested: false,
        forcePlaintext: false,
        threading: { inReplyTo: "orig@example.com", references: ["root@example.com", "orig@example.com"] },
        ...overrides,
    };
}

const thread = (...ids: string[]) => ids.map((messageId, index) => ({ uid: `m${index}`, messageId })) as Message[];
const noop = () => undefined;

describe("trackOutgoing", () => {
    it("shows a reply as sending, with who sent it, who it went to and what it says", () => {
        trackOutgoing(request());

        expect(getOutgoingReplies()).toEqual([
            {
                uid: "d1",
                mailboxUid: "mb1",
                inReplyTo: "orig@example.com",
                references: ["root@example.com", "orig@example.com"],
                sender: { address: "me@example.com", displayName: "Me Myself" },
                to: [{ address: "bob@example.com", displayName: "Bob" }],
                cc: [{ address: "cc@example.com" }],
                bcc: [],
                subject: "Re: Hello",
                html: "<p>Thanks</p>",
                startedAt: expect.any(Number),
                state: "sending",
                actions: [],
                misses: 0,
            },
        ]);
    });

    it("calls the sender Me when the window had not loaded the mailbox", () => {
        trackOutgoing(request({ mailbox: undefined }));

        expect(getOutgoingReplies()[0].sender).toEqual({ address: "Me" });
    });

    it("takes the thread from the draft itself when the compose session recorded none - a draft opened again", () => {
        trackOutgoing(request({ threading: undefined }, { inReplyTo: "orig@example.com" }));

        expect(getOutgoingReplies()[0]).toEqual(expect.objectContaining({ inReplyTo: "orig@example.com", references: [] }));
    });

    it("tracks a message that only has a References chain", () => {
        trackOutgoing(request({ threading: { references: ["root@example.com"] } }));

        expect(getOutgoingReplies()[0]).toEqual(expect.objectContaining({ inReplyTo: undefined, references: ["root@example.com"] }));
    });

    it("does not track a new message, which continues no conversation, or a scheduled one, which is not sent yet", () => {
        trackOutgoing(request({ threading: undefined }));
        trackOutgoing(request({ threading: { references: [] } }));
        trackOutgoing(request({ scheduledSendTime: "2030-01-01T00:00:00.000Z" }));

        expect(getOutgoingReplies()).toEqual([]);
    });

    it("starts over when the same message is sent again, and keeps only the newest few", () => {
        trackOutgoing(request());
        failOutgoing("d1", "Refused", []);
        trackOutgoing(request());
        expect(getOutgoingReplies().map((reply) => [reply.uid, reply.state])).toEqual([["d1", "sending"]]);

        for (let n = 0; n < 30; n++) {
            trackOutgoing(request({}, { uid: `x${n}` }));
        }
        const uids = getOutgoingReplies().map((reply) => reply.uid);
        expect(uids).toHaveLength(25);
        expect(uids[0]).toBe("x5");
        expect(uids[24]).toBe("x29");
    });
});

describe("what happens to a tracked message", () => {
    it("is failed with the ways out, sending again on a retry, and sent once the server relayed it", () => {
        trackOutgoing(request());
        const actions = [{ label: "Retry", onClick: noop }];

        failOutgoing("d1", "Refused", actions);
        expect(getOutgoingReplies()[0]).toEqual(expect.objectContaining({ state: "failed", failure: "Refused", actions }));

        markOutgoingSending("d1");
        expect(getOutgoingReplies()[0]).toEqual(expect.objectContaining({ state: "sending", failure: undefined, actions: [] }));

        markOutgoingSent("d1");
        expect(getOutgoingReplies()[0].state).toBe("sent");

        forgetOutgoing("d1");
        expect(getOutgoingReplies()).toEqual([]);
    });

    it("tells nobody about a message it does not hold", () => {
        trackOutgoing(request());
        const before = getOutgoingReplies();

        failOutgoing("other", "Refused", []);
        markOutgoingSending("other");
        markOutgoingSent("other");
        forgetOutgoing("other");

        expect(getOutgoingReplies()).toBe(before);
    });
});

describe("belongsToThread", () => {
    const reply = () => {
        trackOutgoing(request());
        return getOutgoingReplies()[0];
    };

    it("is true for a reply to a message of the thread, or when the References chain runs through one", () => {
        expect(belongsToThread(reply(), thread("a@example.com", "orig@example.com"))).toBe(true);
        expect(belongsToThread(reply(), thread("root@example.com"))).toBe(true);
    });

    it("is false for another conversation, and never matches a message with no id", () => {
        expect(belongsToThread(reply(), thread("other@example.com"))).toBe(false);
        expect(belongsToThread(reply(), thread(""))).toBe(false);
        expect(belongsToThread(reply(), [])).toBe(false);
    });
});

describe("settling what a read of the thread found", () => {
    it("forgets a message whose real copy is in the thread, and says which", () => {
        trackOutgoing(request());
        trackOutgoing(request({}, { uid: "d2" }));
        const found = [...thread("orig@example.com"), { uid: "d1", messageId: "new@example.com" } as Message];

        expect(adoptedOutgoing("mb1", found)).toEqual(["d1"]);
        expect(adoptedOutgoing("mb2", found)).toEqual([]);
        settleOutgoing("mb1", found);

        expect(getOutgoingReplies().map((reply) => reply.uid)).toEqual(["d2"]);
    });

    it("gives up on a sent message of this thread that the reads did not find, after a couple of them", () => {
        trackOutgoing(request());
        markOutgoingSent("d1");

        for (let read = 1; read < MAX_SETTLE_MISSES; read++) {
            settleOutgoing("mb1", thread("orig@example.com"));
            expect(getOutgoingReplies()[0].misses).toBe(read);
        }
        settleOutgoing("mb1", thread("orig@example.com"));

        expect(getOutgoingReplies()).toEqual([]);
    });

    it("leaves alone what is not this thread's to settle, and does nothing when nothing changed", () => {
        trackOutgoing(request());
        trackOutgoing(request({}, { uid: "d2" }));
        trackOutgoing(request({ mailboxUid: "mb2" }, { uid: "d3" }));
        trackOutgoing(request({ threading: { inReplyTo: "elsewhere@example.com" } }, { uid: "d4" }));
        for (const uid of ["d1", "d3", "d4"]) {
            markOutgoingSent(uid);
        }
        // d1 is sent but the read has nothing of its thread, d2 is still sending, d3 is another mailbox's, d4 continues another conversation.
        const before = getOutgoingReplies();

        settleOutgoing("mb1", thread("unrelated@example.com"));
        expect(getOutgoingReplies()).toBe(before);

        settleOutgoing("mb2", thread("orig@example.com"));
        expect(getOutgoingReplies().map((reply) => [reply.uid, reply.misses])).toEqual([
            ["d1", 0],
            ["d2", 0],
            ["d3", 1],
            ["d4", 0],
        ]);
    });
});

describe("useOutgoingReplies", () => {
    function Probe() {
        return <span data-testid="count">{useOutgoingReplies().length}</span>;
    }

    it("re-renders a component as messages are tracked and forgotten", () => {
        render(<Probe />);
        expect(screen.getByTestId("count")).toHaveTextContent("0");

        act(() => trackOutgoing(request()));
        expect(screen.getByTestId("count")).toHaveTextContent("1");

        act(() => resetOutgoingReplies());
        expect(screen.getByTestId("count")).toHaveTextContent("0");
    });

    it("stops telling a component that has gone", () => {
        const { unmount } = render(<Probe />);
        const spy = vi.spyOn(console, "error").mockImplementation(noop);
        unmount();

        act(() => trackOutgoing(request()));

        expect(spy).not.toHaveBeenCalled();
    });

    it("has nothing to show on the server", () => {
        trackOutgoing(request());

        expect(renderToString(<Probe />)).toContain(">0<");
    });
});

// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageInvite } from "@rapidmx/react-shared/calendar/inviteApi.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { INVITE_TTL_MS, clearInviteCache, loadInvite, storeInvite, useMessageInvite } from "../../../apps/shared/components/mail/invite/inviteStore.js";

function inviteFixture(overrides: Partial<MessageInvite> = {}): MessageInvite {
    return {
        method: "REQUEST",
        uid: "ical-1",
        sequence: 0,
        summary: "Planning",
        allDay: false,
        attendees: [],
        recurring: false,
        isOrganizer: false,
        onCalendar: false,
        outdated: false,
        canRespond: true,
        canAdd: false,
        canRemove: false,
        canPropose: false,
        canAcceptProposal: false,
        conflicts: [],
        schedule: [],
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearInviteCache();
});

describe("loadInvite", () => {
    it("asks once for a message however many ask, and remembers the answer", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, inviteFixture()));
        const [a, b] = await Promise.all([loadInvite("m1"), loadInvite("m1")]);
        await loadInvite("m1");

        expect(a).toEqual(b);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("remembers that a message has no invitation (404)", async () => {
        const fetchMock = mockFetch(() => jsonResponse(404, { message: "none" }));
        expect(await loadInvite("m1")).toBeNull();
        expect(await loadInvite("m1")).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not remember a failure: the next ask tries again", async () => {
        let fail = true;
        const fetchMock = mockFetch(() => (fail ? jsonResponse(500, { message: "Boom" }) : jsonResponse(200, inviteFixture())));
        await expect(loadInvite("m1")).rejects.toThrow("Boom");
        fail = false;
        expect(await loadInvite("m1")).toMatchObject({ summary: "Planning" });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("reads it again once the answer is older than the time to live", async () => {
        const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
        const fetchMock = mockFetch(() => jsonResponse(200, inviteFixture()));
        await loadInvite("m1");
        now.mockReturnValue(1_000_000 + INVITE_TTL_MS - 1);
        await loadInvite("m1");
        expect(fetchMock).toHaveBeenCalledTimes(1);

        now.mockReturnValue(1_000_000 + INVITE_TTL_MS);
        await loadInvite("m1");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("fills in lists an answer leaves out", async () => {
        const partial: Partial<MessageInvite> = inviteFixture();
        delete partial.attendees;
        delete partial.conflicts;
        delete partial.schedule;
        mockFetch(() => jsonResponse(200, partial));
        expect(await loadInvite("m1")).toMatchObject({ attendees: [], conflicts: [], schedule: [] });
    });

    it("does not let a failed read of one message clear another's answer", async () => {
        mockFetch((url) => (url.endsWith("/m2") ? jsonResponse(500, { message: "Boom" }) : jsonResponse(200, inviteFixture())));
        await loadInvite("m1");
        await expect(loadInvite("m2")).rejects.toThrow();
        const fetchMock = mockFetch(() => jsonResponse(500, { message: "unexpected" }));
        expect(await loadInvite("m1")).not.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps a stored answer when a slower failed read of the same message ends", async () => {
        let fail!: (response: Response) => void;
        mockFetch(() => new Promise<Response>((resolve) => (fail = resolve)));
        const pending = loadInvite("m1");
        storeInvite("m1", inviteFixture({ summary: "Stored" }));
        fail(jsonResponse(500, { message: "Boom" }));
        await expect(pending).rejects.toThrow();

        const fetchMock = mockFetch(() => jsonResponse(500, { message: "unexpected" }));
        expect(await loadInvite("m1")).toMatchObject({ summary: "Stored" });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("useMessageInvite", () => {
    function Probe({ uid, enabled }: { uid: string; enabled?: boolean }) {
        const { invite, settled, setInvite } = useMessageInvite(uid, enabled);
        return (
            <div>
                <span data-testid="summary">{invite?.summary ?? "none"}</span>
                <span data-testid="settled">{String(settled)}</span>
                <button type="button" onClick={() => setInvite(inviteFixture({ summary: "Changed" }))}>
                    change
                </button>
            </div>
        );
    }

    it("asks nothing while disabled", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, inviteFixture()));
        render(<Probe uid="m1" enabled={false} />);
        await act(async () => undefined);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(screen.getByTestId("summary")).toHaveTextContent("none");
        expect(screen.getByTestId("settled")).toHaveTextContent("false");
    });

    it("gives the invitation once it is in, and settles for a message with none", async () => {
        mockFetch((url) => (url.endsWith("/m2") ? jsonResponse(404, { message: "none" }) : jsonResponse(200, inviteFixture())));
        const first = render(<Probe uid="m1" />);
        await waitFor(() => expect(screen.getByTestId("summary")).toHaveTextContent("Planning"));
        expect(screen.getByTestId("settled")).toHaveTextContent("true");
        first.unmount();

        render(<Probe uid="m2" />);
        await waitFor(() => expect(screen.getByTestId("settled")).toHaveTextContent("true"));
        expect(screen.getByTestId("summary")).toHaveTextContent("none");
    });

    it("stays unsettled, quietly, when the lookup fails", async () => {
        const fetchMock = mockFetch(() => jsonResponse(500, { message: "Boom" }));
        render(<Probe uid="m1" />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await act(async () => undefined);
        expect(screen.getByTestId("settled")).toHaveTextContent("false");
    });

    it("shares an answer between everything drawing the same message", async () => {
        mockFetch(() => jsonResponse(200, inviteFixture()));
        render(
            <>
                <Probe uid="m1" />
                <Probe uid="m1" />
            </>,
        );
        await waitFor(() => expect(screen.getAllByTestId("summary").map((n) => n.textContent)).toEqual(["Planning", "Planning"]));

        act(() => screen.getAllByRole("button")[0].click());
        expect(screen.getAllByTestId("summary").map((n) => n.textContent)).toEqual(["Changed", "Changed"]);
    });

    it("never shows another message's invitation after the uid changes", async () => {
        mockFetch((url) => jsonResponse(200, inviteFixture({ summary: url.endsWith("/m2") ? "Second" : "First" })));
        const { rerender } = render(<Probe uid="m1" />);
        await waitFor(() => expect(screen.getByTestId("summary")).toHaveTextContent("First"));

        rerender(<Probe uid="m2" />);
        expect(screen.getByTestId("summary")).toHaveTextContent("none");
        await waitFor(() => expect(screen.getByTestId("summary")).toHaveTextContent("Second"));
    });

    it("ignores an answer that arrives after it unmounted", async () => {
        let answer!: (response: Response) => void;
        const fetchMock = mockFetch(() => new Promise<Response>((resolve) => (answer = resolve)));
        const { unmount } = render(<Probe uid="m1" />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        unmount();
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await act(async () => {
            answer(jsonResponse(200, inviteFixture()));
        });
        expect(errors).not.toHaveBeenCalled();
    });
});

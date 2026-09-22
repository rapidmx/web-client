// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The request itself and its shape are `@rapidmx/react-shared/crypto/signingProviderApi.js`'s (R6's) - covered by react-shared's own
// `signingProviderApi.test.ts`. This file is only the caching, the never-rejects contract, and the hook that sit on top of it here.
import React from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { SIGNING_INFO_CACHE_MS, fetchSigningEnrollmentInfo, resetSigningInfo, useSigningEnrollmentInfo } from "../../../apps/shared/signing/signingInfo.js";

const AUTOMATIC = {
    backend: "rfc8823",
    automatic: true,
    ca: { host: "acme.ca.example" },
    contactEmail: "pki@example.com",
    typicalDurationMinutes: 5,
    adminUpload: false,
    health: { ok: false, checkedAt: "2026-09-21T10:00:00Z", lastSuccessAt: "2026-09-21T09:00:00Z", lastError: "Rate limited" },
};

beforeEach(() => {
    resetSigningInfo();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("fetchSigningEnrollmentInfo", () => {
    it("asks the system endpoint once and reuses the answer for five minutes", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, AUTOMATIC));
        expect((await fetchSigningEnrollmentInfo(1_000))?.ca?.host).toBe("acme.ca.example");
        expect(fetchMock).toHaveBeenCalledWith("/api/system/signing-enrollment", expect.anything());
        await fetchSigningEnrollmentInfo(1_000 + SIGNING_INFO_CACHE_MS - 1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await fetchSigningEnrollmentInfo(1_000 + SIGNING_INFO_CACHE_MS);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("never rejects, and does not remember what it could not get (an older server has no such endpoint)", async () => {
        const fetchMock = mockFetch(() => jsonResponse(404, { message: "Not found" }));
        expect(await fetchSigningEnrollmentInfo()).toBeNull();
        expect(await fetchSigningEnrollmentInfo()).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe("useSigningEnrollmentInfo", () => {
    function Probe({ enabled }: { enabled: boolean }) {
        const info = useSigningEnrollmentInfo(enabled);
        return <span data-testid="info">{info === undefined ? "asking" : info === null ? "none" : info.backend}</span>;
    }

    it("is undefined while it asks and then the description; and asks nothing when not enabled", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { backend: "manual", automatic: false, adminUpload: true }));
        const { rerender } = render(<Probe enabled={false} />);
        expect(screen.getByTestId("info")).toHaveTextContent("asking");
        expect(fetchMock).not.toHaveBeenCalled();
        rerender(<Probe enabled />);
        expect(screen.getByTestId("info")).toHaveTextContent("asking");
        await act(async () => {
            await Promise.resolve();
        });
        expect(await screen.findByText("manual")).toBeInTheDocument();
    });

    it("says null when the server has no such description, and ignores an answer that comes after it was unmounted", async () => {
        mockFetch(() => jsonResponse(404, { message: "Not found" }));
        const first = render(<Probe enabled />);
        expect(await screen.findByText("none")).toBeInTheDocument();
        first.unmount();

        resetSigningInfo();
        let answer: (response: Response) => void = () => undefined;
        mockFetch(() => new Promise<Response>((resolve) => (answer = resolve)));
        const second = render(<Probe enabled />);
        second.unmount();
        await act(async () => answer(jsonResponse(200, { backend: "manual", automatic: false, adminUpload: true })));
        expect(screen.queryByTestId("info")).not.toBeInTheDocument();
    });
});

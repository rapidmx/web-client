// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiClientContext, useApiClient } from "../../../lib/util/apiClientContext.js";
import { createApiClient, type ApiClient } from "../../../lib/util/api.js";

function ReadClient({ onRead }: { onRead?: (client: ApiClient | undefined) => void }) {
    const client = useApiClient();
    onRead?.(client);
    return <div data-testid="client">{client ? "has-client" : "no-client"}</div>;
}

describe("ApiClientContext / useApiClient", () => {
    it("defaults to undefined with no provider above it", () => {
        render(<ReadClient />);
        expect(screen.getByTestId("client").textContent).toBe("no-client");
    });

    it("reads the nearest provider's value", () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        render(
            <ApiClientContext.Provider value={client}>
                <ReadClient />
            </ApiClientContext.Provider>,
        );
        expect(screen.getByTestId("client").textContent).toBe("has-client");
    });

    it("is the exact same client instance a converted REST function's own client param accepts, no adapter needed", () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        let read: ApiClient | undefined;
        render(
            <ApiClientContext.Provider value={client}>
                <ReadClient onRead={(c) => (read = c)} />
            </ApiClientContext.Provider>,
        );
        expect(read).toBe(client);
    });

    it("a nested provider overrides an outer one, and reverts outside it", () => {
        const outer = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const inner = createApiClient({ baseUrl: "https://account-b.example.com", getAccessToken: async () => "tok-b" });
        const seen: (ApiClient | undefined)[] = [];
        render(
            <ApiClientContext.Provider value={outer}>
                <ReadClient onRead={(c) => seen.push(c)} />
                <ApiClientContext.Provider value={inner}>
                    <ReadClient onRead={(c) => seen.push(c)} />
                </ApiClientContext.Provider>
            </ApiClientContext.Provider>,
        );
        expect(seen).toEqual([outer, inner]);
    });
});

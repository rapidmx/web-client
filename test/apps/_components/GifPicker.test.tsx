// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import GifPicker from "../../../apps/shared/components/mail/compose/GifPicker.js";

// `PopoverPortal`'s own positioning/portal/outside-click behavior is tested in `PopoverPortal.test.tsx`
// — mocked here to a plain passthrough so this file only exercises `GifPicker`'s own content.
vi.mock("../../../apps/shared/components/mail/compose/PopoverPortal.js", () => ({
    default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const anchorRef = { current: null };

function gif(overrides: Partial<{ id: string; previewUrl: string; url: string; title: string }> = {}) {
    return {
        id: "g1",
        previewUrl: "https://media.giphy.com/g1/small.gif",
        url: "https://media.giphy.com/g1/original.gif",
        title: "Cat",
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("GifPicker", () => {
    it("loads trending GIFs on mount (empty query) and renders them as clickable thumbnails.", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [gif()]));
        render(<GifPicker anchorRef={anchorRef} onSelect={vi.fn()} onClose={vi.fn()} />);

        expect(await screen.findByRole("button", { name: "Cat" })).toBeInTheDocument();
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/mail/giphy/search?"), expect.anything()));
    });

    it("shows a loading state before results arrive.", () => {
        mockFetch(() => new Promise(() => undefined));
        render(<GifPicker anchorRef={anchorRef} onSelect={vi.fn()} onClose={vi.fn()} />);

        expect(screen.getByText("Loading…")).toBeInTheDocument();
    });

    it("shows a 'no GIFs found' message when the search returns nothing.", async () => {
        mockFetch(() => jsonResponse(200, []));
        render(<GifPicker anchorRef={anchorRef} onSelect={vi.fn()} onClose={vi.fn()} />);

        expect(await screen.findByText("No GIFs found.")).toBeInTheDocument();
    });

    it("shows an error message when the search fails.", async () => {
        mockFetch(() => jsonResponse(500, { message: "giphy down" }));
        render(<GifPicker anchorRef={anchorRef} onSelect={vi.fn()} onClose={vi.fn()} />);

        expect(await screen.findByText("giphy down")).toBeInTheDocument();
    });

    it("shows a generic error message when the search fails with a non-API error.", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        render(<GifPicker anchorRef={anchorRef} onSelect={vi.fn()} onClose={vi.fn()} />);

        expect(await screen.findByText("Could not load GIFs.")).toBeInTheDocument();
    });

    it("re-searches (debounced) as the user types into the search box.", async () => {
        const fetchMock = mockFetch((url) => (url.includes("q=corgi") ? jsonResponse(200, [gif({ id: "g2", title: "Corgi" })]) : jsonResponse(200, [gif()])));
        const user = userEvent.setup();
        render(<GifPicker anchorRef={anchorRef} onSelect={vi.fn()} onClose={vi.fn()} />);
        await screen.findByRole("button", { name: "Cat" });

        await user.type(screen.getByLabelText("Search GIFs"), "corgi");

        expect(await screen.findByRole("button", { name: "Corgi" })).toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes("q=corgi"))).toBe(true);
    });

    it("calls onSelect with the clicked GIF's full-resolution URL.", async () => {
        mockFetch(() => jsonResponse(200, [gif()]));
        const onSelect = vi.fn();
        const user = userEvent.setup();
        render(<GifPicker anchorRef={anchorRef} onSelect={onSelect} onClose={vi.fn()} />);

        await user.click(await screen.findByRole("button", { name: "Cat" }));

        expect(onSelect).toHaveBeenCalledWith("https://media.giphy.com/g1/original.gif");
    });
});

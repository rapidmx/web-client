// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DescriptionEditorProps } from "../../../apps/shared/components/calendar/DescriptionEditor.js";

// The description editor is fetched when it is first drawn (it is TipTap): a placeholder while it comes, the editor once it has, a retry if it did not.

const EDITOR_MODULE = "../../../apps/shared/components/calendar/DescriptionEditor.js";

function Stub({ value, label }: DescriptionEditorProps) {
    return <div data-testid="editor">{`${label ?? "no label"}: ${value}`}</div>;
}

async function freshLazyEditor() {
    return (await import("../../../apps/shared/components/calendar/LazyDescriptionEditor.js")).default;
}

beforeEach(() => {
    // The module remembers the editor it has loaded, so each test starts from a fresh copy.
    vi.resetModules();
});

afterEach(() => {
    vi.doUnmock(EDITOR_MODULE);
});

describe("LazyDescriptionEditor", () => {
    it("shows a placeholder while the editor is fetched, then the editor with the props it was given", async () => {
        vi.doMock(EDITOR_MODULE, () => ({ default: Stub }));
        const LazyDescriptionEditor = await freshLazyEditor();

        render(<LazyDescriptionEditor value="<p>hi</p>" onChange={vi.fn()} label="Agenda" />);
        expect(screen.getByText("Loading the editor…")).toBeInTheDocument();
        expect(await screen.findByTestId("editor")).toHaveTextContent("Agenda: <p>hi</p>");
        expect(screen.queryByText("Loading the editor…")).not.toBeInTheDocument();
    });

    it("draws the editor at once when it has been fetched before, and fetches it once", async () => {
        const factory = vi.fn(() => ({ default: Stub }));
        vi.doMock(EDITOR_MODULE, factory);
        const LazyDescriptionEditor = await freshLazyEditor();

        const first = render(<LazyDescriptionEditor value="a" onChange={vi.fn()} />);
        await screen.findByTestId("editor");
        first.unmount();

        render(<LazyDescriptionEditor value="b" onChange={vi.fn()} />);
        // No placeholder in between: the second one starts as the editor.
        expect(screen.getByTestId("editor")).toHaveTextContent("no label: b");
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it("says the editor could not be loaded, and loads it again on request", async () => {
        vi.doMock(EDITOR_MODULE, () => {
            throw new Error("Failed to fetch dynamically imported module");
        });
        const LazyDescriptionEditor = await freshLazyEditor();

        render(<LazyDescriptionEditor value="<p>hi</p>" onChange={vi.fn()} />);
        expect(await screen.findByRole("alert")).toHaveTextContent("The description editor couldn’t be loaded.");
        expect(screen.queryByText("Loading the editor…")).not.toBeInTheDocument();

        // The connection is back: nothing is remembered of the failure.
        vi.doMock(EDITOR_MODULE, () => ({ default: Stub }));
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByTestId("editor")).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("ignores a fetch that finishes after it is gone", async () => {
        let resolveModule: (module: { default: typeof Stub }) => void = () => undefined;
        const pending = new Promise<{ default: typeof Stub }>((resolve) => (resolveModule = resolve));
        vi.doMock(EDITOR_MODULE, () => pending);
        const LazyDescriptionEditor = await freshLazyEditor();

        const { unmount } = render(<LazyDescriptionEditor value="a" onChange={vi.fn()} />);
        unmount();
        resolveModule({ default: Stub });
        await pending;
    });

    it("ignores a failure that arrives after it is gone", async () => {
        let rejectModule: (error: Error) => void = () => undefined;
        const pending = new Promise<{ default: typeof Stub }>((_resolve, reject) => (rejectModule = reject));
        pending.catch(() => undefined);
        vi.doMock(EDITOR_MODULE, () => pending);
        const LazyDescriptionEditor = await freshLazyEditor();

        const { unmount } = render(<LazyDescriptionEditor value="a" onChange={vi.fn()} />);
        unmount();
        rejectModule(new Error("offline"));
        await pending.catch(() => undefined);
    });
});

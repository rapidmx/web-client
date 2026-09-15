// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecipientSuggestion } from "@rapidmx/react-shared/mail/directoryApi.js";
import RecipientInput, { RecipientInputProps } from "../../../apps/shared/components/mail/compose/RecipientInput.js";
import { jsonResponse, mockFetch } from "../testUtils.js";

const alice: RecipientSuggestion = { displayName: "Alice Johnson", address: "alice@example.com", kind: "contact" };
const allan: RecipientSuggestion = { displayName: "Allan Room", address: "allan@example.com", kind: "room" };
const sales: RecipientSuggestion = { displayName: "", address: "all-sales@example.com", kind: "list" };

type HarnessProps = Partial<RecipientInputProps> & { initial?: string };

/** A labelled field holding its own value, like ComposeWindow does. */
function Harness({ initial = "", onChange, ...props }: HarnessProps) {
    const [value, setValue] = useState(initial);
    return (
        <div>
            <label htmlFor="to">To</label>
            <RecipientInput
                id="to"
                label="To"
                value={value}
                debounceMs={0}
                fetchSuggestions={async () => []}
                {...props}
                onChange={(next) => {
                    setValue(next);
                    onChange?.(next);
                }}
            />
            <output data-testid="value">{value}</output>
            <button type="button">elsewhere</button>
        </div>
    );
}

function chips(): (string | null)[] {
    const list = screen.queryByRole("list", { name: "To recipients" });
    return list ? within(list).getAllByRole("listitem").map((item) => item.getAttribute("title")) : [];
}

const input = () => screen.getByRole("combobox", { name: "To" });
const value = () => screen.getByTestId("value").textContent;

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("RecipientInput", () => {
    describe("chips", () => {
        it("shows the value's recipients as chips, flagging invalid addresses", () => {
            render(<Harness initial={'"Doe, Jane" <jane@example.com>, not-an-address'} />);
            expect(chips()).toEqual(['"Doe, Jane" <jane@example.com>', "not-an-address"]);
            const [jane, invalid] = within(screen.getByRole("list", { name: "To recipients" })).getAllByRole("listitem");
            expect(jane).toHaveTextContent("Doe, Jane");
            expect(invalid).toHaveTextContent("not-an-address (not a valid email address)");
            expect(input()).toHaveValue("");
        });

        it("turns typed text into chips at commas and semicolons, but not inside a quoted name", async () => {
            const user = userEvent.setup();
            const onChange = vi.fn();
            render(<Harness onChange={onChange} />);
            await user.type(input(), "a@example.com, b@example.com;");
            expect(chips()).toEqual(["a@example.com", "b@example.com"]);
            expect(input()).toHaveValue("");
            await user.type(input(), '"Smith, John" <john@example.com>');
            expect(chips()).toEqual(["a@example.com", "b@example.com"]);
            expect(input()).toHaveValue('"Smith, John" <john@example.com>');
            expect(value()).toBe('a@example.com, b@example.com, "Smith, John" <john@example.com>');
            expect(onChange).toHaveBeenLastCalledWith('a@example.com, b@example.com, "Smith, John" <john@example.com>');
        });

        it("splits a pasted list, keeping the text after the last separator in the input", async () => {
            const user = userEvent.setup();
            render(<Harness />);
            await user.click(input());
            await user.paste("x@example.com; y@example.com, z@exa");
            expect(chips()).toEqual(["x@example.com", "y@example.com"]);
            expect(input()).toHaveValue("z@exa");
        });

        it("commits the typed text on Enter and on blur", async () => {
            const user = userEvent.setup();
            const onCommit = vi.fn();
            const onBlur = vi.fn();
            render(<Harness onCommit={onCommit} onBlur={onBlur} />);
            await user.type(input(), "  a@example.com{Enter}");
            expect(chips()).toEqual(["a@example.com"]);
            expect(onCommit).toHaveBeenCalledWith("a@example.com");
            // Enter with nothing typed does nothing.
            await user.keyboard("{Enter}");
            expect(onCommit).toHaveBeenCalledTimes(1);

            await user.type(input(), "b@example.com");
            await user.click(screen.getByRole("button", { name: "elsewhere" }));
            expect(chips()).toEqual(["a@example.com", "b@example.com"]);
            expect(onBlur).toHaveBeenCalledWith("a@example.com, b@example.com");
        });

        it("removes a chip with its button, and the last one with Backspace in an empty input", async () => {
            const user = userEvent.setup();
            render(<Harness initial="a@example.com, b@example.com, c@example.com" />);
            await user.type(input(), "d");
            await user.click(screen.getByRole("button", { name: "Remove b@example.com" }));
            expect(chips()).toEqual(["a@example.com", "c@example.com"]);
            expect(input()).toHaveValue("d");
            expect(input()).toHaveFocus();

            await user.keyboard("{Backspace}");
            expect(chips()).toEqual(["a@example.com", "c@example.com"]);
            await user.keyboard("{Backspace}");
            expect(chips()).toEqual(["a@example.com"]);
            expect(value()).toBe("a@example.com");
            await user.keyboard("{Backspace}{Backspace}");
            expect(chips()).toEqual([]);
        });

        it("drops the typed text when the value changes from outside", () => {
            const { rerender } = render(<RecipientInput id="to" label="To" value="" onChange={vi.fn()} fetchSuggestions={async () => []} />);
            const onChange = vi.fn();
            rerender(<RecipientInput id="to" label="To" value="" onChange={onChange} fetchSuggestions={async () => []} />);
            fireEvent.change(screen.getByRole("combobox"), { target: { value: "typed" } });
            // The parent ignored the change, so the typed text isn't part of the value and isn't shown.
            expect(onChange).toHaveBeenCalledWith("typed");
            expect(screen.getByRole("combobox")).toHaveValue("");
            rerender(<RecipientInput id="to" label="To" value="typed" onChange={onChange} fetchSuggestions={async () => []} />);
            expect(screen.getByRole("combobox")).toHaveValue("");
        });

        it("can be disabled", () => {
            render(<Harness initial="a@example.com" disabled />);
            expect(input()).toBeDisabled();
            expect(screen.getByRole("button", { name: "Remove a@example.com" })).toBeDisabled();
        });
    });

    describe("suggestions", () => {
        it("loads suggestions for two or more characters and picks one with the keyboard", async () => {
            const user = userEvent.setup();
            const fetchSuggestions = vi.fn(async () => [alice, allan, sales]);
            const onCommit = vi.fn();
            render(<Harness fetchSuggestions={fetchSuggestions} mailboxUid="mb1" onCommit={onCommit} />);

            await user.type(input(), "a");
            expect(fetchSuggestions).not.toHaveBeenCalled();
            await user.type(input(), "l");
            const listbox = await screen.findByRole("listbox", { name: "To suggestions" });
            expect(fetchSuggestions).toHaveBeenLastCalledWith("al", expect.objectContaining({ mailboxUid: "mb1", signal: expect.any(AbortSignal) }));
            const options = within(listbox).getAllByRole("option");
            expect(options.map((option) => option.textContent)).toEqual([
                "Alice Johnsonalice@example.comContact",
                "Allan Roomallan@example.comRoom",
                "all-sales@example.comGroup",
            ]);
            expect(input()).toHaveAttribute("aria-expanded", "true");
            expect(input()).toHaveAttribute("aria-controls", listbox.id);
            expect(input()).toHaveAttribute("aria-activedescendant", options[0].id);
            expect(options[0]).toHaveAttribute("aria-selected", "true");
            expect(screen.getByText("3 suggestions")).toBeInTheDocument();

            await user.keyboard("{ArrowDown}");
            expect(input()).toHaveAttribute("aria-activedescendant", options[1].id);
            await user.keyboard("{ArrowUp}{ArrowUp}");
            expect(input()).toHaveAttribute("aria-activedescendant", options[2].id);
            await user.keyboard("{ArrowDown}");
            expect(input()).toHaveAttribute("aria-activedescendant", options[0].id);
            await user.keyboard("{ArrowDown}{Enter}");

            expect(chips()).toEqual(["Allan Room <allan@example.com>"]);
            expect(onCommit).toHaveBeenCalledWith("Allan Room <allan@example.com>");
            expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
            expect(input()).toHaveValue("");
            expect(input()).toHaveFocus();
            expect(input()).toHaveAttribute("aria-expanded", "false");
            expect(input()).not.toHaveAttribute("aria-activedescendant");
        });

        it("picks with Tab (keeping focus) but not Shift+Tab, and inserts a nameless entry as its address", async () => {
            const user = userEvent.setup();
            render(<Harness fetchSuggestions={async () => [sales, alice]} />);
            await user.type(input(), "al");
            await screen.findByRole("listbox");
            await user.keyboard("{Tab}");
            expect(chips()).toEqual(["all-sales@example.com"]);
            expect(input()).toHaveFocus();

            await user.type(input(), "al");
            await screen.findByRole("listbox");
            // The chip's address isn't suggested again.
            expect(screen.getAllByRole("option")).toHaveLength(1);
            await user.keyboard("{Shift>}{Tab}{/Shift}");
            expect(chips()).toEqual(["all-sales@example.com", "al"]);
        });

        it("closes on Escape without letting the key reach the window, and reopens with the arrow keys", async () => {
            const user = userEvent.setup();
            const onWindowKey = vi.fn();
            render(
                <div onKeyDown={(e) => onWindowKey(e.key)}>
                    <Harness fetchSuggestions={async () => [alice, allan]} />
                </div>,
            );
            await user.type(input(), "al");
            await screen.findByRole("listbox");
            onWindowKey.mockClear();
            await user.keyboard("{Escape}");
            expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
            expect(onWindowKey).not.toHaveBeenCalledWith("Escape");
            // A second Escape with nothing open is the window's.
            await user.keyboard("{Escape}");
            expect(onWindowKey).toHaveBeenCalledWith("Escape");

            await user.keyboard("{ArrowUp}");
            expect(input()).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[1].id);
            await user.keyboard("{Escape}{ArrowDown}");
            expect(input()).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[0].id);
            // Enter picks the highlighted option rather than committing the typed text.
            await user.keyboard("{Enter}");
            expect(chips()).toEqual(["Alice Johnson <alice@example.com>"]);
        });

        it("picks with the mouse without leaving the input", async () => {
            const user = userEvent.setup();
            const onBlur = vi.fn();
            render(<Harness fetchSuggestions={async () => [alice, allan]} onBlur={onBlur} />);
            await user.type(input(), "al");
            const listbox = await screen.findByRole("listbox");
            const [, second] = within(listbox).getAllByRole("option");
            await user.hover(second);
            expect(second).toHaveAttribute("aria-selected", "true");
            fireEvent.mouseDown(listbox);
            await user.click(second);
            expect(chips()).toEqual(["Allan Room <allan@example.com>"]);
            expect(onBlur).not.toHaveBeenCalled();
            expect(input()).toHaveFocus();
        });

        it("ignores the arrow keys and other keys with no suggestions, and doesn't fetch after leaving the field", async () => {
            const user = userEvent.setup();
            const fetchSuggestions = vi.fn(async () => []);
            render(<Harness fetchSuggestions={fetchSuggestions} />);
            await user.type(input(), "zz{ArrowDown}{ArrowUp}{Escape}x");
            await waitFor(() => expect(fetchSuggestions).toHaveBeenLastCalledWith("zzx", expect.anything()));
            expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
            expect(input()).toHaveValue("zzx");
        });

        it("aborts a stale request and ignores its late result, and shows nothing when loading fails", async () => {
            const user = userEvent.setup();
            const resolvers: Record<string, (value: RecipientSuggestion[]) => void> = {};
            const rejecters: Record<string, (error: Error) => void> = {};
            const signals: Record<string, AbortSignal> = {};
            const fetchSuggestions = vi.fn(
                (query: string, { signal }: { signal?: AbortSignal }) =>
                    new Promise<RecipientSuggestion[]>((resolve, reject) => {
                        resolvers[query] = resolve;
                        rejecters[query] = reject;
                        signals[query] = signal!;
                    }),
            );
            render(<Harness fetchSuggestions={fetchSuggestions} />);
            await user.type(input(), "al");
            await waitFor(() => expect(signals.al).toBeDefined());
            await user.type(input(), "i");
            await waitFor(() => expect(signals.ali).toBeDefined());
            expect(signals.al.aborted).toBe(true);

            await act(async () => resolvers.al([allan]));
            expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
            await act(async () => resolvers.ali([alice]));
            expect(screen.getAllByRole("option")).toHaveLength(1);

            await user.type(input(), "c");
            await waitFor(() => expect(signals.alic).toBeDefined());
            await user.type(input(), "e");
            await waitFor(() => expect(signals.alice).toBeDefined());
            await act(async () => rejecters.alic(new Error("late")));
            expect(screen.getAllByRole("option")).toHaveLength(1);
            await act(async () => rejecters.alice(new Error("offline")));
            expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

            // Clearing the text below two characters aborts the pending request.
            await user.type(input(), "s");
            await waitFor(() => expect(signals.alices).toBeDefined());
            await user.clear(input());
            expect(signals.alices.aborted).toBe(true);
        });

        it("labels an unknown kind as a directory entry and scrolls the highlighted option into view", async () => {
            const user = userEvent.setup();
            const scrollIntoView = vi.fn();
            Element.prototype.scrollIntoView = scrollIntoView;
            render(<Harness fetchSuggestions={async () => [{ displayName: "Future", address: "future@example.com", kind: "robot" as any }]} />);
            await user.type(input(), "fu");
            expect(await screen.findByRole("option")).toHaveTextContent("Directory");
            expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
            delete (Element.prototype as any).scrollIntoView;
        });

        it("positions the list under the field, or above it when there's much more room there, following resizes and scrolls", async () => {
            const user = userEvent.setup();
            vi.stubGlobal("innerHeight", 800);
            vi.stubGlobal("innerWidth", 1000);
            const rect = { left: 900, top: 100, bottom: 130, width: 200, height: 30, right: 1100, x: 900, y: 100, toJSON: () => ({}) };
            render(<Harness fetchSuggestions={async () => [alice]} />);
            const anchor = input().parentElement!;
            anchor.getBoundingClientRect = () => rect;
            await user.type(input(), "al");
            const listbox = await screen.findByRole("listbox");
            expect(listbox.style.top).toBe("132px");
            expect(listbox.style.left).toBe("732px");
            expect(listbox.style.width).toBe("260px");
            expect(listbox.style.maxHeight).toBe("320px");

            Object.assign(rect, { left: -20, top: 700, bottom: 730, width: 2000 });
            act(() => {
                window.dispatchEvent(new Event("resize"));
            });
            expect(listbox.style.top).toBe("");
            expect(listbox.style.bottom).toBe("102px");
            expect(listbox.style.left).toBe("8px");
            expect(listbox.style.width).toBe("984px");
            expect(listbox.style.maxHeight).toBe("320px");

            Object.assign(rect, { left: 10, top: 5, bottom: 790 });
            act(() => {
                window.dispatchEvent(new Event("scroll"));
            });
            expect(listbox.style.top).toBe("792px");
            expect(listbox.style.maxHeight).toBe("120px");
        });

        it("fetches from the server by default", async () => {
            const user = userEvent.setup();
            const fetchMock = mockFetch((url) =>
                jsonResponse(200, url.startsWith("/api/mail/directory/contacts") ? [alice] : [{ ...alice, kind: "user" }, allan]),
            );
            render(<Harness fetchSuggestions={undefined} mailboxUid="mb1" />);
            await user.type(input(), "al");
            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/directory?q=al&limit=8", expect.anything()));
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/directory/contacts?q=al&limit=8&mailboxUid=mb1", expect.anything());
            expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
                "Alice Johnsonalice@example.comContact",
                "Allan Roomallan@example.comRoom",
            ]);
        });
    });
});

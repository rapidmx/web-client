///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { RefObject, useRef, useState } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShortcutDef, ShortcutScope } from "../../../apps/shared/keyboard/keymap.js";
import { ShortcutProvider, useRegisteredShortcuts } from "../../../apps/shared/keyboard/ShortcutProvider.js";
import { ShortcutHandler } from "../../../apps/shared/keyboard/registry.js";
import { useShortcut } from "../../../apps/shared/keyboard/useShortcut.js";

function def(keys: string[], init: Partial<ShortcutDef> = {}): ShortcutDef {
    return { id: `test.${keys.join("|")}.${init.scope ?? "global"}`, keys, label: keys[0], scope: "global", ...init };
}

function Claim({
    shortcut,
    handler,
    scope,
    enabled,
    container,
}: {
    shortcut: ShortcutDef | string;
    handler: ShortcutHandler;
    scope?: ShortcutScope;
    enabled?: boolean;
    container?: RefObject<Element | null>;
}) {
    useShortcut(shortcut, handler, { scope, enabled, container });
    return null;
}

function press(key: string, init: KeyboardEventInit = {}, target: Element = document.body): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
}

function renderIn(ui: React.ReactNode) {
    return render(<ShortcutProvider>{ui}</ShortcutProvider>);
}

let platform: ReturnType<typeof vi.spyOn> | undefined;
function pretendMac() {
    platform = vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
}

beforeEach(() => {
    document.body.innerHTML = "";
});

afterEach(() => {
    platform?.mockRestore();
    platform = undefined;
    delete (window as { rapidmx?: unknown }).rapidmx;
});

describe("the keyboard layer", () => {
    describe("running a handler", () => {
        it("runs the handler and prevents the default and the propagation only when it ran", () => {
            const handler = vi.fn();
            renderIn(<Claim shortcut={def(["ctrl+r"])} handler={handler} />);
            const stop = vi.spyOn(KeyboardEvent.prototype, "stopPropagation");
            const event = press("r", { ctrlKey: true });
            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler.mock.calls[0][0]).toBe(event);
            expect(event.defaultPrevented).toBe(true);
            expect(stop).toHaveBeenCalled();
            stop.mockRestore();
        });

        it("leaves a key nobody claims alone", () => {
            renderIn(<Claim shortcut={def(["ctrl+r"])} handler={vi.fn()} />);
            const event = press("q", { ctrlKey: true });
            expect(event.defaultPrevented).toBe(false);
        });

        it("passes a key on when the handler declines it with false, to the next registration", () => {
            const lower = vi.fn();
            const upper = vi.fn(() => false);
            renderIn(
                <>
                    <Claim shortcut={def(["x"], { scope: "global" })} handler={lower} />
                    <Claim shortcut={def(["x"], { scope: "mail" })} handler={upper} />
                </>,
            );
            const event = press("x");
            expect(upper).toHaveBeenCalledTimes(1);
            expect(lower).toHaveBeenCalledTimes(1);
            expect(event.defaultPrevented).toBe(true);
        });

        it("does not prevent the default when every handler declines", () => {
            renderIn(<Claim shortcut={def(["x"])} handler={() => false} />);
            expect(press("x").defaultPrevented).toBe(false);
        });

        it("treats any other return value (undefined, true) as handled", () => {
            renderIn(<Claim shortcut={def(["x"])} handler={() => true} />);
            expect(press("x").defaultPrevented).toBe(true);
        });

        it("prefers the most recently mounted registration in a scope, and returns to the older one on unmount", () => {
            const older = vi.fn();
            const newer = vi.fn();
            const { rerender } = renderIn(
                <>
                    <Claim shortcut={def(["x"])} handler={older} />
                    <Claim shortcut={def(["x"])} handler={newer} />
                </>,
            );
            press("x");
            expect(newer).toHaveBeenCalledTimes(1);
            expect(older).not.toHaveBeenCalled();
            rerender(
                <ShortcutProvider>
                    <Claim shortcut={def(["x"])} handler={older} />
                </ShortcutProvider>,
            );
            press("x");
            expect(older).toHaveBeenCalledTimes(1);
        });

        it("looks the handler up at the time of the key press, so it always sees current state without re-registering", () => {
            const seen: number[] = [];
            function Counter() {
                const [count, setCount] = useState(0);
                useShortcut("x", () => void seen.push(count), { scope: "mail" });
                return <button onClick={() => setCount((n) => n + 1)}>inc</button>;
            }
            const { getByText } = renderIn(<Counter />);
            press("x");
            act(() => getByText("inc").click());
            act(() => getByText("inc").click());
            press("x");
            expect(seen).toEqual([0, 2]);
        });

        it("takes a bare spec string, global unless a scope is given", () => {
            const global = vi.fn();
            const scoped = vi.fn();
            renderIn(
                <>
                    <Claim shortcut="ctrl+shift+y" handler={global} />
                    <Claim shortcut="ctrl+shift+u" handler={scoped} scope="mail" />
                </>,
            );
            press("y", { ctrlKey: true, shiftKey: true });
            press("u", { ctrlKey: true, shiftKey: true });
            expect(global).toHaveBeenCalledTimes(1);
            expect(scoped).toHaveBeenCalledTimes(1);
        });

        it("registers only while enabled", () => {
            const handler = vi.fn();
            const { rerender } = renderIn(<Claim shortcut={def(["x"])} handler={handler} enabled={false} />);
            expect(press("x").defaultPrevented).toBe(false);
            rerender(
                <ShortcutProvider>
                    <Claim shortcut={def(["x"])} handler={handler} enabled />
                </ShortcutProvider>,
            );
            expect(press("x").defaultPrevented).toBe(true);
            rerender(
                <ShortcutProvider>
                    <Claim shortcut={def(["x"])} handler={handler} enabled={false} />
                </ShortcutProvider>,
            );
            expect(press("x").defaultPrevented).toBe(false);
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it("does nothing outside a ShortcutProvider", () => {
            const handler = vi.fn();
            render(<Claim shortcut={def(["x"])} handler={handler} />);
            expect(press("x").defaultPrevented).toBe(false);
            expect(handler).not.toHaveBeenCalled();
        });

        it("rejects a spec it cannot parse when the component mounts", () => {
            const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
            expect(() => renderIn(<Claim shortcut="ctrl+banana" handler={vi.fn()} />)).toThrow(/unknown key/);
            spy.mockRestore();
        });

        it("stops listening when the provider unmounts", () => {
            const handler = vi.fn();
            const { unmount } = renderIn(<Claim shortcut={def(["x"])} handler={handler} />);
            unmount();
            press("x");
            expect(handler).not.toHaveBeenCalled();
        });
    });

    describe("events it must not touch", () => {
        it("ignores an event another handler already default-prevented (a menu, the rich-text editor's own bindings)", () => {
            const handler = vi.fn();
            renderIn(<Claim shortcut={def(["ctrl+r"])} handler={handler} />);
            const input = document.createElement("input");
            document.body.appendChild(input);
            input.addEventListener("keydown", (event) => event.preventDefault());
            press("r", { ctrlKey: true }, input);
            expect(handler).not.toHaveBeenCalled();
        });

        it("ignores IME composition", () => {
            const handler = vi.fn();
            renderIn(<Claim shortcut={def(["ctrl+r"])} handler={handler} />);
            press("r", { ctrlKey: true, isComposing: true });
            press("Process", { ctrlKey: true });
            expect(handler).not.toHaveBeenCalled();
        });

        it("ignores a bare modifier key", () => {
            const handler = vi.fn();
            renderIn(<Claim shortcut={def(["ctrl+r"])} handler={handler} />);
            for (const key of ["Control", "Shift", "Alt", "Meta"]) {
                press(key, { ctrlKey: true });
            }
            expect(handler).not.toHaveBeenCalled();
        });

        it("never handles Copy, Cut, Paste, Select all, Undo, Redo or Find - even if a view claims them", () => {
            const handler = vi.fn();
            renderIn(
                <>
                    {["ctrl+c", "ctrl+x", "ctrl+v", "ctrl+a", "ctrl+z", "ctrl+y", "ctrl+f", "mod+c"].map((spec) => (
                        <Claim key={spec} shortcut={def([spec])} handler={handler} />
                    ))}
                </>,
            );
            for (const key of ["c", "x", "v", "a", "z", "y", "f"]) {
                expect(press(key, { ctrlKey: true }).defaultPrevented, key).toBe(false);
            }
            expect(handler).not.toHaveBeenCalled();
        });

        it("leaves paste-as-plain-text and redo to a text field, while Ctrl+Shift+V (Move to) works everywhere else", () => {
            const handler = vi.fn();
            renderIn(
                <>
                    <Claim shortcut={def(["mod+shift+v"])} handler={handler} />
                    <Claim shortcut={def(["mod+shift+z"])} handler={handler} />
                </>,
            );
            const input = document.createElement("input");
            document.body.appendChild(input);
            expect(press("V", { ctrlKey: true, shiftKey: true }, input).defaultPrevented).toBe(false);
            expect(press("Z", { ctrlKey: true, shiftKey: true }, input).defaultPrevented).toBe(false);
            expect(handler).not.toHaveBeenCalled();
            expect(press("V", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
            expect(press("Z", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
            expect(handler).toHaveBeenCalledTimes(2);
        });

        it("does handle Ctrl+Shift+A and Ctrl+Shift+C, which are not text-editing chords", () => {
            const handler = vi.fn();
            renderIn(
                <>
                    <Claim shortcut={def(["ctrl+shift+a"])} handler={handler} />
                    <Claim shortcut={def(["ctrl+shift+c"])} handler={handler} />
                    <Claim shortcut={def(["ctrl+alt+c"])} handler={handler} />
                </>,
            );
            press("A", { ctrlKey: true, shiftKey: true });
            press("C", { ctrlKey: true, shiftKey: true });
            press("c", { ctrlKey: true, altKey: true });
            expect(handler).toHaveBeenCalledTimes(3);
        });
    });

    describe("held keys", () => {
        it("runs a one-shot action on the first press only, and swallows the repeats so a browser does not act on them", () => {
            const handler = vi.fn();
            renderIn(<Claim shortcut={def(["ctrl+r"])} handler={handler} />);
            expect(press("r", { ctrlKey: true }).defaultPrevented).toBe(true);
            const repeat = press("r", { ctrlKey: true, repeat: true });
            expect(handler).toHaveBeenCalledTimes(1);
            expect(repeat.defaultPrevented).toBe(true);
        });

        it("does not swallow a repeat of a key nobody claims", () => {
            renderIn(<Claim shortcut={def(["ctrl+r"])} handler={vi.fn()} />);
            expect(press("q", { ctrlKey: true, repeat: true }).defaultPrevented).toBe(false);
        });

        it("keeps running an action marked repeat", () => {
            const handler = vi.fn();
            renderIn(<Claim shortcut={def(["arrowdown"], { repeat: true })} handler={handler} />);
            press("ArrowDown");
            press("ArrowDown", { repeat: true });
            press("ArrowDown", { repeat: true });
            expect(handler).toHaveBeenCalledTimes(3);
        });
    });

    describe("platform", () => {
        it("uses Ctrl for mod on Windows and Linux", () => {
            const handler = vi.fn();
            renderIn(<Claim shortcut={def(["mod+r"])} handler={handler} />);
            press("r", { metaKey: true });
            expect(handler).not.toHaveBeenCalled();
            press("r", { ctrlKey: true });
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it("uses Cmd for mod on a Mac, and Ctrl still for a literal ctrl", () => {
            pretendMac();
            const mod = vi.fn();
            const literal = vi.fn();
            renderIn(
                <>
                    <Claim shortcut={def(["mod+r"])} handler={mod} />
                    <Claim shortcut={def(["ctrl+shift+a"])} handler={literal} />
                </>,
            );
            press("r", { ctrlKey: true });
            expect(mod).not.toHaveBeenCalled();
            press("r", { metaKey: true });
            press("A", { ctrlKey: true, shiftKey: true });
            expect(mod).toHaveBeenCalledTimes(1);
            expect(literal).toHaveBeenCalledTimes(1);
        });

        it("matches Option+N by its physical key on a Mac, where it types a dead key", () => {
            pretendMac();
            const handler = vi.fn();
            renderIn(<Claim shortcut={def(["alt+n"])} handler={handler} />);
            press("Dead", { altKey: true, code: "KeyN" });
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it("adds the desktop client's own keys only where window.rapidmx exists", () => {
            const handler = vi.fn();
            renderIn(<Claim shortcut={def(["alt+n"], { electronKeys: ["ctrl+n"] })} handler={handler} />);
            press("n", { ctrlKey: true });
            expect(handler).not.toHaveBeenCalled();
            (window as { rapidmx?: unknown }).rapidmx = {};
            press("n", { ctrlKey: true });
            press("n", { altKey: true });
            expect(handler).toHaveBeenCalledTimes(2);
        });

        it("has no desktop keys for a shortcut that declares none, even in the desktop client", () => {
            (window as { rapidmx?: unknown }).rapidmx = {};
            const handler = vi.fn();
            renderIn(<Claim shortcut={def(["alt+n"])} handler={handler} />);
            press("n", { altKey: true });
            expect(handler).toHaveBeenCalledTimes(1);
        });
    });

    describe("scopes", () => {
        it("lets the mounted view win over global, and global still work where the view has nothing", () => {
            const view = vi.fn();
            const global = vi.fn();
            renderIn(
                <>
                    <Claim shortcut={def(["x"], { scope: "global" })} handler={global} />
                    <Claim shortcut={def(["x"], { scope: "mail" })} handler={view} />
                    <Claim shortcut={def(["y"], { scope: "global" })} handler={global} />
                </>,
            );
            press("x");
            expect(view).toHaveBeenCalledTimes(1);
            expect(global).not.toHaveBeenCalled();
            press("y");
            expect(global).toHaveBeenCalledTimes(1);
        });

        it("runs each of the four view scopes", () => {
            const handlers = { mail: vi.fn(), calendar: vi.fn(), contacts: vi.fn(), tasks: vi.fn() };
            const keys = { mail: "m", calendar: "a", contacts: "o", tasks: "t" };
            renderIn(
                <>
                    {(Object.keys(handlers) as (keyof typeof handlers)[]).map((scope) => (
                        <Claim key={scope} shortcut={def([keys[scope]], { scope })} handler={handlers[scope]} />
                    ))}
                </>,
            );
            for (const key of Object.values(keys)) {
                press(key);
            }
            for (const handler of Object.values(handlers)) {
                expect(handler).toHaveBeenCalledTimes(1);
            }
        });

        it("silences everything but the dialog scope while a modal dialog is open", () => {
            const view = vi.fn();
            const global = vi.fn();
            const dialog = vi.fn();
            renderIn(
                <>
                    <Claim shortcut={def(["x"], { scope: "mail" })} handler={view} />
                    <Claim shortcut={def(["y"], { scope: "global" })} handler={global} />
                    <Claim shortcut={def(["z"], { scope: "dialog" })} handler={dialog} />
                </>,
            );
            press("z");
            expect(dialog).not.toHaveBeenCalled();
            const modal = document.createElement("div");
            modal.setAttribute("aria-modal", "true");
            document.body.appendChild(modal);
            expect(press("x").defaultPrevented).toBe(false);
            expect(press("y").defaultPrevented).toBe(false);
            press("z");
            expect(view).not.toHaveBeenCalled();
            expect(global).not.toHaveBeenCalled();
            expect(dialog).toHaveBeenCalledTimes(1);
            modal.remove();
            press("x");
            expect(view).toHaveBeenCalledTimes(1);
        });

        it("applies compose shortcuts only inside their window, where they beat the view and global ones", () => {
            const compose = vi.fn();
            const view = vi.fn();
            const global = vi.fn();
            function Window() {
                const ref = useRef<HTMLDivElement>(null);
                return (
                    <>
                        <div ref={ref} data-shortcut-scope="compose" role="dialog">
                            <input aria-label="inside" />
                        </div>
                        <input aria-label="outside" />
                        <Claim shortcut={def(["ctrl+s"], { scope: "compose" })} handler={compose} container={ref} />
                    </>
                );
            }
            const { getByLabelText } = renderIn(
                <>
                    <Window />
                    <Claim shortcut={def(["ctrl+s"], { scope: "mail" })} handler={view} />
                    <Claim shortcut={def(["ctrl+s", "ctrl+shift+m"], { scope: "global" })} handler={global} />
                </>,
            );
            press("s", { ctrlKey: true }, getByLabelText("outside"));
            expect(view).toHaveBeenCalledTimes(1);
            expect(compose).not.toHaveBeenCalled();
            press("s", { ctrlKey: true }, getByLabelText("inside"));
            expect(compose).toHaveBeenCalledTimes(1);
            expect(view).toHaveBeenCalledTimes(1);
            // The view's keys are off inside the window, but a global one that the window doesn't claim still works.
            press("M", { ctrlKey: true, shiftKey: true }, getByLabelText("inside"));
            expect(global).toHaveBeenCalledTimes(1);
        });

        it("ignores a compose shortcut whose window is not on screen (its container has no element)", () => {
            const compose = vi.fn();
            function Minimized() {
                const ref = useRef<HTMLDivElement>(null);
                return <Claim shortcut={def(["ctrl+s"], { scope: "compose" })} handler={compose} container={ref} />;
            }
            renderIn(<Minimized />);
            expect(press("s", { ctrlKey: true }).defaultPrevented).toBe(false);
            expect(compose).not.toHaveBeenCalled();
        });
    });

    describe("text fields and other widgets", () => {
        function field(html: string): HTMLElement {
            const host = document.createElement("div");
            host.innerHTML = html;
            document.body.appendChild(host);
            return host.firstElementChild as HTMLElement;
        }

        it("leaves bare keys to a text field, so j, ? and Delete type and edit", () => {
            const handler = vi.fn();
            renderIn(
                <>
                    <Claim shortcut={def(["j"])} handler={handler} />
                    <Claim shortcut={def(["?"])} handler={handler} />
                    <Claim shortcut={def(["delete"])} handler={handler} />
                    <Claim shortcut={def(["shift+delete"])} handler={handler} />
                </>,
            );
            for (const html of ["<input>", "<textarea></textarea>", '<div contenteditable="true"></div>', "<select></select>"]) {
                const target = field(html);
                expect(press("j", {}, target).defaultPrevented).toBe(false);
                expect(press("?", { shiftKey: true }, target).defaultPrevented).toBe(false);
                expect(press("Delete", {}, target).defaultPrevented).toBe(false);
                expect(press("Delete", { shiftKey: true }, target).defaultPrevented).toBe(false);
            }
            expect(handler).not.toHaveBeenCalled();
            expect(press("j").defaultPrevented).toBe(true);
        });

        it("lets a Ctrl/Alt/Cmd chord work from a text field", () => {
            const handler = vi.fn();
            renderIn(
                <>
                    <Claim shortcut={def(["ctrl+enter"])} handler={handler} />
                    <Claim shortcut={def(["alt+n"])} handler={handler} />
                    <Claim shortcut={def(["ctrl+shift+m"])} handler={handler} />
                </>,
            );
            const input = field("<input>");
            press("Enter", { ctrlKey: true }, input);
            press("n", { altKey: true }, input);
            press("M", { ctrlKey: true, shiftKey: true }, input);
            expect(handler).toHaveBeenCalledTimes(3);
        });

        it("leaves the caret and delete keys to a text field even with a modifier (word jumps, delete word)", () => {
            const handler = vi.fn();
            renderIn(
                <>
                    <Claim shortcut={def(["mod+arrowleft"])} handler={handler} />
                    <Claim shortcut={def(["mod+backspace"])} handler={handler} />
                    <Claim shortcut={def(["ctrl+home"])} handler={handler} />
                </>,
            );
            const input = field("<input>");
            press("ArrowLeft", { ctrlKey: true }, input);
            press("Backspace", { ctrlKey: true }, input);
            press("Home", { ctrlKey: true }, input);
            expect(handler).not.toHaveBeenCalled();
            press("ArrowLeft", { ctrlKey: true });
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it("does not take Option+letter from a text field on a Mac, where it types characters", () => {
            pretendMac();
            const handler = vi.fn();
            renderIn(<Claim shortcut={def(["alt+n"])} handler={handler} />);
            const input = field("<input>");
            press("Dead", { altKey: true, code: "KeyN" }, input);
            expect(handler).not.toHaveBeenCalled();
            press("Dead", { altKey: true, code: "KeyN" });
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it("does not take Ctrl+Alt (AltGr) from a text field on Windows and Linux, but does take it elsewhere", () => {
            const handler = vi.fn();
            renderIn(<Claim shortcut={def(["ctrl+alt+1"])} handler={handler} />);
            const input = field("<input>");
            press("1", { ctrlKey: true, altKey: true }, input);
            expect(handler).not.toHaveBeenCalled();
            press("1", { ctrlKey: true, altKey: true });
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it("still lets Cmd+Alt work from a text field on a Mac (Option alone does not, Cmd+Option does not type)", () => {
            pretendMac();
            const handler = vi.fn();
            renderIn(<Claim shortcut={def(["cmd+alt+k"])} handler={handler} />);
            press("k", { metaKey: true, altKey: true }, field("<input>"));
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it("lets Escape through from a text field, unless its popup is open or it is in a popover dialog", () => {
            const handler = vi.fn();
            renderIn(<Claim shortcut={def(["escape"])} handler={handler} />);
            expect(press("Escape", {}, field("<input>")).defaultPrevented).toBe(true);
            expect(press("Escape", {}, field('<input role="combobox" aria-expanded="true">')).defaultPrevented).toBe(false);
            const popover = field('<div role="dialog"><input id="pop"></div>');
            expect(press("Escape", {}, popover.querySelector("#pop")!).defaultPrevented).toBe(false);
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it("lets Escape through from outside a field, unless an open popup owns it", () => {
            const handler = vi.fn();
            renderIn(<Claim shortcut={def(["escape"])} handler={handler} />);
            expect(press("Escape").defaultPrevented).toBe(true);
            const trigger = field('<button aria-haspopup="true" aria-expanded="true">menu</button>');
            expect(press("Escape", {}, trigger).defaultPrevented).toBe(false);
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it("leaves bare keys to a widget that reads keys itself (an open menu, a list box)", () => {
            const handler = vi.fn();
            renderIn(<Claim shortcut={def(["j"])} handler={handler} />);
            const item = field('<div role="menu"><button id="i">x</button></div>').querySelector("#i")!;
            expect(press("j", {}, item).defaultPrevented).toBe(false);
            expect(press("j", {}, field("<p>x</p>")).defaultPrevented).toBe(true);
            // A chord is not a widget's key.
            const chord = vi.fn();
            renderIn(<Claim shortcut={def(["ctrl+j"])} handler={chord} />);
            press("j", { ctrlKey: true }, item);
            expect(chord).toHaveBeenCalledTimes(1);
        });

        it("leaves Enter and Space to a focused button or link", () => {
            const plain = vi.fn();
            renderIn(
                <>
                    <Claim shortcut={def(["enter"], { scope: "mail" })} handler={plain} />
                    <Claim shortcut={def(["space"], { scope: "tasks" })} handler={plain} />
                </>,
            );
            const button = field("<button>x</button>");
            expect(press("Enter", {}, button).defaultPrevented).toBe(false);
            expect(press(" ", {}, button).defaultPrevented).toBe(false);
            expect(plain).not.toHaveBeenCalled();
            press("Enter");
            press(" ");
            expect(plain).toHaveBeenCalledTimes(2);
        });

        it("takes Enter from a focused button when the shortcut asked for it", () => {
            const asked = vi.fn();
            renderIn(<Claim shortcut={def(["enter"], { scope: "mail", allowOnActivatable: true })} handler={asked} />);
            press("Enter", {}, field("<button>x</button>"));
            press("Enter");
            expect(asked).toHaveBeenCalledTimes(2);
        });

        it("does not treat Shift or Ctrl+Enter on a button as a bare key", () => {
            const handler = vi.fn();
            renderIn(<Claim shortcut={def(["ctrl+enter"])} handler={handler} />);
            press("Enter", { ctrlKey: true }, field("<button>x</button>"));
            expect(handler).toHaveBeenCalledTimes(1);
        });
    });

    describe("the registry", () => {
        it("lists what is mounted, updating as views come and go", () => {
            let listed: string[] = [];
            function Lister() {
                listed = useRegisteredShortcuts().map((registration) => registration.shortcut.id);
                return null;
            }
            const first = def(["a"], { id: "test.first" });
            const second = def(["b"], { id: "test.second", scope: "mail" });
            const { rerender } = renderIn(
                <>
                    <Lister />
                    <Claim shortcut={first} handler={vi.fn()} />
                </>,
            );
            expect(listed).toEqual(["test.first"]);
            rerender(
                <ShortcutProvider>
                    <Lister />
                    <Claim shortcut={first} handler={vi.fn()} />
                    <Claim shortcut={second} handler={vi.fn()} />
                </ShortcutProvider>,
            );
            expect(listed).toEqual(["test.first", "test.second"]);
            rerender(
                <ShortcutProvider>
                    <Lister />
                </ShortcutProvider>,
            );
            expect(listed).toEqual([]);
        });

        it("lists nothing outside a provider", () => {
            let count = -1;
            function Lister() {
                count = useRegisteredShortcuts().length;
                return null;
            }
            render(<Lister />);
            expect(count).toBe(0);
        });
    });
});

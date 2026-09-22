// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HiOutlinePencil, HiOutlineTrash, HiOutlineUserPlus } from "react-icons/hi2";
import ResponsiveToolbar, {
    ICON_BUTTON_WIDTH,
    LABELLED_BUTTON_WIDTH,
    ToolbarAction,
    layoutToolbar,
} from "../../../apps/shared/components/layout/ResponsiveToolbar.js";

const action = (id: string, group: number, rank: number, extra: Partial<ToolbarAction> = {}): ToolbarAction => ({
    id,
    label: id[0].toUpperCase() + id.slice(1),
    icon: HiOutlinePencil,
    onClick: vi.fn(),
    group,
    rank,
    ...extra,
});

/** The Contacts set: 8 actions in 4 groups; Import goes into "More" first. */
const CONTACTS = () => [
    action("new", 0, 99, { essential: true, icon: HiOutlineUserPlus }),
    action("edit", 1, 6),
    action("delete", 1, 5, { icon: HiOutlineTrash }),
    action("email", 2, 4),
    action("favorite", 2, 3),
    action("category", 2, 2),
    action("export", 3, 1),
    action("import", 3, 0),
];

describe("layoutToolbar", () => {
    it("shows everything with captions when it is not measured yet, or when it fits", () => {
        const all = CONTACTS().map((a) => a.id);
        expect(layoutToolbar(CONTACTS(), undefined)).toEqual({ labels: true, visible: all });
        // 16 padding + 8 x 64 + 3 dividers x 9.
        expect(LABELLED_BUTTON_WIDTH).toBe(64);
        expect(layoutToolbar(CONTACTS(), 555)).toEqual({ labels: true, visible: all });
        expect(layoutToolbar(CONTACTS(), 1200)).toEqual({ labels: true, visible: all });
    });

    it("drops the captions first: every action as an icon while that fits", () => {
        const all = CONTACTS().map((a) => a.id);
        // 16 + 8 x 36 + 3 x 9.
        expect(ICON_BUTTON_WIDTH).toBe(36);
        expect(layoutToolbar(CONTACTS(), 554)).toEqual({ labels: false, visible: all });
        expect(layoutToolbar(CONTACTS(), 331)).toEqual({ labels: false, visible: all });
    });

    it("then moves the least important into More, one at a time: Import, Export, Add category, then Favorite, Email, Delete, Edit", () => {
        const visible = (width: number) => layoutToolbar(CONTACTS(), width).visible;
        expect(visible(330)).toEqual(["new", "edit", "delete", "email", "favorite", "category"]);
        expect(visible(285)).toEqual(["new", "edit", "delete", "email", "favorite"]);
        expect(visible(249)).toEqual(["new", "edit", "delete", "email"]);
        expect(visible(213)).toEqual(["new", "edit", "delete"]);
        expect(visible(168)).toEqual(["new", "edit"]);
        expect(visible(132)).toEqual(["new"]);
        for (const width of [330, 249, 168, 132]) {
            expect(layoutToolbar(CONTACTS(), width).labels).toBe(false);
        }
    });

    it("never moves an essential action, however narrow, and keeps the order of the groups", () => {
        expect(layoutToolbar(CONTACTS(), 10).visible).toEqual(["new"]);
        const shuffled = [action("b", 2, 1), action("a", 1, 2, { essential: true }), action("c", 0, 0)];
        expect(layoutToolbar(shuffled, 1000).visible).toEqual(["c", "a", "b"]);
    });
});

/** A ResizeObserver a test can drive. */
class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    disconnected = false;
    constructor(public callback: (entries: { contentRect: { width: number } }[]) => void) {
        FakeResizeObserver.instances.push(this);
    }
    observe = vi.fn();
    disconnect() {
        this.disconnected = true;
    }
    static resize(width: number) {
        for (const instance of FakeResizeObserver.instances) {
            instance.callback([{ contentRect: { width } }]);
        }
    }
}

function measure(width: number) {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width, height: 40, left: 0, right: width, top: 100, bottom: 140, x: 0, y: 100, toJSON: () => ({}) });
}

beforeEach(() => {
    FakeResizeObserver.instances = [];
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const names = () => within(screen.getByRole("toolbar")).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);

describe("ResponsiveToolbar", () => {
    it("shows every action with its caption where there is no ResizeObserver (server render, tests) and never spills out of its own column", () => {
        render(<ResponsiveToolbar label="Things" actions={CONTACTS()} />);
        const toolbar = screen.getByRole("toolbar", { name: "Things" });
        expect(toolbar).toHaveClass("overflow-x-clip", "min-w-0");
        expect(names()).toEqual(["New", "Edit", "Delete", "Email", "Favorite", "Category", "Export", "Import"]);
        expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
        // Captions visible, no tooltips needed.
        expect(screen.getByRole("button", { name: "Edit" }).querySelector("span")).not.toHaveClass("sr-only");
        expect(screen.getByRole("button", { name: "Edit" })).not.toHaveAttribute("title");
    });

    it("draws dividers between the groups only", () => {
        const { container } = render(<ResponsiveToolbar label="Things" actions={CONTACTS()} />);
        expect(container.querySelectorAll('[aria-hidden="true"].w-px')).toHaveLength(3);
    });

    it("collapses captions to icons - with tooltips and the same accessible names - when the column is narrower than the captioned bar", () => {
        measure(400);
        render(<ResponsiveToolbar label="Things" actions={CONTACTS()} />);
        const edit = screen.getByRole("button", { name: "Edit" });
        expect(edit).toHaveAttribute("title", "Edit");
        expect(edit.querySelector("span")).toHaveClass("sr-only");
        expect(names()).toHaveLength(8);
        expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
    });

    it("follows the column as it is resized: captions, then icons, then a More menu, and back", () => {
        measure(700);
        render(<ResponsiveToolbar label="Things" actions={CONTACTS()} />);
        expect(screen.getByRole("button", { name: "Edit" })).not.toHaveAttribute("title");
        act(() => FakeResizeObserver.resize(300));
        expect(screen.getByRole("button", { name: "Edit" })).toHaveAttribute("title", "Edit");
        expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Import" })).not.toBeInTheDocument();
        act(() => FakeResizeObserver.resize(700));
        expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Import" })).toBeInTheDocument();
    });

    it("ignores a resize with no measurements, and stops observing when it goes", () => {
        measure(700);
        const { unmount } = render(<ResponsiveToolbar label="Things" actions={CONTACTS()} />);
        act(() => FakeResizeObserver.instances[0].callback([]));
        expect(names()).toHaveLength(8);
        unmount();
        expect(FakeResizeObserver.instances[0].disconnected).toBe(true);
    });

    it("keeps an action's own tooltip and aria-keyshortcuts (the shortcut's) in every layout", () => {
        measure(300);
        const withHint = [action("new", 0, 99, { essential: true, hint: { title: "New contact (Alt+N)", "aria-keyshortcuts": "Alt+N" } }), ...CONTACTS().slice(1)];
        render(<ResponsiveToolbar label="Things" actions={withHint} />);
        const button = screen.getByRole("button", { name: "New" });
        expect(button).toHaveAttribute("title", "New contact (Alt+N)");
        expect(button).toHaveAttribute("aria-keyshortcuts", "Alt+N");
    });

    it("runs an action when its button is clicked, and not while it is disabled", async () => {
        const actions = CONTACTS();
        actions[1].disabled = true;
        render(<ResponsiveToolbar label="Things" actions={actions} />);
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "New" }));
        await user.click(screen.getByRole("button", { name: "Edit" }));
        expect(actions[0].onClick).toHaveBeenCalledTimes(1);
        expect(actions[1].onClick).not.toHaveBeenCalled();
    });

    it("shows a toggle's pressed state", () => {
        render(<ResponsiveToolbar label="Things" actions={[action("list", 0, 1, { pressed: true }), action("grid", 0, 2, { pressed: false })]} />);
        expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("button", { name: "Grid" })).toHaveAttribute("aria-pressed", "false");
        expect(screen.getByRole("button", { name: "List" })).toHaveClass("bg-primary/10");
    });

    it("renders a leading node and the children (a hidden file input) inside the bar", () => {
        render(
            <ResponsiveToolbar label="Things" actions={CONTACTS()} leading={<span data-testid="lead">Menu</span>}>
                <input type="file" aria-label="Import file" />
            </ResponsiveToolbar>,
        );
        expect(within(screen.getByRole("toolbar")).getByTestId("lead")).toBeInTheDocument();
        expect(within(screen.getByRole("toolbar")).getByLabelText("Import file")).toBeInTheDocument();
    });

    describe("the arrow keys", () => {
        it("move focus between the buttons that can be used - wrapping round - and jump with Home and End", async () => {
            const actions = CONTACTS();
            actions[1].disabled = true;
            render(<ResponsiveToolbar label="Things" actions={actions} />);
            const user = userEvent.setup();
            screen.getByRole("button", { name: "New" }).focus();
            await user.keyboard("{ArrowRight}");
            expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
            await user.keyboard("{ArrowLeft}{ArrowLeft}");
            expect(screen.getByRole("button", { name: "Import" })).toHaveFocus();
            await user.keyboard("{ArrowRight}");
            expect(screen.getByRole("button", { name: "New" })).toHaveFocus();
            await user.keyboard("{End}");
            expect(screen.getByRole("button", { name: "Import" })).toHaveFocus();
            await user.keyboard("{Home}");
            expect(screen.getByRole("button", { name: "New" })).toHaveFocus();
            await user.keyboard("a");
            expect(screen.getByRole("button", { name: "New" })).toHaveFocus();
        });

        it("do nothing for something in the bar that is not one of its buttons", () => {
            render(
                <ResponsiveToolbar label="Things" actions={CONTACTS()}>
                    <input aria-label="Field" />
                </ResponsiveToolbar>,
            );
            const field = screen.getByLabelText("Field");
            field.focus();
            fireEvent.keyDown(field, { key: "ArrowRight" });
            expect(field).toHaveFocus();
        });
    });

    describe("the More menu", () => {
        function renderNarrow() {
            measure(200);
            const actions = CONTACTS();
            actions[7].disabled = false;
            actions[6].disabled = true;
            render(<ResponsiveToolbar label="Things" actions={actions} />);
            return actions;
        }

        it("holds what does not fit, as a menu of real menuitems, opened by the button and closed by choosing", async () => {
            const actions = renderNarrow();
            const user = userEvent.setup();
            const more = screen.getByRole("button", { name: "More actions" });
            expect(more).toHaveAttribute("aria-haspopup", "menu");
            expect(more).toHaveAttribute("aria-expanded", "false");
            expect(screen.queryByRole("menu")).not.toBeInTheDocument();

            await user.click(more);
            const menu = screen.getByRole("menu", { name: "More actions" });
            expect(more).toHaveAttribute("aria-expanded", "true");
            expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Email", "Favorite", "Category", "Export", "Import"]);
            expect(within(menu).getByRole("menuitem", { name: "Export" })).toBeDisabled();
            // The first item that can be used has the focus.
            expect(within(menu).getByRole("menuitem", { name: "Email" })).toHaveFocus();

            await user.click(within(menu).getByRole("menuitem", { name: "Import" }));
            expect(actions[7].onClick).toHaveBeenCalledTimes(1);
            expect(screen.queryByRole("menu")).not.toBeInTheDocument();
            expect(more).toHaveFocus();
        });

        it("is a keyboard menu: arrows (wrapping, skipping what is disabled), Home, End, Escape back to the button, Tab away, and ArrowDown on the button opens it", async () => {
            renderNarrow();
            const user = userEvent.setup();
            const more = screen.getByRole("button", { name: "More actions" });
            more.focus();
            await user.keyboard("{Enter}");
            const item = (name: string) => within(screen.getByRole("menu")).getByRole("menuitem", { name });
            expect(item("Email")).toHaveFocus();
            await user.keyboard("{ArrowDown}");
            expect(item("Favorite")).toHaveFocus();
            await user.keyboard("{ArrowDown}{ArrowDown}");
            expect(item("Import")).toHaveFocus();
            await user.keyboard("{ArrowDown}");
            expect(item("Email")).toHaveFocus();
            await user.keyboard("{ArrowUp}");
            expect(item("Import")).toHaveFocus();
            await user.keyboard("{Home}");
            expect(item("Email")).toHaveFocus();
            await user.keyboard("{End}");
            expect(item("Import")).toHaveFocus();
            await user.keyboard("x");
            expect(screen.getByRole("menu")).toBeInTheDocument();

            await user.keyboard("{Escape}");
            expect(screen.queryByRole("menu")).not.toBeInTheDocument();
            expect(more).toHaveFocus();

            await user.keyboard("{ArrowDown}");
            expect(screen.getByRole("menu")).toBeInTheDocument();
            await user.keyboard("{ArrowDown}");
            expect(item("Favorite")).toHaveFocus();
            await user.keyboard("{Tab}");
            expect(screen.queryByRole("menu")).not.toBeInTheDocument();
            // ArrowDown on an already open menu's button does not reopen anything.
            await user.click(more);
            more.focus();
            await user.keyboard("{ArrowDown}");
            expect(screen.getByRole("menu")).toBeInTheDocument();
        });

        it("closes on a click elsewhere, but not on one inside it or on its own button (which toggles)", async () => {
            renderNarrow();
            const user = userEvent.setup();
            const more = screen.getByRole("button", { name: "More actions" });
            await user.click(more);
            fireEvent.mouseDown(screen.getByRole("menu"));
            expect(screen.getByRole("menu")).toBeInTheDocument();
            fireEvent.mouseDown(more);
            expect(screen.getByRole("menu")).toBeInTheDocument();
            await user.click(more);
            expect(screen.queryByRole("menu")).not.toBeInTheDocument();
            await user.click(more);
            fireEvent.mouseDown(document.body);
            expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        });

        it("stays under its button as the window resizes or anything scrolls, and takes an item's shortcut hint with it", async () => {
            measure(200);
            const actions = CONTACTS();
            actions[3].hint = { title: "Email (Ctrl+E)", "aria-keyshortcuts": "Control+E" };
            render(<ResponsiveToolbar label="Things" actions={actions} />);
            await userEvent.setup().click(screen.getByRole("button", { name: "More actions" }));
            const menu = screen.getByRole("menu");
            expect(menu.style.position).toBe("fixed");
            expect(menu.style.top).toBe("144px");
            expect(within(menu).getByRole("menuitem", { name: "Email" })).toHaveAttribute("title", "Email (Ctrl+E)");
            expect(within(menu).getByRole("menuitem", { name: "Email" })).toHaveAttribute("aria-keyshortcuts", "Control+E");
            act(() => {
                window.dispatchEvent(new Event("resize"));
                window.dispatchEvent(new Event("scroll"));
            });
            expect(screen.getByRole("menu").style.top).toBe("144px");
        });

        it("is gone with the toolbar's own narrow layout when the column grows again", async () => {
            renderNarrow();
            await userEvent.setup().click(screen.getByRole("button", { name: "More actions" }));
            act(() => FakeResizeObserver.resize(900));
            expect(screen.queryByRole("menu")).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
        });
    });
});

// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import ContactsSidebar, { contactsViewKey, ContactsView } from "../../../apps/shared/components/contacts/ContactsSidebar.js";
import type { Contact } from "@rapidmx/react-shared/contactsApi.js";

function contact(overrides: Partial<Contact> = {}): Contact {
    return {
        uid: "c1",
        version: 0,
        dateCreated: "",
        dateModified: "",
        mailboxUid: "mb1",
        folderUid: "f1",
        displayName: "Jane Doe",
        emails: [],
        phones: [],
        addresses: [],
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("contactsViewKey", () => {
    it("returns a distinct key per view type, including the discriminating field for list/category.", () => {
        expect(contactsViewKey({ type: "all" })).toBe("all");
        expect(contactsViewKey({ type: "favorites" })).toBe("favorites");
        expect(contactsViewKey({ type: "deleted" })).toBe("deleted");
        expect(contactsViewKey({ type: "list", uid: "l1", name: "Friends" })).toBe("list:l1");
        expect(contactsViewKey({ type: "category", name: "VIP" })).toBe("category:VIP");
    });
});

describe("ContactsSidebar", () => {
    it("shows a total count for 'Your contacts' and a favorites count.", async () => {
        mockFetch(() => jsonResponse(200, []));
        const contacts = [contact({ uid: "c1" }), contact({ uid: "c2", favorite: true })];
        render(
            <ContactsSidebar mailboxUid="mb1" contacts={contacts} active={{ type: "all" }} onSelect={vi.fn()} />,
        );

        expect(screen.getByText("Your contacts").closest("button")).toHaveTextContent("2");
        expect(await screen.findByText("Favorites")).toBeInTheDocument();
        expect(screen.getByText("Favorites").closest("button")).toHaveTextContent("1");
    });

    it("marks the active view with aria-current, and calls onSelect for every nav item.", async () => {
        mockFetch(() => jsonResponse(200, []));
        const onSelect = vi.fn();
        const user = userEvent.setup();
        render(<ContactsSidebar mailboxUid="mb1" contacts={[]} active={{ type: "favorites" }} onSelect={onSelect} />);

        expect(screen.getByText("Favorites").closest("button")).toHaveAttribute("aria-current", "true");
        expect(screen.getByText("Your contacts").closest("button")).not.toHaveAttribute("aria-current");

        await user.click(screen.getByText("Your contacts"));
        expect(onSelect).toHaveBeenCalledWith({ type: "all" });

        await user.click(screen.getByText("Favorites"));
        expect(onSelect).toHaveBeenCalledWith({ type: "favorites" });

        await user.click(screen.getByText("Deleted"));
        expect(onSelect).toHaveBeenCalledWith({ type: "deleted" });
    });

    it("does nothing (no fetch, empty lists) when there is no mailboxUid yet.", () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        render(<ContactsSidebar contacts={[]} active={{ type: "all" }} onSelect={vi.fn()} />);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(screen.queryByText(/Friends/)).not.toBeInTheDocument();
    });

    it("fetches and renders the mailbox's contact lists, with a per-list contact count.", async () => {
        mockFetch(() =>
            jsonResponse(200, [{ uid: "l1", version: 0, dateCreated: "", dateModified: "", mailboxUid: "mb1", name: "Friends" }]),
        );
        const contacts = [contact({ uid: "c1", contactListUid: "l1" }), contact({ uid: "c2", contactListUid: "l1" }), contact({ uid: "c3" })];
        const onSelect = vi.fn();
        const user = userEvent.setup();
        render(<ContactsSidebar mailboxUid="mb1" contacts={contacts} active={{ type: "all" }} onSelect={onSelect} />);

        const listButton = await screen.findByText("Friends");
        expect(listButton.closest("button")).toHaveTextContent("2");

        await user.click(listButton);
        expect(onSelect).toHaveBeenCalledWith({ type: "list", uid: "l1", name: "Friends" });
    });

    it("marks a selected list as active by uid.", async () => {
        mockFetch(() =>
            jsonResponse(200, [{ uid: "l1", version: 0, dateCreated: "", dateModified: "", mailboxUid: "mb1", name: "Friends" }]),
        );
        render(
            <ContactsSidebar mailboxUid="mb1" contacts={[]} active={{ type: "list", uid: "l1", name: "Friends" }} onSelect={vi.fn()} />,
        );
        expect((await screen.findByText("Friends")).closest("button")).toHaveAttribute("aria-current", "true");
    });

    it("shows an error, using the ApiRequestError message, when loading contact lists fails.", async () => {
        const { ApiRequestError } = await import("@rapidmx/react-shared/api.js");
        mockFetch(() => {
            throw new ApiRequestError("nope", 500);
        });
        render(<ContactsSidebar mailboxUid="mb1" contacts={[]} active={{ type: "all" }} onSelect={vi.fn()} />);
        expect(await screen.findByText("nope")).toBeInTheDocument();
    });

    it("shows a generic error message when loading contact lists fails with a non-API error.", async () => {
        mockFetch(() => {
            throw new Error("boom");
        });
        render(<ContactsSidebar mailboxUid="mb1" contacts={[]} active={{ type: "all" }} onSelect={vi.fn()} />);
        expect(await screen.findByText("Could not load contact lists.")).toBeInTheDocument();
    });

    it("re-fetches contact lists when refreshToken changes.", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        const { rerender } = render(
            <ContactsSidebar mailboxUid="mb1" contacts={[]} active={{ type: "all" }} onSelect={vi.fn()} refreshToken={1} />,
        );
        await screen.findByText("Your contact lists");

        rerender(<ContactsSidebar mailboxUid="mb1" contacts={[]} active={{ type: "all" }} onSelect={vi.fn()} refreshToken={2} />);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        // Let the second fetch's own resolution/setState settle before the test (and its cleanup) ends.
        await screen.findByText("Your contact lists");
    });

    it("derives the distinct set of categories from the loaded contacts, sorted alphabetically.", async () => {
        mockFetch(() => jsonResponse(200, []));
        const contacts = [
            contact({ uid: "c1", categories: ["VIP", "Work"] }),
            contact({ uid: "c2", categories: ["Family"] }),
            contact({ uid: "c3" }),
        ];
        render(<ContactsSidebar mailboxUid="mb1" contacts={contacts} active={{ type: "all" }} onSelect={vi.fn()} />);

        const categoryHeading = await screen.findByText("Categories");
        const categoryNames = ["Family", "VIP", "Work"];
        for (const name of categoryNames) {
            expect(screen.getByText(name)).toBeInTheDocument();
        }
        expect(categoryHeading).toBeInTheDocument();
    });

    it("omits the Categories section entirely when no contact has any category.", async () => {
        mockFetch(() => jsonResponse(200, []));
        render(<ContactsSidebar mailboxUid="mb1" contacts={[contact()]} active={{ type: "all" }} onSelect={vi.fn()} />);
        await screen.findByText("Your contact lists");
        expect(screen.queryByText("Categories")).not.toBeInTheDocument();
    });

    it("selects a category view when a category is clicked, and marks it active.", async () => {
        mockFetch(() => jsonResponse(200, []));
        const onSelect = vi.fn();
        const user = userEvent.setup();
        const contacts = [contact({ categories: ["VIP"] })];
        const { rerender } = render(
            <ContactsSidebar mailboxUid="mb1" contacts={contacts} active={{ type: "all" }} onSelect={onSelect} />,
        );

        await user.click(await screen.findByText("VIP"));
        expect(onSelect).toHaveBeenCalledWith({ type: "category", name: "VIP" });

        rerender(<ContactsSidebar mailboxUid="mb1" contacts={contacts} active={{ type: "category", name: "VIP" }} onSelect={onSelect} />);
        expect(screen.getByText("VIP").closest("button")).toHaveAttribute("aria-current", "true");
    });

    it("opens the mobile drawer via the menu button, and selecting a view closes it again.", async () => {
        mockFetch(() => jsonResponse(200, []));
        const onSelect = vi.fn();
        const user = userEvent.setup();
        render(<ContactsSidebar mailboxUid="mb1" contacts={[]} active={{ type: "all" }} onSelect={onSelect} />);

        expect(screen.queryByRole("dialog", { name: "Contacts" })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Open contacts menu" }));
        const drawer = screen.getByRole("dialog", { name: "Contacts" });
        await user.click(within(drawer).getByText("Favorites"));

        expect(onSelect).toHaveBeenCalledWith({ type: "favorites" });
        expect(screen.queryByRole("dialog", { name: "Contacts" })).not.toBeInTheDocument();
    });

    it("closes the mobile drawer via its own Close button", async () => {
        mockFetch(() => jsonResponse(200, []));
        const user = userEvent.setup();
        render(<ContactsSidebar mailboxUid="mb1" contacts={[]} active={{ type: "all" }} onSelect={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Open contacts menu" }));
        const drawer = screen.getByRole("dialog", { name: "Contacts" });
        await user.click(within(drawer).getByRole("button", { name: "Close" }));

        expect(screen.queryByRole("dialog", { name: "Contacts" })).not.toBeInTheDocument();
    });

    it("opens a new-list form, creates the list, and appends it to the sidebar sorted by name.", async () => {
        const fetchMock = mockFetch((url, init) => {
            if (init?.method === "POST") {
                return jsonResponse(200, { uid: "l2", version: 0, dateCreated: "", dateModified: "", mailboxUid: "mb1", name: "Aardvarks" });
            }
            return jsonResponse(200, [{ uid: "l1", version: 0, dateCreated: "", dateModified: "", mailboxUid: "mb1", name: "Friends" }]);
        });
        const user = userEvent.setup();
        render(<ContactsSidebar mailboxUid="mb1" contacts={[]} active={{ type: "all" }} onSelect={vi.fn()} />);

        await screen.findByText("Friends");
        await user.click(screen.getByLabelText("New contact list"));
        await user.type(screen.getByLabelText("New list name"), "Aardvarks");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/contact-lists",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ mailboxUid: "mb1", name: "Aardvarks" }) }),
        );
        const names = (await screen.findAllByRole("button")).map((b) => b.textContent).filter((t) => t?.includes("Aardvarks") || t?.includes("Friends"));
        // "Aardvarks" (just created) should now sort before "Friends".
        expect(names[0]).toContain("Aardvarks");
    });

    it("does not submit the new-list form when the mailbox or name is missing.", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        const user = userEvent.setup();
        render(<ContactsSidebar mailboxUid="mb1" contacts={[]} active={{ type: "all" }} onSelect={vi.fn()} />);

        await user.click(screen.getByLabelText("New contact list"));
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(fetchMock).not.toHaveBeenCalledWith("/api/mail/contact-lists", expect.objectContaining({ method: "POST" }));
    });

    it("shows a generic error message when creating a new list fails with a non-API error.", async () => {
        const fetchMock = mockFetch((url, init) => {
            if (init?.method === "POST") {
                throw new Error("nope");
            }
            return jsonResponse(200, []);
        });
        const user = userEvent.setup();
        render(<ContactsSidebar mailboxUid="mb1" contacts={[]} active={{ type: "all" }} onSelect={vi.fn()} />);

        await user.click(screen.getByLabelText("New contact list"));
        await user.type(screen.getByLabelText("New list name"), "Oops");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByText("Could not create this list.")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalled();
    });

    it("shows the ApiRequestError message when creating a new list fails with an API error.", async () => {
        const { ApiRequestError } = await import("@rapidmx/react-shared/api.js");
        mockFetch((url, init) => {
            if (init?.method === "POST") {
                throw new ApiRequestError("list name already taken", 409);
            }
            return jsonResponse(200, []);
        });
        const user = userEvent.setup();
        render(<ContactsSidebar mailboxUid="mb1" contacts={[]} active={{ type: "all" }} onSelect={vi.fn()} />);

        await user.click(screen.getByLabelText("New contact list"));
        await user.type(screen.getByLabelText("New list name"), "Oops");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByText("list name already taken")).toBeInTheDocument();
    });
});

// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import ContactDetailPane from "../../../apps/shared/components/contacts/ContactDetailPane.js";
import ContactForm from "../../../apps/shared/components/contacts/ContactForm.js";
import ContactPhotoField from "../../../apps/shared/components/contacts/ContactPhotoField.js";
import FavoriteStarButton from "../../../apps/shared/components/contacts/FavoriteStarButton.js";
import { getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";
import type { Contact } from "../../../lib/contacts/contactsApi.js";

beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function contact(overrides: Partial<Contact> = {}): Contact {
    return {
        uid: "c1",
        version: 3,
        dateCreated: "",
        dateModified: "",
        mailboxUid: "mb1",
        folderUid: "f1",
        displayName: "Jane Doe",
        emails: [{ address: "jane@example.com", type: "work" }],
        phones: [],
        addresses: [],
        ...overrides,
    };
}

function png(size = 10, type = "image/png"): File {
    return new File([new Uint8Array(size)], "me.png", { type });
}

describe("FavoriteStarButton", () => {
    it("is a toggle named Favorite that is filled when the contact is one", async () => {
        const onToggle = vi.fn();
        const user = userEvent.setup();
        const { rerender } = render(<FavoriteStarButton favorite={false} onToggle={onToggle} />);
        const off = screen.getByRole("button", { name: "Favorite" });
        expect(off).toHaveAttribute("aria-pressed", "false");
        expect(off).toHaveAttribute("title", "Add to favorites");
        await user.click(off);
        expect(onToggle).toHaveBeenCalledTimes(1);

        rerender(<FavoriteStarButton favorite onToggle={onToggle} disabled className="x" />);
        const on = screen.getByRole("button", { name: "Favorite" });
        expect(on).toHaveAttribute("aria-pressed", "true");
        expect(on).toHaveAttribute("title", "Remove from favorites");
        expect(on).toBeDisabled();
    });
});

describe("ContactPhotoField", () => {
    const base = { displayName: "Jane Doe", picked: null, removed: false, onPick: vi.fn(), onRemove: vi.fn(), onReject: vi.fn() };

    it("offers to add a picture when there is none, and takes a good file", async () => {
        const onPick = vi.fn();
        const user = userEvent.setup();
        render(<ContactPhotoField {...base} onPick={onPick} />);
        expect(screen.queryByRole("button", { name: "Remove photo" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Add photo" }));
        const file = png();
        await user.upload(screen.getByLabelText("Contact photo file"), file);
        expect(onPick).toHaveBeenCalledWith(file);
    });

    it("turns down a file of another type or over a megabyte, and ignores a cancelled choice", () => {
        const onPick = vi.fn();
        const onReject = vi.fn();
        render(<ContactPhotoField {...base} onPick={onPick} onReject={onReject} />);
        const input = screen.getByLabelText("Contact photo file");
        fireEvent.change(input, { target: { files: [png(10, "image/svg+xml")] } });
        expect(onReject).toHaveBeenLastCalledWith("Choose a JPEG, PNG, GIF or WebP image.");
        fireEvent.change(input, { target: { files: [png(1024 * 1024 + 1)] } });
        expect(onReject).toHaveBeenLastCalledWith("Choose an image no larger than 1 MB.");
        fireEvent.change(input, { target: { files: [] } });
        expect(onReject).toHaveBeenCalledTimes(2);
        expect(onPick).not.toHaveBeenCalled();
    });

    it("previews the chosen file, then lets it go again, and shows the current picture with Change and Remove", async () => {
        const onRemove = vi.fn();
        const user = userEvent.setup();
        const file = png();
        const { container, rerender, unmount } = render(<ContactPhotoField {...base} currentUrl="/p?v=1" picked={file} onRemove={onRemove} />);
        expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:preview");
        expect(screen.getByRole("button", { name: "Change photo" })).toBeInTheDocument();

        rerender(<ContactPhotoField {...base} currentUrl="/p?v=1" picked={null} onRemove={onRemove} />);
        expect(container.querySelector("img")?.getAttribute("src")).toBe("/p?v=1");
        await user.click(screen.getByRole("button", { name: "Remove photo" }));
        expect(onRemove).toHaveBeenCalled();

        rerender(<ContactPhotoField {...base} currentUrl="/p?v=1" picked={null} removed />);
        expect(container.querySelector("img")?.getAttribute("src") ?? "").not.toBe("/p?v=1");
        expect(screen.getByRole("button", { name: "Add photo" })).toBeInTheDocument();
        rerender(<ContactPhotoField {...base} picked={file} />);
        unmount();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
    });
});

describe("ContactForm picture and star", () => {
    it("uploads a chosen picture after saving the contact and hands back the contact with it", async () => {
        const fetchMock = mockFetch((url, init) => {
            if (url.includes("/photo")) {
                return jsonResponse(200, contact({ version: 5, photoBlobKey: "contact-photos/c1/x" }));
            }
            return jsonResponse(200, { ...contact(), ...JSON.parse(init.body as string), version: 4 });
        });
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(<ContactForm contact={contact()} onSaved={onSaved} onCancel={vi.fn()} />);
        await user.upload(screen.getByLabelText("Contact photo file"), png());
        await user.click(screen.getByRole("button", { name: "Favorite" }));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(onSaved.mock.calls[0][0]).toMatchObject({ version: 5, photoBlobKey: "contact-photos/c1/x" });
        expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).favorite).toBe(true);
        const upload = fetchMock.mock.calls[1];
        expect(upload[0]).toBe("/api/mail/contacts/c1/photo?version=4");
        expect((upload[1] as RequestInit).method).toBe("PUT");
    });

    it("removes the current picture after saving, and a chosen one is dropped when the current one is removed", async () => {
        const fetchMock = mockFetch((_url, init) => {
            if (init.method === "DELETE") {
                return jsonResponse(200, contact({ version: 5 }));
            }
            return jsonResponse(200, contact({ version: 4, photoBlobKey: "contact-photos/c1/x" }));
        });
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(<ContactForm contact={contact({ photoBlobKey: "contact-photos/c1/x" })} onSaved={onSaved} onCancel={vi.fn()} />);
        await user.upload(screen.getByLabelText("Contact photo file"), png());
        await user.click(screen.getByRole("button", { name: "Remove photo" }));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(fetchMock.mock.calls).toHaveLength(2);
        expect(fetchMock.mock.calls[1][0]).toBe("/api/mail/contacts/c1/photo?version=4");
        expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("DELETE");
        expect(onSaved.mock.calls[0][0].version).toBe(5);
    });

    it("does not ask to remove a picture the saved contact does not have, and shows a rejected file", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, contact({ version: 4 })));
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(<ContactForm contact={contact({ photoBlobKey: "contact-photos/c1/x" })} onSaved={onSaved} onCancel={vi.fn()} />);
        fireEvent.change(screen.getByLabelText("Contact photo file"), { target: { files: [png(10, "image/svg+xml")] } });
        expect(await screen.findByText("Choose a JPEG, PNG, GIF or WebP image.")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Remove photo" }));
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("says why a picture could not be saved", async () => {
        mockFetch((url, init) =>
            url.includes("/photo") ? jsonResponse(413, { message: "Too big." }) : jsonResponse(200, { ...contact(), ...JSON.parse(init.body as string), version: 4 }),
        );
        const user = userEvent.setup();
        render(<ContactForm contact={contact()} onSaved={vi.fn()} onCancel={vi.fn()} />);
        await user.upload(screen.getByLabelText("Contact photo file"), png());
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Too big.")).toBeInTheDocument();
    });
});

describe("ContactDetailPane star and copy", () => {
    it("shows the picture, copies an email address, and toggles the star through the server", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, contact({ version: 4, favorite: true })));
        const onChanged = vi.fn();
        const user = userEvent.setup();
        const writeText = vi.spyOn(navigator.clipboard, "writeText");
        const { container } = render(
            <ContactDetailPane contact={contact({ photoBlobKey: "contact-photos/c1/x" })} onEdit={vi.fn()} onDelete={vi.fn()} onChanged={onChanged} />,
        );
        expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/mail/contacts/c1/photo?v=3");

        await user.click(screen.getByRole("button", { name: "Copy email address" }));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith("jane@example.com"));

        await user.click(screen.getByRole("button", { name: "Favorite" }));
        await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ favorite: true })));
        expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({ uid: "c1", version: 3, favorite: true });
    });

    it("says when the star could not be changed", async () => {
        mockFetch(() => jsonResponse(403, { message: "No." }));
        const user = userEvent.setup();
        render(<ContactDetailPane contact={contact({ favorite: true })} onEdit={vi.fn()} onDelete={vi.fn()} />);
        expect(screen.getByRole("button", { name: "Favorite" })).toHaveAttribute("aria-pressed", "true");
        await user.click(screen.getByRole("button", { name: "Favorite" }));
        await waitFor(() => expect(getNotificationsSnapshot().visible.some((n) => n.title === "Couldn't update this contact")).toBe(true));
    });

    it("has nobody to tell when nobody listens", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, contact({ favorite: true })));
        const user = userEvent.setup();
        render(<ContactDetailPane contact={contact()} onEdit={vi.fn()} onDelete={vi.fn()} />);
        await user.click(screen.getByRole("button", { name: "Favorite" }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(screen.getByRole("button", { name: "Favorite" })).toBeInTheDocument();
    });
});

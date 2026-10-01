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
import { ContactPhotoError, prepareContactPhoto } from "../../../lib/contacts/preparePhoto.js";
import { ApiClientContext } from "../../../lib/util/apiClientContext.js";
import type { ApiClient } from "../../../lib/util/api.js";

// Making a picture small enough is `preparePhoto.test.ts`'s business (jsdom cannot decode or draw one): here it hands the file back, or fails, on demand.
vi.mock("../../../lib/contacts/preparePhoto.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/contacts/preparePhoto.js")>()),
    prepareContactPhoto: vi.fn(async (file: File) => file),
}));

beforeEach(() => {
    vi.mocked(prepareContactPhoto).mockImplementation(async (file: File) => file);
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

/** Opens the camera badge's menu. */
async function openMenu(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Change contact photo" }));
}

describe("ContactPhotoField", () => {
    const base = { displayName: "Jane Doe", picked: null, removed: false, onPick: vi.fn(), onRemove: vi.fn(), onReject: vi.fn(), onBusyChange: vi.fn() };

    it("offers Upload file (and no Remove photo) when there is no picture, and takes a good file", async () => {
        const onPick = vi.fn();
        const user = userEvent.setup();
        render(<ContactPhotoField {...base} onPick={onPick} />);
        await openMenu(user);
        expect(screen.queryByRole("menuitem", { name: "Remove photo" })).not.toBeInTheDocument();
        const click = vi.spyOn(HTMLInputElement.prototype, "click");
        await user.click(screen.getByRole("menuitem", { name: "Upload file" }));
        expect(click).toHaveBeenCalledTimes(1);
        const file = png();
        const input = screen.getByLabelText("Contact photo file");
        // Any picture is offered (so a phone's picker gives the camera and the library); making it fit is `prepareContactPhoto()`'s job.
        expect(input).toHaveAttribute("accept", "image/*");
        await user.upload(input, file);
        await waitFor(() => expect(onPick).toHaveBeenCalledWith(file));
        expect(prepareContactPhoto).toHaveBeenCalledWith(file);
    });

    it("passes on the picture that was made ready, not the one chosen", async () => {
        const ready = png(5);
        vi.mocked(prepareContactPhoto).mockResolvedValue(ready);
        const onPick = vi.fn();
        render(<ContactPhotoField {...base} onPick={onPick} />);
        fireEvent.change(screen.getByLabelText("Contact photo file"), { target: { files: [png(6 * 1024 * 1024, "image/heic")] } });
        await waitFor(() => expect(onPick).toHaveBeenCalledWith(ready));
    });

    it("says it is preparing the picture, with the buttons off, until it is ready", async () => {
        let ready!: (file: File) => void;
        vi.mocked(prepareContactPhoto).mockImplementation(() => new Promise<File>((resolve) => (ready = resolve)));
        const onPick = vi.fn();
        const onBusyChange = vi.fn();
        render(<ContactPhotoField {...base} currentUrl="/p?v=1" onPick={onPick} onBusyChange={onBusyChange} />);
        fireEvent.change(screen.getByLabelText("Contact photo file"), { target: { files: [png()] } });
        expect(await screen.findByRole("status")).toHaveTextContent("Preparing picture…");
        expect(screen.getByRole("button", { name: "Change contact photo" })).toBeDisabled();
        expect(onBusyChange).toHaveBeenLastCalledWith(true);
        expect(onPick).not.toHaveBeenCalled();

        const file = png(3);
        ready(file);
        await waitFor(() => expect(onPick).toHaveBeenCalledWith(file));
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(onBusyChange).toHaveBeenLastCalledWith(false);
        expect(screen.getByRole("button", { name: "Change contact photo" })).toBeEnabled();
    });

    it("shows why a picture could not be made ready, and ignores a cancelled choice", async () => {
        const onPick = vi.fn();
        const onReject = vi.fn();
        const onBusyChange = vi.fn();
        render(<ContactPhotoField {...base} onPick={onPick} onReject={onReject} onBusyChange={onBusyChange} />);
        const input = screen.getByLabelText("Contact photo file");
        vi.mocked(prepareContactPhoto).mockRejectedValueOnce(new ContactPhotoError());
        fireEvent.change(input, { target: { files: [png(10, "image/heic")] } });
        await waitFor(() =>
            expect(onReject).toHaveBeenLastCalledWith("This picture's format isn't supported by your browser — choose a JPEG or PNG instead."),
        );
        vi.mocked(prepareContactPhoto).mockRejectedValueOnce(new Error("boom"));
        fireEvent.change(input, { target: { files: [png()] } });
        await waitFor(() => expect(onReject).toHaveBeenLastCalledWith("This picture could not be read - choose another one."));
        fireEvent.change(input, { target: { files: [] } });
        expect(onReject).toHaveBeenCalledTimes(2);
        expect(onPick).not.toHaveBeenCalled();
        expect(onBusyChange).toHaveBeenLastCalledWith(false);
        expect(onBusyChange).toHaveBeenCalledTimes(4);
    });

    it("previews the chosen file, then lets it go again, and shows the current picture with a menu that can remove it", async () => {
        const onRemove = vi.fn();
        const user = userEvent.setup();
        const file = png();
        const { container, rerender, unmount } = render(<ContactPhotoField {...base} currentUrl="/p?v=1" picked={file} onRemove={onRemove} />);
        expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:preview");
        expect(screen.getByRole("button", { name: "Change contact photo" })).toBeInTheDocument();

        rerender(<ContactPhotoField {...base} currentUrl="/p?v=1" picked={null} onRemove={onRemove} />);
        expect(container.querySelector("img")?.getAttribute("src")).toBe("/p?v=1");
        await openMenu(user);
        await user.click(screen.getByRole("menuitem", { name: "Remove photo" }));
        expect(onRemove).toHaveBeenCalled();

        rerender(<ContactPhotoField {...base} currentUrl="/p?v=1" picked={null} removed />);
        expect(container.querySelector("img")?.getAttribute("src") ?? "").not.toBe("/p?v=1");
        await openMenu(user);
        expect(screen.queryByRole("menuitem", { name: "Remove photo" })).not.toBeInTheDocument();
        await user.keyboard("{Escape}");
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
        await openMenu(user);
        await user.click(screen.getByRole("menuitem", { name: "Remove photo" }));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(fetchMock.mock.calls).toHaveLength(2);
        expect(fetchMock.mock.calls[1][0]).toBe("/api/mail/contacts/c1/photo?version=4");
        expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("DELETE");
        expect(onSaved.mock.calls[0][0].version).toBe(5);
    });

    it("does not ask to remove a picture the saved contact does not have, and shows a picture that could not be used", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, contact({ version: 4 })));
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(<ContactForm contact={contact({ photoBlobKey: "contact-photos/c1/x" })} onSaved={onSaved} onCancel={vi.fn()} />);
        vi.mocked(prepareContactPhoto).mockRejectedValueOnce(new ContactPhotoError());
        fireEvent.change(screen.getByLabelText("Contact photo file"), { target: { files: [png(10, "image/heic")] } });
        expect(await screen.findByText("This picture's format isn't supported by your browser — choose a JPEG or PNG instead.")).toBeInTheDocument();
        await openMenu(user);
        await user.click(screen.getByRole("menuitem", { name: "Remove photo" }));
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("cannot be saved until a chosen picture is ready, and then saves the prepared one", async () => {
        let ready!: (file: File) => void;
        vi.mocked(prepareContactPhoto).mockImplementation(() => new Promise<File>((resolve) => (ready = resolve)));
        const fetchMock = mockFetch((url, init) =>
            url.includes("/photo") ? jsonResponse(200, contact({ version: 5, photoBlobKey: "k" })) : jsonResponse(200, { ...contact(), ...JSON.parse(init.body as string), version: 4 }),
        );
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(<ContactForm contact={contact()} onSaved={onSaved} onCancel={vi.fn()} />);
        fireEvent.change(screen.getByLabelText("Contact photo file"), { target: { files: [png(6 * 1024 * 1024)] } });
        await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());

        const prepared = new File([new Uint8Array(7)], "me.jpg", { type: "image/jpeg" });
        ready(prepared);
        await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe(prepared);
    });

    it("says why a picture could not be saved", async () => {
        mockFetch((url, init) =>
            url.includes("/photo") ? jsonResponse(413, { message: "Too big." }) : jsonResponse(200, { ...contact(), ...JSON.parse(init.body as string), version: 4 }),
        );
        const user = userEvent.setup();
        render(<ContactForm contact={contact()} onSaved={vi.fn()} onCancel={vi.fn()} />);
        await user.upload(screen.getByLabelText("Contact photo file"), png());
        await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
        await user.click(screen.getByRole("button", { name: "Save" }));
        // The contact itself is saved by then: the form says so, and why the picture was not.
        expect(await screen.findByText("Saved, but the picture could not be uploaded: Too big.")).toBeInTheDocument();
    });
});

describe("ContactForm retrying the picture", () => {
    it("reads the contact again and retries once when the picture's version turns out to be stale (the first try had been applied)", async () => {
        const puts: string[] = [];
        const fetchMock = mockFetch((url, init) => {
            if (url.includes("/photo")) {
                puts.push(url);
                if (puts.length === 1) {
                    return jsonResponse(503, { message: "Gone." });
                }
                return puts.length === 2 ? jsonResponse(409, { message: "Version mismatch." }) : jsonResponse(200, contact({ version: 6, photoBlobKey: "contact-photos/c1/x" }));
            }
            if (init.method === "GET" || init.method === undefined) {
                return jsonResponse(200, contact({ version: 5, photoBlobKey: "contact-photos/c1/x" }));
            }
            return jsonResponse(200, { ...contact(), ...JSON.parse(init.body as string), version: 4 });
        });
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(<ContactForm contact={contact()} onSaved={onSaved} onCancel={vi.fn()} />);
        await user.upload(screen.getByLabelText("Contact photo file"), png());
        await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText(/Saved, but the picture could not be uploaded/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(puts).toEqual([
            "/api/mail/contacts/c1/photo?version=4",
            "/api/mail/contacts/c1/photo?version=4",
            "/api/mail/contacts/c1/photo?version=5",
        ]);
        expect(onSaved.mock.calls[0][0]).toMatchObject({ version: 6 });
        expect(fetchMock.mock.calls.some(([url]) => url === "/api/mail/contacts/c1")).toBe(true);
    });

    it("says what went wrong when the retry fails too, or the contact cannot be read again", async () => {
        mockFetch((url, init) => {
            if (url.includes("/photo")) {
                return jsonResponse(409, { message: "Version mismatch." });
            }
            if (init.method === "GET" || init.method === undefined) {
                return jsonResponse(404, { message: "Gone." });
            }
            return jsonResponse(200, { ...contact(), ...JSON.parse(init.body as string), version: 4 });
        });
        const user = userEvent.setup();
        render(<ContactForm contact={contact()} onSaved={vi.fn()} onCancel={vi.fn()} />);
        await user.upload(screen.getByLabelText("Contact photo file"), png());
        await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Saved, but the picture could not be uploaded: Gone.")).toBeInTheDocument();
    });
});

describe("ContactForm under an explicit client", () => {
    function tokenClient() {
        const photo = new Blob([new Uint8Array(3)], { type: "image/jpeg" });
        return {
            fetch: vi.fn(async (path: string, init?: RequestInit) =>
                path.includes("/photo") ? contact({ version: 5, photoBlobKey: "k" }) : { ...contact(), ...JSON.parse(init!.body as string), version: 4 },
            ),
            fetchBlob: vi.fn(async () => photo),
            setUnauthorizedObserver: vi.fn(),
        };
    }

    it("sends the picture through the client (its origin and token) and shows the current one fetched through it", async () => {
        const client = tokenClient();
        const fetchMock = mockFetch(() => jsonResponse(500, {}));
        const onSaved = vi.fn();
        const user = userEvent.setup();
        const { container } = render(
            <ApiClientContext.Provider value={client as unknown as ApiClient}>
                <ContactForm contact={contact({ photoBlobKey: "k" })} onSaved={onSaved} onCancel={vi.fn()} />
            </ApiClientContext.Provider>,
        );
        await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:preview"));
        expect(client.fetchBlob).toHaveBeenCalledWith("/mail/contacts/c1/photo?v=3");

        const file = png(10, "image/jpeg");
        await user.upload(screen.getByLabelText("Contact photo file"), file);
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(client.fetch).toHaveBeenLastCalledWith(
            "/mail/contacts/c1/photo?version=4",
            expect.objectContaining({ method: "PUT", body: file, headers: { "Content-Type": "image/jpeg" } }),
        );
        expect(fetchMock).not.toHaveBeenCalled();
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

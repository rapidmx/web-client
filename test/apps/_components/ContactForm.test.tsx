// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import ContactForm from "../../../apps/shared/components/contacts/ContactForm.js";
import { Contact } from "@rapidmx/react-shared/contacts/contactsApi.js";

// Most of ContactForm's behavior is exercised through the Contacts page tests (test/apps/contacts); this
// file covers the round-3 fixes: every address is kept, and cleared fields are sent as null on update.

function contact(overrides: Partial<Contact> = {}): Contact {
    return {
        uid: "c1",
        version: 3,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        folderUid: "f1",
        displayName: "Jane Doe",
        givenName: "Jane",
        surname: "Doe",
        company: "Acme",
        jobTitle: "CEO",
        notes: "Met at conf",
        emails: [],
        phones: [],
        addresses: [
            { type: "home", street: "1 Home St" },
            { type: "work", street: "2 Work Ave" },
        ],
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ContactForm", () => {
    it("shows and saves every stored address, and edits/removes a non-first one", async () => {
        const fetchMock = mockFetch((_url, init) => jsonResponse(200, { ...contact(), ...JSON.parse(init.body as string) }));
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(<ContactForm contact={contact()} onSaved={onSaved} onCancel={vi.fn()} />);

        const streets = screen.getAllByPlaceholderText("Street");
        expect(streets).toHaveLength(2);
        expect(streets[1]).toHaveValue("2 Work Ave");

        await user.type(screen.getAllByPlaceholderText("City")[1], "Springfield");
        await user.type(screen.getAllByPlaceholderText("State/Province")[1], "IL");
        await user.type(screen.getAllByPlaceholderText("Postal code")[1], "62701");
        await user.type(screen.getAllByPlaceholderText("Country")[1], "USA");
        await user.selectOptions(screen.getByLabelText("Address type 2"), "other");
        await user.click(screen.getByRole("button", { name: "+ Add address" }));
        expect(screen.getAllByPlaceholderText("Street")).toHaveLength(3);
        await user.click(screen.getByRole("button", { name: "Remove address 3" }));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.addresses).toEqual([
            { type: "home", street: "1 Home St" },
            { type: "other", street: "2 Work Ave", city: "Springfield", state: "IL", postalCode: "62701", country: "USA" },
        ]);
    });

    it("sends null for cleared optional fields on update (and only uid/version as identity)", async () => {
        const fetchMock = mockFetch((_url, init) => jsonResponse(200, { ...contact(), ...JSON.parse(init.body as string) }));
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(<ContactForm contact={contact()} onSaved={onSaved} onCancel={vi.fn()} />);

        await user.clear(screen.getByLabelText("First name"));
        await user.clear(screen.getByLabelText("Last name"));
        await user.clear(screen.getByLabelText("Company"));
        await user.clear(screen.getByLabelText("Job title"));
        await user.clear(screen.getByLabelText("Notes"));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/contacts/c1", expect.objectContaining({ method: "PUT" }));
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body).toMatchObject({ uid: "c1", version: 3, givenName: null, surname: null, company: null, jobTitle: null, notes: null });
        expect(body.mailboxUid).toBeUndefined();
    });

    it("omits cleared optional fields on create", async () => {
        const fetchMock = mockFetch((_url, init) => jsonResponse(200, { ...contact(), ...JSON.parse(init.body as string) }));
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(<ContactForm mailboxUid="mb1" folderUid="f1" onSaved={onSaved} onCancel={vi.fn()} />);

        await user.type(screen.getByLabelText("Display name"), "New Person");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body).toMatchObject({ mailboxUid: "mb1", folderUid: "f1", displayName: "New Person", addresses: [] });
        expect("givenName" in body).toBe(false);
    });
});

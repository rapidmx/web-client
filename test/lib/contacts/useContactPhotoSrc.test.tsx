// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ContactPhotoAvatar from "../../../lib/components/avatar/ContactPhotoAvatar.js";
import { clearContactPhotoCache, useContactPhotoSrc } from "../../../lib/contacts/useContactPhotoSrc.js";
import { ApiClientContext } from "../../../lib/util/apiClientContext.js";
import type { ApiClient } from "../../../lib/util/api.js";

let counter = 0;
let fetchBlob: ReturnType<typeof vi.fn>;
let client: ApiClient;

function makeClient(): ApiClient {
    return { fetch: vi.fn(), fetchBlob, setUnauthorizedObserver: vi.fn() } as unknown as ApiClient;
}

function photoOf(uid: string, version = 1) {
    return { uid, version, photoBlobKey: `contact-photos/${uid}/x` };
}

beforeEach(() => {
    counter = 0;
    URL.createObjectURL = vi.fn(() => `blob:photo-${++counter}`);
    URL.revokeObjectURL = vi.fn();
    fetchBlob = vi.fn(async () => new Blob([new Uint8Array(2)], { type: "image/jpeg" }));
    client = makeClient();
});
afterEach(() => {
    clearContactPhotoCache();
    vi.restoreAllMocks();
});

describe("useContactPhotoSrc without an explicit client", () => {
    it("is the plain versioned URL when the contact has a picture, else nothing", () => {
        expect(renderHook(() => useContactPhotoSrc(photoOf("c1", 3))).result.current).toBe("/api/mail/contacts/c1/photo?v=3");
        expect(renderHook(() => useContactPhotoSrc({ uid: "c1", version: 3 })).result.current).toBeUndefined();
        expect(renderHook(() => useContactPhotoSrc(undefined)).result.current).toBeUndefined();
        expect(fetchBlob).not.toHaveBeenCalled();
    });
});

describe("useContactPhotoSrc with an explicit client", () => {
    it("fetches the picture through the client and shows it as a blob URL, which stays cached after unmount for the next one", async () => {
        const first = renderHook(() => useContactPhotoSrc(photoOf("c1"), client));
        expect(first.result.current).toBeUndefined();
        await waitFor(() => expect(first.result.current).toBe("blob:photo-1"));
        expect(fetchBlob).toHaveBeenCalledWith("/mail/contacts/c1/photo?v=1");
        first.unmount();
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();

        const second = renderHook(() => useContactPhotoSrc(photoOf("c1"), client));
        await waitFor(() => expect(second.result.current).toBe("blob:photo-1"));
        expect(fetchBlob).toHaveBeenCalledTimes(1);
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    });

    it("shares one fetch between avatars asking at the same time", async () => {
        const a = renderHook(() => useContactPhotoSrc(photoOf("c1"), client));
        const b = renderHook(() => useContactPhotoSrc(photoOf("c1"), client));
        await waitFor(() => expect(a.result.current).toBe("blob:photo-1"));
        await waitFor(() => expect(b.result.current).toBe("blob:photo-1"));
        expect(fetchBlob).toHaveBeenCalledTimes(1);
    });

    it("keeps one account's picture apart from another account's with the same uid", async () => {
        const other = makeClient();
        const a = renderHook(() => useContactPhotoSrc(photoOf("c1"), client));
        const b = renderHook(() => useContactPhotoSrc(photoOf("c1"), other));
        await waitFor(() => expect(a.result.current).toBe("blob:photo-1"));
        await waitFor(() => expect(b.result.current).toBe("blob:photo-2"));
        expect(fetchBlob).toHaveBeenCalledTimes(2);
    });

    it("fetches again for a new version, and shows nothing for a contact without a picture", async () => {
        const { result, rerender } = renderHook(({ contact }) => useContactPhotoSrc(contact, client), {
            initialProps: { contact: photoOf("c1", 1) as ReturnType<typeof photoOf> | { uid: string; version: number } | undefined },
        });
        await waitFor(() => expect(result.current).toBe("blob:photo-1"));
        rerender({ contact: photoOf("c1", 2) });
        await waitFor(() => expect(result.current).toBe("blob:photo-2"));
        expect(fetchBlob).toHaveBeenLastCalledWith("/mail/contacts/c1/photo?v=2");
        rerender({ contact: { uid: "c1", version: 3 } });
        expect(result.current).toBeUndefined();
        rerender({ contact: undefined });
        expect(result.current).toBeUndefined();
        expect(fetchBlob).toHaveBeenCalledTimes(2);
    });

    it("shows nothing when the picture cannot be fetched, and tries again the next time it is asked for", async () => {
        fetchBlob.mockRejectedValueOnce(new Error("offline"));
        const first = renderHook(() => useContactPhotoSrc(photoOf("c1"), client));
        await waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(first.result.current).toBeUndefined();
        first.unmount();

        const second = renderHook(() => useContactPhotoSrc(photoOf("c1"), client));
        await waitFor(() => expect(second.result.current).toBe("blob:photo-1"));
        expect(fetchBlob).toHaveBeenCalledTimes(2);
    });

    it("lets go of a picture that arrives after its avatar is gone, without leaving it counted as shown", async () => {
        let resolve!: (blob: Blob) => void;
        fetchBlob.mockImplementationOnce(() => new Promise<Blob>((r) => (resolve = r)));
        const first = renderHook(() => useContactPhotoSrc(photoOf("c1"), client));
        await waitFor(() => expect(fetchBlob).toHaveBeenCalled());
        first.unmount();
        resolve(new Blob([new Uint8Array(1)]));
        await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
        // Cached and unused: a later avatar gets it without another fetch.
        const second = renderHook(() => useContactPhotoSrc(photoOf("c1"), client));
        await waitFor(() => expect(second.result.current).toBe("blob:photo-1"));
        expect(fetchBlob).toHaveBeenCalledTimes(1);
    });

    it("revokes the oldest unused pictures beyond the limit, never one that is still shown", async () => {
        const shown = renderHook(() => useContactPhotoSrc(photoOf("keep"), client));
        await waitFor(() => expect(shown.result.current).toBe("blob:photo-1"));
        for (let i = 0; i < 50; i++) {
            const view = renderHook(() => useContactPhotoSrc(photoOf(`c${i}`), client));
            await waitFor(() => expect(view.result.current).toBe(`blob:photo-${i + 2}`), { interval: 1 });
            view.unmount();
        }
        // 51 are cached, one over the limit: the oldest unused one (c0, the second made) goes; the shown one stays.
        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:photo-2");

        shown.unmount();
        clearContactPhotoCache();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:photo-1");
    });

    it("is left alone by a second release of a picture that was cleared from the cache meanwhile", async () => {
        const view = renderHook(() => useContactPhotoSrc(photoOf("c1"), client));
        await waitFor(() => expect(view.result.current).toBe("blob:photo-1"));
        clearContactPhotoCache();
        view.unmount();
        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    });
});

describe("ContactPhotoAvatar", () => {
    it("shows the plain picture URL in the web app and a fetched blob under an explicit client, falling back to initials", async () => {
        const plain = render(<ContactPhotoAvatar displayName="Jane Doe" contact={photoOf("c1", 4)} />);
        expect(plain.container.querySelector("img")?.getAttribute("src")).toBe("/api/mail/contacts/c1/photo?v=4");
        plain.unmount();

        const { container } = render(
            <ApiClientContext.Provider value={client}>
                <ContactPhotoAvatar displayName="Jane Doe" contact={photoOf("c1", 4)} />
            </ApiClientContext.Provider>,
        );
        expect(screen.getByText("JD")).toBeInTheDocument();
        await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:photo-1"));
    });
});

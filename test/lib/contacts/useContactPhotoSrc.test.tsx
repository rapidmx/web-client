// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { act } from "react";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ContactPhotoAvatar from "../../../lib/components/avatar/ContactPhotoAvatar.js";
import { clearContactPhotoCache, useContactPhoto, useContactPhotoSrc } from "../../../lib/contacts/useContactPhotoSrc.js";
import { GRAVATAR_PREFERENCE_KEY } from "../../../lib/contacts/gravatar.js";
import { mockIntersectionObserver } from "../testUtils.js";
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

describe("useContactPhotoSrc under load", () => {
    it("is not trimmed away between being fetched and being claimed by the avatar that asked", async () => {
        // More pictures shown than the cache holds: nothing of them can be dropped, so the one still arriving is the only candidate once any is released.
        const shown = [];
        for (let i = 0; i < 51; i++) {
            const view = renderHook(() => useContactPhotoSrc(photoOf(`s${i}`), client));
            await waitFor(() => expect(view.result.current).toBeDefined(), { interval: 1 });
            shown.push(view);
        }
        const create = URL.createObjectURL as ReturnType<typeof vi.fn>;
        const url = `blob:late`;
        create.mockImplementationOnce(() => {
            // Another avatar goes away right after the new entry is stored and before the avatar that asked has claimed it.
            queueMicrotask(() => shown[0].unmount());
            return url;
        });
        const late = renderHook(() => useContactPhotoSrc(photoOf("late"), client));
        await waitFor(() => expect(late.result.current).toBe(url));
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(url);
    }, 30_000);

    it("fetches no more than four pictures at a time, the rest waiting their turn", async () => {
        const resolvers: ((blob: Blob) => void)[] = [];
        fetchBlob.mockImplementation(() => new Promise<Blob>((r) => resolvers.push(r)));
        const views = Array.from({ length: 10 }, (_, i) => renderHook(() => useContactPhotoSrc(photoOf(`q${i}`), client)));
        await waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(4));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(fetchBlob).toHaveBeenCalledTimes(4);

        resolvers[0](new Blob([new Uint8Array(1)]));
        await waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(5));
        for (let i = 1; i < 10; i++) {
            await waitFor(() => expect(resolvers.length).toBeGreaterThan(i));
            resolvers[i](new Blob([new Uint8Array(1)]));
        }
        for (const view of views) {
            await waitFor(() => expect(view.result.current).toMatch(/^blob:/));
        }
        expect(fetchBlob).toHaveBeenCalledTimes(10);
    });

    it("fetches nothing until it is asked to, and tells a picture that could not be fetched from one still on its way", async () => {
        const { result, rerender } = renderHook(({ active }) => useContactPhoto(photoOf("c1"), client, active), { initialProps: { active: false } });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(fetchBlob).not.toHaveBeenCalled();
        expect(result.current).toEqual({ src: undefined, failed: false });

        fetchBlob.mockRejectedValueOnce(new Error("offline"));
        rerender({ active: true });
        await waitFor(() => expect(result.current.failed).toBe(true));
        expect(result.current.src).toBeUndefined();

        const plain = renderHook(() => useContactPhoto(photoOf("c1")));
        expect(plain.result.current).toEqual({ src: "/api/mail/contacts/c1/photo?v=1", failed: false });
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

    describe("for a contact who has a picture of their own, under an explicit client", () => {
        const wrap = (children: React.ReactNode) => <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>;
        const GRAVATAR = /^https:\/\/gravatar\.com\/avatar\//;
        afterEach(() => {
            localStorage.clear();
            vi.unstubAllGlobals();
        });

        it("asks Gravatar nothing while the picture loads, and shows it when it arrives", async () => {
            localStorage.setItem(GRAVATAR_PREFERENCE_KEY, "on");
            vi.stubGlobal("IntersectionObserver", undefined);
            let resolve!: (blob: Blob) => void;
            fetchBlob.mockImplementationOnce(() => new Promise<Blob>((r) => (resolve = r)));
            const { container } = render(wrap(<ContactPhotoAvatar displayName="Jane Doe" contact={photoOf("c1")} email="jane@example.com" />));
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(container.querySelector("img")).toBeNull();
            resolve(new Blob([new Uint8Array(1)]));
            await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:photo-1"));
        });

        it("falls back to Gravatar only once the picture could not be fetched", async () => {
            localStorage.setItem(GRAVATAR_PREFERENCE_KEY, "on");
            vi.stubGlobal("IntersectionObserver", undefined);
            fetchBlob.mockRejectedValueOnce(new Error("offline"));
            const { container } = render(wrap(<ContactPhotoAvatar displayName="Jane Doe" contact={photoOf("c1")} email="jane@example.com" />));
            await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toMatch(GRAVATAR));
        });

        it("when lazy, fetches the picture only once the avatar scrolls into view", async () => {
            const observer = mockIntersectionObserver();
            const { container } = render(wrap(<ContactPhotoAvatar lazy displayName="Jane Doe" contact={photoOf("c1")} />));
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(fetchBlob).not.toHaveBeenCalled();
            act(() => observer.trigger());
            await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:photo-1"));
            expect(fetchBlob).toHaveBeenCalledTimes(1);
        });

        it("when lazy but nothing can tell what is on screen, fetches at once", async () => {
            vi.stubGlobal("IntersectionObserver", undefined);
            const { container } = render(wrap(<ContactPhotoAvatar lazy displayName="Jane Doe" contact={photoOf("c1")} />));
            await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:photo-1"));
        });
    });
});

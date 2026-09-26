// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import SettingsAppearancePageBase from "../../../../apps/www/settings/appearance/index.js";
import { withTestRouter } from "../../routerTestUtils.js";
import { APPEARANCE_SAVE_DELAY_MS } from "../../../../apps/shared/appearance/AppearanceProvider.js";
import { writeAppearanceCache } from "../../../../apps/shared/appearance/appearanceCache.js";
import { APPEARANCE_STYLE_ID } from "../../../../apps/shared/appearance/theme.js";
import { BACKGROUND_MAX_BYTES } from "@rapidmx/react-shared/appearance/preferencesApi.js";

// Rendered inside a router, as the app's shell does (see routerTestUtils.tsx).
const SettingsAppearancePage = withTestRouter(SettingsAppearancePageBase);

const measureImage = vi.hoisted(() => vi.fn());
vi.mock("../../../../apps/shared/appearance/photo.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../../apps/shared/appearance/photo.js")>()),
    measureImage,
}));

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "My Mail",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};

/** The Settings shell's own requests plus a fake appearance API that records what the page sends. */
function mockServer(options: { putFails?: boolean; postFails?: boolean; postDelay?: number } = {}) {
    const calls: { method: string; url: string; body?: any }[] = [];
    let version = 0;
    const fetchMock = mockFetch(async (url, init) => {
        const method = init?.method ?? "GET";
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/preferences/appearance")) {
            const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
            calls.push({ method, url, body });
            if (url.endsWith("/background") && method === "POST") {
                if (options.postDelay) await new Promise((resolve) => setTimeout(resolve, options.postDelay));
                if (options.postFails) return jsonResponse(500, { message: "The picture could not be stored." });
                version++;
                return jsonResponse(200, { version: 1, mode: "system", background: { kind: "image", imageVersion: `v${version}`, dim: 0.2, blur: 0, fit: "cover" }, updatedAt: "2026-09-21T10:00:00.000Z" });
            }
            if (url.endsWith("/background") && method === "DELETE") return jsonResponse(200, { version: 1, mode: "system", background: { kind: "none", dim: 0.2, blur: 0, fit: "cover" }, updatedAt: "2026-09-21T10:00:00.000Z" });
            if (method === "PUT") {
                if (options.putFails) return jsonResponse(500, { message: "The server is having a moment." });
                return jsonResponse(200, { version: 1, mode: body.mode ?? "system", ...(body.colors ? { colors: body.colors } : {}), ...(body.background ? { background: { dim: 0, blur: 0, fit: "cover", ...body.background } } : {}), updatedAt: "2026-09-21T10:00:01.000Z" });
            }
        }
        throw new Error(`unexpected ${method} ${url}`);
    });
    return { fetchMock, calls, puts: () => calls.filter((call) => call.method === "PUT") };
}

const style = () => document.getElementById(APPEARANCE_STYLE_ID);

beforeEach(() => {
    measureImage.mockReset();
    measureImage.mockResolvedValue(undefined);
    document.documentElement.removeAttribute("data-theme");
    style()?.remove();
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    style()?.remove();
    document.documentElement.removeAttribute("data-theme");
});

async function open() {
    render(<SettingsAppearancePage userUid="u1" />);
    return screen.findByRole("heading", { name: "Appearance" });
}

function png(name = "photo.png", size = 1000, type = "image/png") {
    const file = new File(["x"], name, { type });
    Object.defineProperty(file, "size", { value: size });
    return file;
}

/** Seeds the browser's cached copy - what the page adopts before the server answers, and the only way to start with preferences in a test that renders the page outside the router. */
function seed(prefs: Record<string, unknown>) {
    writeAppearanceCache({ version: 1, mode: "system", updatedAt: "2026-09-21T10:00:00.000Z", ...prefs } as never, "", 1, "u1");
}

describe("SettingsAppearancePage", () => {
    it("is listed right after Profile in Settings' own sidebar, and marks itself as the current page", async () => {
        mockServer();
        await open();
        const nav = screen.getByRole("navigation", { name: "Settings sections" });
        const links = within(nav).getAllByRole("link");
        expect(links[0]).toHaveTextContent("Profile");
        expect(links[1]).toHaveTextContent("Appearance");
        expect(links[1]).toHaveAttribute("aria-current", "page");
        expect(links[1]).toHaveAttribute("href", "/settings/appearance?mailboxUid=mb1");
    });

    it("starts with the system scheme, the app's own colours and no background - and nothing to reset", async () => {
        mockServer();
        await open();
        expect(screen.getByRole("radio", { name: /System/ })).toBeChecked();
        expect(screen.getByLabelText("Primary")).toHaveValue("#0d9488");
        expect(screen.getByLabelText("Accent")).toHaveValue("#a3690a");
        expect(screen.getByLabelText("Surface")).toHaveValue("#ffffff");
        expect(screen.getByLabelText("Text")).toHaveValue("#1c2526");
        expect(screen.getByRole("radio", { name: "None" })).toBeChecked();
        expect(screen.getByRole("button", { name: "Reset all" })).toBeDisabled();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("groups the choices in labelled fieldsets, and every control has a name", async () => {
        mockServer();
        await open();
        for (const name of ["Colour scheme", "Theme colours", "Background"]) {
            expect(screen.getByRole("group", { name })).toBeInTheDocument();
        }
        for (const control of [...screen.getAllByRole("radio"), ...screen.getAllByRole("textbox"), ...screen.getAllByRole("button")]) {
            expect(control).toHaveAccessibleName();
        }
    });

    describe("the colour scheme", () => {
        it("changes the app at once and saves it once in the background", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const server = mockServer();
            await act(async () => {
                render(<SettingsAppearancePage userUid="u1" />);
                await vi.advanceTimersByTimeAsync(50);
            });
            fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
            expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
            expect(screen.getByRole("radio", { name: /Dark/ })).toBeChecked();
            expect(screen.getByText("Saving…")).toBeInTheDocument();
            fireEvent.click(screen.getByRole("radio", { name: /Light/ }));
            expect(document.documentElement.getAttribute("data-theme")).toBe("light");
            expect(server.puts()).toHaveLength(0);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(APPEARANCE_SAVE_DELAY_MS + 50);
            });
            expect(server.puts().map((call) => call.body)).toEqual([{ version: 1, mode: "light" }]);
            expect(screen.queryByText("Saving…")).not.toBeInTheDocument();
        });

        it("puts the choice back and says so when the save fails, and lets the message be dismissed", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            mockServer({ putFails: true });
            await act(async () => {
                render(<SettingsAppearancePage userUid="u1" />);
                await vi.advanceTimersByTimeAsync(50);
            });
            fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(APPEARANCE_SAVE_DELAY_MS + 50);
            });
            expect(screen.getByRole("radio", { name: /System/ })).toBeChecked();
            expect(document.documentElement.getAttribute("data-theme")).not.toBe("dark");
            expect(screen.getByRole("alert")).toHaveTextContent("The server is having a moment.");
            fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
            expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        });
    });

    describe("the theme colours", () => {
        it("apply the moment a colour is typed, keep a derived scale, and can each be reset", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const server = mockServer();
            await act(async () => {
                render(<SettingsAppearancePage userUid="u1" />);
                await vi.advanceTimersByTimeAsync(50);
            });
            fireEvent.change(screen.getByLabelText("Primary"), { target: { value: "#1e3a8a" } });
            expect(style()!.textContent).toContain("--rr-color-primary:#1e3a8a !important");
            expect(style()!.textContent).toContain("--rr-color-primary-dark:");
            expect(screen.getByLabelText("Primary picker")).toHaveValue("#1e3a8a");
            fireEvent.change(screen.getByLabelText("Accent picker"), { target: { value: "#ffd60a" } });
            expect(style()!.textContent).toContain("--rr-color-accent:#ffd60a !important");
            expect(screen.getByRole("button", { name: "Reset all" })).toBeEnabled();
            await act(async () => {
                await vi.advanceTimersByTimeAsync(APPEARANCE_SAVE_DELAY_MS + 50);
            });
            expect(server.puts().map((call) => call.body)).toEqual([{ version: 1, colors: { primary: "#1e3a8a", accent: "#ffd60a" } }]);
            fireEvent.click(screen.getByRole("button", { name: "Reset primary to the default" }));
            expect(style()!.textContent).not.toContain("--rr-color-primary:");
            expect(screen.getByLabelText("Primary")).toHaveValue("#0d9488");
            await act(async () => {
                await vi.advanceTimersByTimeAsync(APPEARANCE_SAVE_DELAY_MS + 50);
            });
            expect(server.puts()[1].body).toEqual({ version: 1, colors: { primary: null } });
        });

        it("show the colours the user chose, and take a typed one only once it is a colour", async () => {
            seed({ colors: { surface: "#101418", text: "#eeeeee" } });
            mockServer();
            const user = userEvent.setup();
            await open();
            await waitFor(() => expect(screen.getByLabelText("Surface")).toHaveValue("#101418"));
            expect(screen.getByLabelText("Text")).toHaveValue("#eeeeee");
            const surface = screen.getByLabelText("Surface");
            await user.clear(surface);
            await user.type(surface, "#2");
            expect(screen.getByRole("alert")).toHaveTextContent("Use a colour like #1a2b3c.");
            expect(style()!.textContent).toContain("--rr-color-surface:#101418");
        });

        it("warn - without blocking - when text on the surface, or text on an accent button, is under 4.5:1", async () => {
            mockServer();
            await open();
            fireEvent.change(screen.getByLabelText("Text"), { target: { value: "#f0f0f0" } });
            const warning = screen.getByText(/Text on the surface colour has a contrast of 1\.1:1/);
            expect(warning).toHaveAttribute("role", "status");
            expect(warning).toHaveClass("text-warning-contrast");
            fireEvent.change(screen.getByLabelText("Accent"), { target: { value: "#808080" } });
            expect(screen.getByText(/Text on buttons in the accent colour has a contrast of/)).toBeInTheDocument();
            // Nothing is blocked: the colour is applied all the same.
            expect(style()!.textContent).toContain("--rr-color-text:#f0f0f0 !important");
            fireEvent.change(screen.getByLabelText("Text"), { target: { value: "#111111" } });
            expect(screen.queryByText(/Text on the surface colour/)).not.toBeInTheDocument();
        });
    });

    describe("the background", () => {
        it("chooses no background, a colour, or an image, and shows only what belongs to the choice", async () => {
            mockServer();
            await open();
            expect(screen.queryByLabelText("Background colour")).not.toBeInTheDocument();
            expect(screen.queryByRole("group", { name: "Background image" })).not.toBeInTheDocument();
            fireEvent.click(screen.getByRole("radio", { name: "Colour" }));
            expect(screen.getByLabelText("Background colour")).toHaveValue("#dbe4ee");
            expect(style()!.textContent).toContain("html::before");
            expect(style()!.textContent).toContain("background-color:#dbe4ee");
            fireEvent.change(screen.getByLabelText("Background colour"), { target: { value: "#336699" } });
            expect(style()!.textContent).toContain("background-color:#336699");
            expect(screen.queryByLabelText(/^Dim/)).not.toBeInTheDocument();
            fireEvent.click(screen.getByRole("radio", { name: "Image" }));
            expect(screen.getByRole("group", { name: "Background image" })).toBeInTheDocument();
            // Choosing "Image" before there is one changes nothing yet.
            expect(style()!.textContent).toContain("background-color:#336699");
            fireEvent.click(screen.getByRole("radio", { name: "None" }));
            expect(style()).toBeNull();
        });

        it("starts the colour choice from a dark colour in the dark scheme", async () => {
            mockServer();
            await open();
            fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
            fireEvent.click(screen.getByRole("radio", { name: "Colour" }));
            expect(screen.getByLabelText("Background colour")).toHaveValue("#1e293b");
        });

        it("uploads a chosen picture: shown at once from a local preview, stored, and given the controls that belong to a picture", async () => {
            const server = mockServer();
            const user = userEvent.setup();
            await open();
            fireEvent.click(screen.getByRole("radio", { name: "Image" }));
            const input = screen.getByLabelText("Choose a background image");
            await user.upload(input, png());
            await waitFor(() => expect(server.calls.some((call) => call.method === "POST")).toBe(true));
            const post = server.calls.find((call) => call.method === "POST")!;
            expect(post.url).toBe("/api/mail/preferences/appearance/background");
            expect((post.body as File).name).toBe("photo.png");
            await waitFor(() => expect(screen.getByRole("img", { name: "Your background image" })).toBeInTheDocument());
            expect(style()!.textContent).toContain("html::before");
            expect(screen.getByLabelText(/^Dim/)).toHaveValue("20");
            expect(screen.getByLabelText(/^Blur/)).toHaveValue("0");
            expect(screen.getByLabelText("Fit")).toHaveValue("cover");
            expect(screen.getByRole("radio", { name: "Image" })).toBeChecked();
            expect(await screen.findByText("Replace the image")).toBeInTheDocument();
        });

        it("takes a picture dropped on it, and shows the drop target while one is dragged over", async () => {
            const server = mockServer({ postDelay: 150 });
            await open();
            fireEvent.click(screen.getByRole("radio", { name: "Image" }));
            const zone = screen.getByRole("group", { name: "Background image" });
            expect(zone).not.toHaveClass("bg-primary/10");
            fireEvent.dragEnter(zone);
            expect(zone).toHaveClass("border-primary");
            fireEvent.dragLeave(zone);
            expect(zone).not.toHaveClass("border-primary");
            fireEvent.dragOver(zone);
            expect(zone).toHaveClass("border-primary");
            const file = png("dropped.png");
            fireEvent.drop(zone, { dataTransfer: { files: [file] } });
            expect(zone).not.toHaveClass("border-primary");
            await waitFor(() => expect(server.calls.some((call) => call.method === "POST")).toBe(true));
            expect(screen.getByText("Uploading dropped.png…")).toBeInTheDocument();
            await waitFor(() => expect(screen.queryByText("Uploading dropped.png…")).not.toBeInTheDocument());
        });

        it("does nothing for a drop that carries no file", async () => {
            const server = mockServer();
            await open();
            fireEvent.click(screen.getByRole("radio", { name: "Image" }));
            fireEvent.drop(screen.getByRole("group", { name: "Background image" }), { dataTransfer: { files: [] } });
            expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(0);
            expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        });

        it("says why before uploading anything: the wrong type, too big, or empty", async () => {
            const server = mockServer();
            await open();
            fireEvent.click(screen.getByRole("radio", { name: "Image" }));
            const zone = screen.getByRole("group", { name: "Background image" });
            fireEvent.drop(zone, { dataTransfer: { files: [png("x.gif", 100, "image/gif")] } });
            expect(screen.getByRole("alert")).toHaveTextContent("Choose a PNG, JPEG, WebP or AVIF image.");
            fireEvent.drop(zone, { dataTransfer: { files: [png("big.png", BACKGROUND_MAX_BYTES + 1)] } });
            expect(screen.getByRole("alert")).toHaveTextContent("That image is 8.0 MB; the limit is 8 MB.");
            fireEvent.drop(zone, { dataTransfer: { files: [png("empty.png", 0)] } });
            expect(screen.getByRole("alert")).toHaveTextContent("That file is empty.");
            fireEvent.drop(zone, { dataTransfer: { files: [png("svg.svg", 10, "image/svg+xml")] } });
            expect(screen.getByRole("alert")).toHaveTextContent("Choose a PNG, JPEG, WebP or AVIF image.");
            expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(0);
            // A good file after a bad one clears the message.
            fireEvent.drop(zone, { dataTransfer: { files: [png()] } });
            expect(screen.queryByRole("alert")).not.toBeInTheDocument();
            await waitFor(() => expect(server.calls.some((call) => call.method === "POST")).toBe(true));
        });

        it("offers the file chooser only the four raster types", async () => {
            mockServer();
            await open();
            fireEvent.click(screen.getByRole("radio", { name: "Image" }));
            expect(screen.getByLabelText("Choose a background image")).toHaveAttribute("accept", "image/png,image/jpeg,image/webp,image/avif");
            const clicked = vi.spyOn(HTMLInputElement.prototype, "click");
            fireEvent.click(screen.getByRole("button", { name: "Choose image" }));
            expect(clicked).toHaveBeenCalled();
            clicked.mockRestore();
        });

        it("puts the previous state back and says so when the upload fails", async () => {
            mockServer({ postFails: true });
            const user = userEvent.setup();
            await open();
            fireEvent.click(screen.getByRole("radio", { name: "Image" }));
            await user.upload(screen.getByLabelText("Choose a background image"), png());
            await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The picture could not be stored."));
            expect(style()).toBeNull();
            expect(screen.queryByRole("img", { name: "Your background image" })).not.toBeInTheDocument();
        });

        it("changes dim, blur and fit as they are dragged, saving only what changed", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            seed({ background: { kind: "image", imageVersion: "v9", dim: 0.2, blur: 0, fit: "cover" } });
            const server = mockServer();
            await act(async () => {
                render(<SettingsAppearancePage userUid="u1" />);
                await vi.advanceTimersByTimeAsync(50);
            });
            expect(screen.getByLabelText(/^Dim/)).toHaveValue("20");
            fireEvent.change(screen.getByLabelText(/^Dim/), { target: { value: "50" } });
            fireEvent.change(screen.getByLabelText(/^Dim/), { target: { value: "60" } });
            fireEvent.change(screen.getByLabelText(/^Blur/), { target: { value: "12" } });
            fireEvent.change(screen.getByLabelText("Fit"), { target: { value: "tile" } });
            expect(screen.getByText("60%")).toBeInTheDocument();
            expect(screen.getByText("12 px")).toBeInTheDocument();
            expect(screen.getByLabelText(/^Dim/)).toHaveAttribute("aria-valuetext", "60 percent");
            expect(screen.getByLabelText(/^Blur/)).toHaveAttribute("aria-valuetext", "12 pixels");
            // The page itself follows.
            expect(style()!.textContent).toContain("filter:blur(12px)");
            expect(style()!.textContent).toContain("opacity:0.6");
            expect(style()!.textContent).toContain("background-repeat:repeat");
            expect(server.puts()).toHaveLength(0);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(APPEARANCE_SAVE_DELAY_MS + 50);
            });
            expect(server.puts()).toHaveLength(1);
            expect(server.puts()[0].body.background).toMatchObject({ dim: 0.6, blur: 12, fit: "tile" });
        });

        it("has the slider limits: dim to 80%, blur to 20 px", async () => {
            seed({ background: { kind: "image", imageVersion: "v9", dim: 0.2, blur: 0, fit: "cover" } });
            mockServer();
            await open();
            await waitFor(() => expect(screen.getByLabelText(/^Dim/)).toBeInTheDocument());
            expect(screen.getByLabelText(/^Dim/)).toHaveAttribute("max", "80");
            expect(screen.getByLabelText(/^Dim/)).toHaveAttribute("min", "0");
            expect(screen.getByLabelText(/^Blur/)).toHaveAttribute("max", "20");
        });

        it("goes back to a kept picture when Image is chosen again, and removes the picture on request", async () => {
            const server = mockServer();
            const user = userEvent.setup();
            seed({ background: { kind: "image", imageVersion: "v9", dim: 0.2, blur: 0, fit: "cover" } });
            await open();
            await waitFor(() => expect(screen.getByRole("radio", { name: "Image" })).toBeChecked());
            fireEvent.click(screen.getByRole("radio", { name: "None" }));
            expect(style()).toBeNull();
            fireEvent.click(screen.getByRole("radio", { name: "Image" }));
            expect(style()!.textContent).toContain("background/v9");
            await user.click(screen.getByRole("button", { name: "Remove" }));
            await waitFor(() => expect(server.calls.some((call) => call.method === "DELETE")).toBe(true));
            expect(style()).toBeNull();
            expect(screen.queryByRole("img", { name: "Your background image" })).not.toBeInTheDocument();
            expect(screen.getByRole("radio", { name: "None" })).toBeChecked();
        });

        it("clears an upload message when the picture is removed", async () => {
            mockServer();
            seed({ background: { kind: "image", imageVersion: "v9", dim: 0.2, blur: 0, fit: "cover" } });
            await open();
            await waitFor(() => expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument());
            fireEvent.drop(screen.getByRole("group", { name: "Background image" }), { dataTransfer: { files: [png("x.gif", 1, "image/gif")] } });
            expect(screen.getByRole("alert")).toBeInTheDocument();
            fireEvent.click(screen.getByRole("button", { name: "Remove" }));
            await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
        });
    });

    describe("Reset all", () => {
        it("puts everything back at once: the scheme, the colours and the background", async () => {
            const server = mockServer();
            seed({ mode: "dark", colors: { primary: "#1e3a8a" }, background: { kind: "color", color: "#336699", dim: 0, blur: 0, fit: "cover" } });
            const user = userEvent.setup();
            await open();
            await waitFor(() => expect(screen.getByRole("radio", { name: /Dark/ })).toBeChecked());
            expect(screen.getByRole("button", { name: "Reset all" })).toBeEnabled();
            await user.click(screen.getByRole("button", { name: "Reset all" }));
            expect(screen.getByRole("radio", { name: /System/ })).toBeChecked();
            expect(screen.getByRole("radio", { name: "None" })).toBeChecked();
            expect(screen.getByLabelText("Primary")).toHaveValue("#0d9488");
            expect(style()).toBeNull();
            expect(screen.getByRole("button", { name: "Reset all" })).toBeDisabled();
            await waitFor(() => expect(server.puts()).toHaveLength(0));
        });
    });

    it("reads the tokens the page has now for the colours the user hasn't chosen (a deployment's branding may set them)", async () => {
        document.documentElement.style.setProperty("--rr-color-primary", "#123456");
        mockServer();
        await open();
        await waitFor(() => expect(screen.getByLabelText("Primary")).toHaveValue("#123456"));
        document.documentElement.style.removeProperty("--rr-color-primary");
    });
});

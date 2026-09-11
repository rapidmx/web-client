// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import BrandingPage from "../../../../apps/admin/branding/index.js";

const BRANDING = {
    companyName: "Acme",
    title: "Acme Mail",
};

afterEach(() => {
    vi.unstubAllGlobals();
});

function mockAdminFetch(handlers: (url: string, init: RequestInit) => Response | Promise<Response> | undefined) {
    return mockFetch((url, init) => {
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        const result = handlers(url, init);
        if (result) return result;
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

describe("BrandingPage", () => {
    it("shows a loading state, then the form once branding has loaded", async () => {
        mockAdminFetch((url) => {
            if (url === "/api/mail/branding") return jsonResponse(200, BRANDING);
        });
        render(<BrandingPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        expect(await screen.findByLabelText("Company name")).toHaveValue("Acme");
        expect(screen.getByLabelText("Product title")).toHaveValue("Acme Mail");
    });

    it("shows an error instead of the form when loading branding fails", async () => {
        mockAdminFetch((url) => {
            if (url === "/api/mail/branding") return jsonResponse(500, { message: "boom" });
        });
        render(<BrandingPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when the load failure is not an ApiRequestError", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/branding") return Promise.reject(new Error("network down"));
            throw new Error(`unexpected ${url}`);
        });
        render(<BrandingPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        expect(await screen.findByText("Could not load branding.")).toBeInTheDocument();
    });

    it("saves company name, title, and header/footer HTML", async () => {
        const user = userEvent.setup();
        mockAdminFetch((url, init) => {
            if (url === "/api/mail/branding" && (!init || init.method === undefined)) return jsonResponse(200, BRANDING);
            if (url === "/api/mail/branding" && init.method === "PUT") {
                const body = JSON.parse(init.body as string);
                return jsonResponse(200, { ...BRANDING, ...body });
            }
        });
        render(<BrandingPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByLabelText("Company name");

        await user.clear(screen.getByLabelText("Company name"));
        await user.type(screen.getByLabelText("Company name"), "New Co");
        await user.type(screen.getByLabelText("Product title"), " Extra");
        await user.type(screen.getByLabelText("Header HTML"), "<b>hi</b>");
        await user.type(screen.getByLabelText("Footer HTML"), "<i>bye</i>");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Saved.")).toBeInTheDocument();
    });

    it("shows an error when saving fails", async () => {
        const user = userEvent.setup();
        mockAdminFetch((url, init) => {
            if (url === "/api/mail/branding" && (!init.method || init.method === undefined)) return jsonResponse(200, BRANDING);
            if (url === "/api/mail/branding" && init.method === "PUT") return jsonResponse(400, { message: "bad title" });
        });
        render(<BrandingPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByLabelText("Company name");

        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("bad title")).toBeInTheDocument();
    });

    it("shows a generic error message when saving fails with a non-ApiRequestError", async () => {
        const user = userEvent.setup();
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/branding" && (!init.method || init.method === "GET")) return jsonResponse(200, BRANDING);
            if (url === "/api/mail/branding" && init.method === "PUT") return Promise.reject(new Error("offline"));
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        render(<BrandingPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByLabelText("Company name");

        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Could not save branding.")).toBeInTheDocument();
    });

    it("uploads a logo file and shows the updated preview, then removes it", async () => {
        const user = userEvent.setup();
        mockAdminFetch((url, init) => {
            if (url === "/api/mail/branding" && (!init.method || init.method === "GET")) return jsonResponse(200, BRANDING);
            if (url === "/api/mail/branding/logo" && init.method === "POST") {
                return jsonResponse(200, { ...BRANDING, logoUrl: "/api/mail/branding/logo" });
            }
            if (url === "/api/mail/branding/logo" && init.method === "DELETE") return new Response(null, { status: 204 });
        });
        render(<BrandingPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByLabelText("Company name");

        await user.click(screen.getByRole("button", { name: "Upload logo" }));
        const file = new File(["png"], "logo.png", { type: "image/png" });
        await user.upload(screen.getByLabelText("Upload logo"), file);
        expect(await screen.findByRole("button", { name: "Remove logo" })).toBeInTheDocument();
        expect(screen.getByAltText("Current logo")).toHaveAttribute("src", "/api/mail/branding/logo");

        await user.click(screen.getByRole("button", { name: "Remove logo" }));
        expect(screen.queryByRole("button", { name: "Remove logo" })).not.toBeInTheDocument();
    });

    it("rejects an oversized logo file client-side without ever calling the upload endpoint", async () => {
        const user = userEvent.setup();
        mockAdminFetch((url) => {
            if (url === "/api/mail/branding") return jsonResponse(200, BRANDING);
        });
        render(<BrandingPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByLabelText("Company name");

        const bigFile = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" });
        await user.upload(screen.getByLabelText("Upload logo"), bigFile);

        expect(await screen.findByText('"huge.png" is too large — logos must be 5MB or smaller.')).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Remove logo" })).not.toBeInTheDocument();
    });

    it("rejects an oversized stylesheet file client-side without ever calling the upload endpoint", async () => {
        const user = userEvent.setup();
        mockAdminFetch((url) => {
            if (url === "/api/mail/branding") return jsonResponse(200, BRANDING);
        });
        render(<BrandingPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByLabelText("Company name");

        const bigFile = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "huge.css", { type: "text/css" });
        await user.upload(screen.getByLabelText("Upload stylesheet"), bigFile);

        expect(
            await screen.findByText('"huge.css" is too large — stylesheets must be 5MB or smaller.'),
        ).toBeInTheDocument();
        expect(screen.getByText("None configured")).toBeInTheDocument();
    });

    it("shows an error and does not select a file when the picker is dismissed with none chosen", async () => {
        mockAdminFetch((url) => {
            if (url === "/api/mail/branding") return jsonResponse(200, BRANDING);
        });
        render(<BrandingPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByLabelText("Company name");

        fireEvent.change(screen.getByLabelText("Upload logo"), { target: { files: [] } });
        fireEvent.change(screen.getByLabelText("Upload stylesheet"), { target: { files: [] } });

        expect(screen.queryByRole("button", { name: "Remove logo" })).not.toBeInTheDocument();
        expect(screen.getByText("None configured")).toBeInTheDocument();
    });

    it("sets an external logo URL, disabling Set until the value changes", async () => {
        const user = userEvent.setup();
        mockAdminFetch((url, init) => {
            if (url === "/api/mail/branding" && (!init.method || init.method === "GET")) return jsonResponse(200, BRANDING);
            if (url === "/api/mail/branding" && init.method === "PUT") {
                const body = JSON.parse(init.body as string);
                return jsonResponse(200, { ...BRANDING, ...body });
            }
        });
        render(<BrandingPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByLabelText("Company name");

        const setButtons = screen.getAllByRole("button", { name: "Set" });
        const logoSetButton = setButtons[0];
        expect(logoSetButton).toBeDisabled();

        await user.type(screen.getByLabelText("Logo URL"), "https://cdn.example.com/l.png");
        expect(logoSetButton).not.toBeDisabled();
        await user.click(logoSetButton);

        expect(await screen.findByAltText("Current logo")).toHaveAttribute("src", "https://cdn.example.com/l.png");
    });

    it("uploads a stylesheet file, shows its URL, and removes it", async () => {
        const user = userEvent.setup();
        mockAdminFetch((url, init) => {
            if (url === "/api/mail/branding" && (!init.method || init.method === "GET")) return jsonResponse(200, BRANDING);
            if (url === "/api/mail/branding/stylesheet" && init.method === "POST") {
                return jsonResponse(200, { ...BRANDING, stylesheetUrl: "/api/mail/branding/stylesheet" });
            }
            if (url === "/api/mail/branding/stylesheet" && init.method === "DELETE") return new Response(null, { status: 204 });
        });
        render(<BrandingPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByLabelText("Company name");

        await user.click(screen.getByRole("button", { name: "Upload CSS file" }));
        const file = new File(["body{}"], "theme.css", { type: "text/css" });
        await user.upload(screen.getByLabelText("Upload stylesheet"), file);
        expect(await screen.findByText("/api/mail/branding/stylesheet")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Remove stylesheet" }));
        expect(screen.getByText("None configured")).toBeInTheDocument();
    });

    it("sets an external stylesheet URL", async () => {
        const user = userEvent.setup();
        mockAdminFetch((url, init) => {
            if (url === "/api/mail/branding" && (!init.method || init.method === "GET")) return jsonResponse(200, BRANDING);
            if (url === "/api/mail/branding" && init.method === "PUT") {
                const body = JSON.parse(init.body as string);
                return jsonResponse(200, { ...BRANDING, ...body });
            }
        });
        render(<BrandingPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByLabelText("Company name");

        await user.type(screen.getByLabelText("Stylesheet URL"), "https://cdn.example.com/theme.css");
        const setButtons = screen.getAllByRole("button", { name: "Set" });
        await user.click(setButtons[setButtons.length - 1]);

        expect(await screen.findByText("https://cdn.example.com/theme.css")).toBeInTheDocument();
    });

    it("shows an error when an asset action fails", async () => {
        const user = userEvent.setup();
        mockAdminFetch((url, init) => {
            if (url === "/api/mail/branding" && (!init.method || init.method === "GET")) return jsonResponse(200, BRANDING);
            if (url === "/api/mail/branding/logo" && init.method === "POST") return jsonResponse(400, { message: "too big" });
        });
        render(<BrandingPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByLabelText("Company name");

        const file = new File(["png"], "logo.png", { type: "image/png" });
        await user.upload(screen.getByLabelText("Upload logo"), file);

        expect(await screen.findByText("too big")).toBeInTheDocument();
    });

    it("shows a generic error message when an asset action fails with a non-ApiRequestError", async () => {
        const user = userEvent.setup();
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/branding" && (!init.method || init.method === "GET")) return jsonResponse(200, BRANDING);
            if (url === "/api/mail/branding/logo" && init.method === "POST") return Promise.reject(new Error("offline"));
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        render(<BrandingPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByLabelText("Company name");

        const file = new File(["png"], "logo.png", { type: "image/png" });
        await user.upload(screen.getByLabelText("Upload logo"), file);

        expect(await screen.findByText("Could not update branding.")).toBeInTheDocument();
    });
});

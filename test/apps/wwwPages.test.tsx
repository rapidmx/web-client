// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// What `@rapidrest/react` needs of the files under `apps/www` to run the webmail as one client-routed app: every page is a plain component
// with a `title` export (the tab's title, rendered by the server and set again by the router), and nothing in the directory is a second router.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { activeAppOf } from "../../apps/www/_shell.js";
import { pageFiles, templateOf, wwwPagesDir } from "./wwwPageFiles.js";

const pagesDir = wwwPagesDir;
const files = pageFiles();
const branding = { title: "Acme Mail", companyName: "Acme" };

/** The name each app's pages give the tab. */
const LABELS: Record<string, string> = { mail: "Mail", calendar: "Calendar", contacts: "Contacts", tasks: "Tasks", settings: "Settings" };

describe("the pages under apps/www", () => {
    it("include every page the webmail has, and the app shell is not one of them", () => {
        expect(files).toContain("index.tsx");
        expect(files).toContain("messages/[uid].tsx");
        expect(files).toContain("settings/filters/[uid].tsx");
        expect(fs.existsSync(path.join(pagesDir, "_shell.tsx"))).toBe(true);
        expect(files.some((file) => path.basename(file).startsWith("_"))).toBe(false);
    });

    it("are each a component with a title export that names the brand and the app the page belongs to", async () => {
        for (const file of files) {
            const module = await import(/* @vite-ignore */ path.join(pagesDir, file));
            expect(typeof module.default, file).toBe("function");
            expect(typeof module.title, file).toBe("function");
            const app = activeAppOf(templateOf(file));
            expect(module.title({ branding }), file).toBe(`Acme Mail: ${LABELS[app]}`);
            expect(module.title({}), file).toBe(`RapidMX: ${LABELS[app]}`);
        }
    }, 120_000);

    it("are not wrapped in a router of their own any more", () => {
        for (const file of files) {
            const source = fs.readFileSync(path.join(pagesDir, file), "utf8");
            expect(source, file).not.toMatch(/routedPage|AppRouter/);
        }
    });
});

describe("activeAppOf", () => {
    it("names the rail entry a route highlights: the app of its first segment, and Mail for everything else", () => {
        expect(activeAppOf("/")).toBe("mail");
        expect(activeAppOf("/messages/:uid")).toBe("mail");
        expect(activeAppOf("/calendar")).toBe("calendar");
        expect(activeAppOf("/contacts")).toBe("contacts");
        expect(activeAppOf("/contacts/:uid")).toBe("contacts");
        expect(activeAppOf("/tasks")).toBe("tasks");
        expect(activeAppOf("/settings/privacy")).toBe("settings");
        expect(activeAppOf("/settings/filters/:uid")).toBe("settings");
        expect(activeAppOf("/settingsx")).toBe("mail");
        expect(activeAppOf("")).toBe("mail");
    });

    it("agrees, for every page, with the shell the page renders around itself (which is what used to say which rail entry to highlight)", () => {
        const SHELL_APP: Record<string, string> = { MailShell: "mail", CalendarShell: "calendar", ContactsShell: "contacts", TasksShell: "tasks", SettingsShell: "settings" };
        for (const file of files) {
            const source = fs.readFileSync(path.join(pagesDir, file), "utf8");
            const shell = /import (\w+Shell)\b/.exec(source)?.[1];
            expect(shell && SHELL_APP[shell], file).toBeTruthy();
            expect(activeAppOf(templateOf(file)), file).toBe(SHELL_APP[shell!]);
        }
    });
});

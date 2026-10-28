// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Forced onto the plain `node` environment, so `window` is genuinely undefined here, the way it is under real SSR.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import IntegrationsPage from "../../../../apps/admin/integrations/index.js";
import GiphyPage from "../../../../apps/admin/integrations/giphy/index.js";
import StunPage from "../../../../apps/admin/integrations/stun/index.js";
import SigningCaPage from "../../../../apps/admin/integrations/signing-ca/index.js";
import DnsResolverPage from "../../../../apps/admin/integrations/dns-resolver/index.js";
import PluginRegistryPage from "../../../../apps/admin/integrations/plugin-registry/index.js";
import DnsProvidersPage from "../../../../apps/admin/integrations/dns-providers/index.js";
import NewDnsProviderPage from "../../../../apps/admin/integrations/dns-providers/new/index.js";
import DnsProviderPage from "../../../../apps/admin/integrations/dns-providers/[uid].js";

describe("Integrations pages SSR guard (no window)", () => {
    it("render without throwing when there is no window global", () => {
        expect(typeof window).toBe("undefined");
        for (const Page of [IntegrationsPage, GiphyPage, StunPage, SigningCaPage, DnsResolverPage, PluginRegistryPage, DnsProvidersPage]) {
            expect(() => renderToStaticMarkup(<Page userUid="admin-1" />)).not.toThrow();
        }
        expect(() => renderToStaticMarkup(<NewDnsProviderPage userUid="admin-1" />)).not.toThrow();
        expect(() => renderToStaticMarkup(<DnsProviderPage userUid="admin-1" params={{ uid: "cloudflare-ab12cd34" }} />)).not.toThrow();
    });
});

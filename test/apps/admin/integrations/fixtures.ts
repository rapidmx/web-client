///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// What `GET /api/system/integrations` and `GET /api/system/dns-providers/types` answer (restapi `integrationSettingsView()` and `listDnsProviderTypes()`),
// and a fetch mock that serves the admin shell's own checks around them.
import { jsonResponse, mockFetch } from "../../testUtils.js";

const MASK = { secret: true } as const;
export { MASK };

type Source = "admin" | "deployment";

/** One section's view where every field comes from the deployment, with `values` equal to `defaults`. */
function deploymentSection<V extends Record<string, unknown>>(defaults: V) {
    return {
        values: { ...defaults } as Record<string, unknown>,
        defaults: { ...defaults } as Record<string, unknown>,
        source: Object.fromEntries(Object.keys(defaults).map((key) => [key, "deployment"])) as Record<string, Source>,
    };
}

/** The view of a deployment where the administrator has set nothing yet. */
export function integrationsView() {
    return {
        giphy: deploymentSection({ enabled: true, apiKey: null }),
        stun: deploymentSection({ urls: null }),
        signingCa: deploymentSection({
            backend: "manual",
            directoryUrl: "https://acme.example.org/directory",
            contactEmail: null,
        }),
        dnsResolver: deploymentSection({ mode: "node", dohEndpoint: "https://cloudflare-dns.com/dns-query" }),
        pluginRegistry: deploymentSection({
            url: "https://registry.npmjs.org/",
            token: null,
            namespaces: [{ name: "@rapidmx" }],
        }),
        version: 3,
    };
}

export type IntegrationsView = ReturnType<typeof integrationsView>;

/** Sets `field` of `section` to `value` as the administrator's (`source: "admin"`). */
export function setByAdmin(view: IntegrationsView, section: Exclude<keyof IntegrationsView, "version">, field: string, value: unknown): IntegrationsView {
    view[section].values[field] = value;
    view[section].source[field] = "admin";
    return view;
}

/** A fetch mock answering the admin shell's checks, `GET /api/system/integrations` with `view` (a function: called each time) and each section's PUT
 * with `put`. Every PUT body is recorded in the returned `puts`. */
export function mockIntegrations(view: IntegrationsView | (() => Response), put?: (section: string, body: any) => Response) {
    const puts: { section: string; body: any }[] = [];
    const fetchMock = mockFetch((url, init) => {
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        if (url === "/api/system/setup") return jsonResponse(200, { required: false });
        const section = /^\/api\/system\/integrations\/(\w+)$/.exec(url)?.[1];
        if (section && init?.method === "PUT") {
            const body = JSON.parse(init.body as string);
            puts.push({ section, body });
            return put ? put(section, body) : jsonResponse(200, typeof view === "function" ? {} : view);
        }
        if (url === "/api/system/integrations") return typeof view === "function" ? view() : jsonResponse(200, view);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
    return { fetchMock, puts };
}

/** The provider types the console builds its form from, as restapi's registry describes them. */
export const providerTypes = [
    {
        type: "cloudflare",
        label: "Cloudflare",
        externalDnsProvider: "cloudflare",
        tested: true,
        options: [
            {
                key: "zoneIds",
                label: "Zone IDs",
                kind: "string-list",
                required: true,
                maxItems: 50,
                description: "The Cloudflare zone ID of each zone, in the same order as the zones.",
                format: "a 32-character hexadecimal Cloudflare zone ID",
            },
        ],
        secretFields: [
            {
                key: "apiToken",
                label: "API token",
                required: true,
                description: "A token with Zone:Zone:Read and Zone:DNS:Edit on these zones.",
            },
        ],
        unsupportedRecordKinds: [],
        notes: ["If the token is restricted to client IP addresses, list every address the cluster reaches the internet from, IPv4 and IPv6."],
    },
    {
        type: "route53",
        label: "Amazon Route 53",
        externalDnsProvider: "aws",
        tested: false,
        options: [
            {
                key: "region",
                label: "Region",
                kind: "string",
                required: true,
                description: "The AWS region the API is called in, such as us-east-1.",
            },
            {
                key: "zoneType",
                label: "Zone type",
                kind: "enum",
                required: false,
                default: "public",
                values: ["public", "private"],
                description: "Which hosted zones to publish in.",
            },
            {
                key: "assumeRoleArn",
                label: "Role to assume",
                kind: "string",
                required: false,
                description: "An IAM role ARN to assume for every call.",
            },
        ],
        secretFields: [
            { key: "accessKeyId", label: "Access key ID", required: false, description: "Set both keys, or neither." },
            {
                key: "secretAccessKey",
                label: "Secret access key",
                required: false,
                description: "Set both keys, or neither.",
            },
        ],
        unsupportedRecordKinds: [],
        notes: [],
    },
    {
        type: "rfc2136",
        label: "RFC 2136 (BIND and other DNS servers)",
        externalDnsProvider: "rfc2136",
        tested: false,
        options: [
            {
                key: "hosts",
                label: "Servers",
                kind: "string-list",
                required: true,
                maxItems: 10,
                description: "The DNS servers that accept dynamic updates.",
            },
            {
                key: "port",
                label: "Port",
                kind: "integer",
                required: false,
                default: 53,
                min: 1,
                max: 65535,
                description: "The servers' DNS port.",
            },
            {
                key: "zone",
                label: "Zone",
                kind: "string",
                required: true,
                description: "The zone updates are sent for.",
            },
            {
                key: "tsigAlgorithm",
                label: "TSIG algorithm",
                kind: "enum",
                required: false,
                default: "hmac-sha256",
                values: ["hmac-sha1", "hmac-sha256"],
                description: "The algorithm of that key.",
            },
            {
                key: "insecure",
                label: "Unsigned updates",
                kind: "boolean",
                required: false,
                default: false,
                description: "Send updates without TSIG.",
            },
        ],
        secretFields: [{ key: "tsigSecret", label: "TSIG secret", required: false, description: "The TSIG key's secret, base64." }],
        unsupportedRecordKinds: ["MX", "SRV"],
        notes: ["MX and SRV records can't be managed through RFC 2136 zone transfers; they stay manual."],
    },
    {
        type: "google",
        label: "Google Cloud DNS",
        externalDnsProvider: "google",
        tested: false,
        options: [
            {
                key: "project",
                label: "Project ID",
                kind: "string",
                required: true,
                description: "The Google Cloud project that holds the zones.",
            },
            // Not in restapi's registry: a choice without a default, which the form offers as "not set".
            {
                key: "visibility",
                label: "Visibility",
                kind: "enum",
                required: false,
                values: ["public", "private"],
                description: "Which zones.",
            },
        ],
        secretFields: [
            {
                key: "serviceAccountJson",
                label: "Service account key (JSON)",
                required: true,
                multiLine: true,
                description: "The JSON key file of a service account.",
            },
        ],
        unsupportedRecordKinds: [],
        notes: [],
    },
];

export const cloudflareProvider = {
    uid: "cloudflare-ab12cd34",
    name: "Cloudflare",
    type: "cloudflare",
    zones: ["example.com", "example.org"],
    options: { zoneIds: ["0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"] },
    credentials: { apiToken: MASK },
    origin: "console",
    enabled: true,
    allowTakeover: false,
    status: { readyReplicas: 1, reportedAt: "2026-10-27T10:00:00.000Z", lastSyncAt: "2026-10-27T09:59:00.000Z" },
    domainCount: 2,
    version: 4,
};

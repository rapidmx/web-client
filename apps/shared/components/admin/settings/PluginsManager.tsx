///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    addPlugin,
    getPluginStatus,
    getPluginUpdates,
    listPluginNamespaces,
    listPlugins,
    lookupPluginPackage,
    planPluginChange,
    Plugin,
    PluginChangePlan,
    PluginInstanceStatus,
    PluginNamespace,
    PluginRegistryLookup,
    PluginSearchResult,
    PluginSettingDefinition,
    PluginSettingValue,
    PluginStatus,
    PluginUpdateInfo,
    removePlugin,
    searchPlugins,
    updatePlugin,
} from "@rapidmx/react-shared/admin/pluginsApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

const INPUT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

/** How often status is refreshed while server copies are still applying a change. */
const PENDING_POLL_MS = 5000;

function errorMessage(err: unknown, fallback: string): string {
    return err instanceof ApiRequestError ? err.message : fallback;
}

/** A change waiting for the administrator to confirm the other plugins it also installs or enables. */
interface PendingChange {
    displayName: string;
    plan: PluginChangePlan;
    apply: (plan: PluginChangePlan) => Promise<void>;
    failure: string;
}

/** Installed plugins with their rollout status, and every plugin action - shared by the Plugins page and the
 * setup wizard. */
export default function PluginsManager() {
    const [plugins, setPlugins] = useState<Plugin[]>([]);
    const [status, setStatus] = useState<PluginStatus | null>(null);
    const [updates, setUpdates] = useState<Map<string, PluginUpdateInfo>>(new Map());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [upgrading, setUpgrading] = useState<Plugin | null>(null);
    const [configuring, setConfiguring] = useState<Plugin | null>(null);
    const [removing, setRemoving] = useState<Plugin | null>(null);
    const [confirming, setConfirming] = useState<PendingChange | null>(null);
    const [busyUid, setBusyUid] = useState<string | null>(null);

    const refreshStatus = useCallback(() => {
        // Status is advisory - a failure to read it shouldn't hide the plugin list.
        return getPluginStatus()
            .then(setStatus)
            .catch(() => setStatus(null));
    }, []);

    const refreshUpdates = useCallback(() => {
        // Also advisory: a registry that can't be reached just means no update badges.
        return getPluginUpdates()
            .then((list) => setUpdates(new Map(list.map((info) => [info.uid, info]))))
            .catch(() => setUpdates(new Map()));
    }, []);

    /** Re-reads the list, for changes that also installed or enabled other plugins. */
    const reload = useCallback(() => {
        return listPlugins()
            .then(setPlugins)
            .catch(() => undefined);
    }, []);

    useEffect(() => {
        Promise.all([listPlugins(), refreshStatus()])
            .then(([list]) => {
                setPlugins(list);
                void refreshUpdates();
            })
            .catch((err) => setError(errorMessage(err, "Could not load plugins.")))
            .finally(() => setLoading(false));
    }, [refreshStatus, refreshUpdates]);

    const pending: boolean = !!status && status.instances.some((instance) => instance.hash !== status.hash);
    useEffect(() => {
        if (!pending) {
            return;
        }
        const timer = setInterval(() => void refreshStatus(), PENDING_POLL_MS);
        return () => clearInterval(timer);
    }, [pending, refreshStatus]);

    /** Applies saved changes locally and re-reads status and updates, since saving starts a rollout. */
    function applied(...changed: Plugin[]) {
        setPlugins((prev) => {
            let next = prev;
            for (const updated of changed) {
                const exists = next.some((plugin) => plugin.uid === updated.uid);
                next = exists ? next.map((plugin) => (plugin.uid === updated.uid ? updated : plugin)) : [...next, updated];
            }
            return [...next].sort((a, b) => a.name.localeCompare(b.name));
        });
        void refreshStatus();
        void refreshUpdates();
    }

    async function run(plugin: Plugin, action: () => Promise<Plugin>, failure: string) {
        setBusyUid(plugin.uid);
        setError(null);
        try {
            applied(await action());
        } catch (err) {
            setError(errorMessage(err, failure));
        } finally {
            setBusyUid(null);
        }
    }

    function toggle(plugin: Plugin) {
        return run(
            plugin,
            async () => {
                const updated = await updatePlugin(plugin.uid, { version: plugin.version, enabled: !plugin.enabled });
                // Enabling a plugin also enables the plugins it requires.
                if (updated.enabled && Object.keys(plugin.manifest.requires ?? {}).length > 0) {
                    void reload();
                }
                return updated;
            },
            `Could not ${plugin.enabled ? "disable" : "enable"} ${plugin.manifest.displayName}.`,
        );
    }

    /**
     * Checks what installing or changing a plugin also takes before doing it. Resolves why it can't be done, or `null`
     * once it's done - or, when it also installs or enables other plugins, once they're shown for confirmation.
     */
    async function planned(
        name: string,
        packageVersion: string,
        displayName: string,
        apply: (plan: PluginChangePlan) => Promise<void>,
        failure: string,
    ): Promise<string | null> {
        try {
            const plan: PluginChangePlan = await planPluginChange(name, packageVersion);
            if (plan.conflicts.length > 0) {
                return `${displayName} ${plan.plugin.version} can't be installed. ${plan.conflicts.join(" ")}`;
            }
            if (plan.install.length > 0 || plan.enable.length > 0) {
                setConfirming({ displayName, plan, apply, failure });
                return null;
            }
            await apply(plan);
            return null;
        } catch (err) {
            return errorMessage(err, failure);
        }
    }

    function install(name: string, packageVersion: string, displayName: string) {
        return planned(
            name,
            packageVersion,
            displayName,
            async () => {
                const result = await addPlugin(name, packageVersion);
                applied(...result.dependencies, result.plugin);
            },
            `Could not install ${displayName}.`,
        );
    }

    function changeVersion(plugin: Plugin, packageVersion: string) {
        return planned(
            plugin.name,
            packageVersion,
            plugin.manifest.displayName,
            async (plan) => {
                applied(await updatePlugin(plugin.uid, { version: plugin.version, packageVersion }));
                if (plan.install.length > 0 || plan.enable.length > 0) {
                    void reload();
                }
            },
            `Could not upgrade ${plugin.manifest.displayName}.`,
        );
    }

    async function upgrade(plugin: Plugin, packageVersion: string) {
        setBusyUid(plugin.uid);
        setError(null);
        const problem = await changeVersion(plugin, packageVersion);
        if (problem) {
            setError(problem);
        }
        setBusyUid(null);
    }

    const displayNameOf = (name: string): string => plugins.find((plugin) => plugin.name === name)?.manifest.displayName ?? name;

    return (
        <>
            <div className="flex items-center justify-between mb-2">
                <h1 className="text-xl font-bold uppercase tracking-wide">Plugins</h1>
                <Button type="button" variant="secondary" className="!w-auto" onClick={() => setAdding(true)}>
                    Add by name
                </Button>
            </div>
            <p className="text-sm text-text-muted mb-5 max-w-3xl">
                Plugins add protocols and features to every server. Changes are applied by restarting the servers
                one at a time, so mail keeps flowing. Plugins run with full access to the server, so only add ones
                you trust.
            </p>

            {error && <Alert>{error}</Alert>}
            <RolloutBanner status={status} />

            <h2 className="text-sm font-bold uppercase tracking-wide mb-2">Installed plugins</h2>
            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : plugins.length === 0 ? (
                <p className="text-sm text-text-muted">No plugins installed.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr>
                                {["Plugin", "Version", "State", "Servers", ""].map((h) => (
                                    <th
                                        key={h}
                                        className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border"
                                    >
                                        {h}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {plugins.map((plugin) => {
                                const update: PluginUpdateInfo | undefined = updates.get(plugin.uid);
                                const latest: string | undefined = update?.updateAvailable ? update.latestVersion : undefined;
                                const busy: boolean = busyUid === plugin.uid;
                                const requires: string[] = Object.keys(plugin.manifest.requires ?? {}).map(displayNameOf);
                                const requiredBy: string[] = plugins
                                    .filter((other) => other.uid !== plugin.uid && other.manifest.requires?.[plugin.name] !== undefined)
                                    .map((other) => other.manifest.displayName);
                                return (
                                    <tr key={plugin.uid}>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top">
                                            <div className="font-semibold">{plugin.manifest.displayName}</div>
                                            <div className="text-xs text-text-muted">{plugin.name}</div>
                                            {plugin.manifest.description && (
                                                <div className="text-xs text-text-muted mt-1 max-w-md">{plugin.manifest.description}</div>
                                            )}
                                            {requires.length > 0 && <div className="text-xs text-text-muted mt-1">Requires: {requires.join(", ")}</div>}
                                            {requiredBy.length > 0 && (
                                                <div className="text-xs text-text-muted mt-1">Required by: {requiredBy.join(", ")}</div>
                                            )}
                                        </td>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top">
                                            <div>{plugin.packageVersion}</div>
                                            {latest && (
                                                <div className="mt-1 flex flex-col items-start gap-1">
                                                    <span className="text-xs font-semibold text-primary-dark">Update available: {latest}</span>
                                                    <Button
                                                        type="button"
                                                        variant="secondary"
                                                        className="!w-auto !py-1 !px-2 !text-xs"
                                                        aria-label={`Upgrade ${plugin.manifest.displayName} to ${latest}`}
                                                        disabled={busy}
                                                        onClick={() => void upgrade(plugin, latest)}
                                                    >
                                                        Upgrade
                                                    </Button>
                                                </div>
                                            )}
                                        </td>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top">
                                            {plugin.enabled ? (
                                                <span className="text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-success text-white">
                                                    Enabled
                                                </span>
                                            ) : (
                                                <span className="text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-surface-alt text-text-muted">
                                                    Disabled
                                                </span>
                                            )}
                                        </td>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top">
                                            <PluginStatusCell plugin={plugin} status={status} />
                                        </td>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top text-right whitespace-nowrap">
                                            <Button
                                                variant="text"
                                                type="button"
                                                className="!w-auto"
                                                aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.manifest.displayName}`}
                                                disabled={busy}
                                                onClick={() => void toggle(plugin)}
                                            >
                                                {plugin.enabled ? "Disable" : "Enable"}
                                            </Button>
                                            {(plugin.manifest.settings ?? []).length > 0 && (
                                                <Button variant="text" type="button" className="!w-auto" onClick={() => setConfiguring(plugin)}>
                                                    Settings
                                                </Button>
                                            )}
                                            <Button variant="text" type="button" className="!w-auto" onClick={() => setUpgrading(plugin)}>
                                                Change version
                                            </Button>
                                            <Button variant="text" type="button" className="!w-auto" onClick={() => setRemoving(plugin)}>
                                                Uninstall
                                            </Button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            <PluginBrowser
                plugins={plugins}
                onInstall={(result) => install(result.name, result.version, result.name)}
                onUpgrade={(uid, packageVersion) => {
                    const plugin = plugins.find((p) => p.uid === uid);
                    return plugin ? upgrade(plugin, packageVersion) : Promise.resolve();
                }}
            />

            <AddPluginModal
                open={adding}
                onClose={() => setAdding(false)}
                onAdd={async (name, packageVersion, displayName) => {
                    const problem = await install(name, packageVersion, displayName);
                    if (!problem) {
                        setAdding(false);
                    }
                    return problem;
                }}
            />
            {upgrading && (
                <ChangeVersionModal
                    plugin={upgrading}
                    onClose={() => setUpgrading(null)}
                    onSave={async (packageVersion) => {
                        const problem = await changeVersion(upgrading, packageVersion);
                        if (!problem) {
                            setUpgrading(null);
                        }
                        return problem;
                    }}
                />
            )}
            {confirming && (
                <ConfirmDependenciesModal
                    change={confirming}
                    displayNameOf={displayNameOf}
                    onClose={() => setConfirming(null)}
                    onDone={() => setConfirming(null)}
                />
            )}
            {configuring && (
                <SettingsModal
                    plugin={configuring}
                    onClose={() => setConfiguring(null)}
                    onSaved={(plugin) => {
                        setConfiguring(null);
                        applied(plugin);
                    }}
                />
            )}
            {removing && (
                <RemoveModal
                    plugin={removing}
                    onClose={() => setRemoving(null)}
                    onRemoved={() => {
                        const uid = removing.uid;
                        setRemoving(null);
                        setPlugins((prev) => prev.filter((plugin) => plugin.uid !== uid));
                        void refreshStatus();
                    }}
                />
            )}
        </>
    );
}

const ALL_NAMESPACES = "";

/** Searches the configured namespaces' registries for plugin packages, with install and upgrade actions. */
function PluginBrowser({
    plugins,
    onInstall,
    onUpgrade,
}: {
    plugins: Plugin[];
    /** Resolves why the plugin couldn't be installed, or `null`. */
    onInstall: (result: PluginSearchResult) => Promise<string | null>;
    onUpgrade: (uid: string, packageVersion: string) => Promise<void>;
}) {
    const [namespaces, setNamespaces] = useState<PluginNamespace[]>([]);
    const [namespace, setNamespace] = useState(ALL_NAMESPACES);
    const [results, setResults] = useState<PluginSearchResult[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [busyName, setBusyName] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        listPluginNamespaces()
            .then(setNamespaces)
            .catch(() => setNamespaces([]));
    }, []);

    async function search(e: FormEvent) {
        e.preventDefault();
        setSearching(true);
        setError(null);
        try {
            setResults(await searchPlugins(namespace || undefined));
        } catch (err) {
            setResults(null);
            setError(errorMessage(err, "Could not search for plugins."));
        } finally {
            setSearching(false);
        }
    }

    // Keep results in step with installs and upgrades made anywhere on the page.
    const rows: PluginSearchResult[] = (results ?? []).map((result) => {
        const installed: Plugin | undefined = plugins.find((plugin) => plugin.name === result.name);
        return {
            ...result,
            installedUid: installed?.uid,
            installedVersion: installed?.packageVersion,
            updateAvailable: !!installed && installed.packageVersion !== result.version && result.updateAvailable,
        };
    });

    async function install(result: PluginSearchResult) {
        setBusyName(result.name);
        setError(null);
        setError(await onInstall(result));
        setBusyName(null);
    }

    async function upgrade(result: PluginSearchResult) {
        setBusyName(result.name);
        try {
            await onUpgrade(result.installedUid!, result.version);
        } finally {
            setBusyName(null);
        }
    }

    return (
        <section aria-labelledby="plugin-browser-title" className="mt-8">
            <h2 id="plugin-browser-title" className="text-sm font-bold uppercase tracking-wide mb-2">
                Find plugins
            </h2>
            <form onSubmit={(e) => void search(e)} className="flex flex-wrap gap-2 items-end mb-3">
                <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-semibold">Namespace</span>
                    <select aria-label="Namespace" className={INPUT_CLASS} value={namespace} onChange={(e) => setNamespace(e.target.value)}>
                        <option value={ALL_NAMESPACES}>All namespaces</option>
                        {namespaces.map((ns) => (
                            <option key={ns.name} value={ns.name}>
                                {ns.name}
                            </option>
                        ))}
                    </select>
                </label>
                <Button type="submit" className="!w-auto" loading={searching} disabled={searching}>
                    Search
                </Button>
            </form>
            {error && <Alert>{error}</Alert>}
            {results !== null &&
                (rows.length === 0 ? (
                    <p className="text-sm text-text-muted">No plugins found.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm border-collapse">
                            <thead>
                                <tr>
                                    {["Package", "Latest version", "Status", ""].map((h) => (
                                        <th
                                            key={h}
                                            className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border"
                                        >
                                            {h}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((result) => (
                                    <tr key={result.name}>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top">
                                            <div className="font-semibold">{result.name}</div>
                                            {result.description && <div className="text-xs text-text-muted max-w-md">{result.description}</div>}
                                        </td>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top">{result.version}</td>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top text-text-muted">
                                            {result.updateAvailable
                                                ? `Installed ${result.installedVersion} - update available`
                                                : result.installedUid
                                                  ? `Installed ${result.installedVersion}`
                                                  : result.allowed
                                                    ? "Not installed"
                                                    : "Not allowed on this server"}
                                        </td>
                                        <td className="py-2.5 px-2.5 border-b border-border align-top text-right">
                                            {result.updateAvailable ? (
                                                <Button
                                                    type="button"
                                                    variant="secondary"
                                                    className="!w-auto"
                                                    aria-label={`Upgrade ${result.name} to ${result.version}`}
                                                    disabled={busyName === result.name}
                                                    onClick={() => void upgrade(result)}
                                                >
                                                    Upgrade
                                                </Button>
                                            ) : (
                                                !result.installedUid &&
                                                result.allowed && (
                                                    <Button
                                                        type="button"
                                                        className="!w-auto"
                                                        aria-label={`Install ${result.name}`}
                                                        loading={busyName === result.name}
                                                        disabled={busyName === result.name}
                                                        onClick={() => void install(result)}
                                                    >
                                                        Install
                                                    </Button>
                                                )
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ))}
        </section>
    );
}

/** Shown while any server copy hasn't applied the saved plugin set yet, or when one is in safe mode. */
function RolloutBanner({ status }: { status: PluginStatus | null }) {
    if (!status || status.instances.length === 0) {
        return null;
    }
    const behind = status.instances.filter((instance) => instance.hash !== status.hash).length;
    const safeMode = status.instances.filter((instance) => instance.safeMode);
    return (
        <>
            {behind > 0 && (
                <p role="status" className="mb-4 text-sm py-2 px-3 rounded-sm bg-surface-alt text-text">
                    Applying changes: {status.instances.length - behind} of {status.instances.length}{" "}
                    {status.instances.length === 1 ? "server" : "servers"} updated. Servers restart one at a time.
                </p>
            )}
            {safeMode.length > 0 && (
                <Alert>
                    {safeMode.map((instance) => instance.instance).join(", ")} started without any plugins because recent
                    starts failed. Fix or disable the failing plugin, and the server will pick up the change.
                </Alert>
            )}
        </>
    );
}

function PluginStatusCell({ plugin, status }: { plugin: Plugin; status: PluginStatus | null }) {
    if (!plugin.enabled) {
        return <span className="text-text-muted">Disabled</span>;
    }
    if (!status || status.instances.length === 0) {
        return <span className="text-text-muted">Unknown</span>;
    }
    const current: PluginInstanceStatus[] = status.instances.filter((instance) => instance.hash === status.hash);
    const loaded = current.filter((instance) =>
        instance.loaded.some((entry) => entry.name === plugin.name && entry.version === plugin.packageVersion),
    ).length;
    const errors = current.flatMap((instance) =>
        instance.errors.filter((entry) => entry.name === plugin.name).map((entry) => `${instance.instance}: ${entry.message}`),
    );
    return (
        <div>
            <span className={loaded === status.instances.length ? "text-success font-medium" : "text-text-muted"}>
                Loaded on {loaded} of {status.instances.length} {status.instances.length === 1 ? "server" : "servers"}
            </span>
            {errors.map((message) => (
                <div key={message} className="text-xs text-danger mt-1">
                    {message}
                </div>
            ))}
        </div>
    );
}

function AddPluginModal({
    open,
    onClose,
    onAdd,
}: {
    open: boolean;
    onClose: () => void;
    /** Resolves why the plugin couldn't be added, or `null`. */
    onAdd: (name: string, packageVersion: string, displayName: string) => Promise<string | null>;
}) {
    const [name, setName] = useState("");
    const [lookup, setLookup] = useState<PluginRegistryLookup | null>(null);
    const [selectedVersion, setSelectedVersion] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!open) {
            setName("");
            setLookup(null);
            setSelectedVersion("");
            setError(null);
        }
    }, [open]);

    async function find(e: FormEvent) {
        e.preventDefault();
        if (!name.trim()) {
            setError("Enter a package name.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const found = await lookupPluginPackage(name.trim());
            setLookup(found);
            setSelectedVersion(found.selected.version);
        } catch (err) {
            setLookup(null);
            setError(errorMessage(err, "Could not look that package up."));
        } finally {
            setBusy(false);
        }
    }

    const manifest = lookup?.selected.manifest;

    async function add() {
        setBusy(true);
        setError(null);
        const name: string = lookup!.package.name;
        const problem = await onAdd(name, selectedVersion, typeof manifest === "object" ? manifest.displayName : name);
        setError(problem);
        setBusy(false);
    }

    return (
        <Modal open={open} onClose={onClose} title="Add plugin">
            {error && <Alert>{error}</Alert>}
            <form onSubmit={find} className="flex gap-2 items-end mb-4">
                <label className="flex flex-col gap-1.5 text-sm flex-1">
                    <span className="font-semibold">Package name</span>
                    <input
                        aria-label="Package name"
                        className={INPUT_CLASS}
                        value={name}
                        placeholder="@rapidmx/activesync"
                        onChange={(e) => {
                            setName(e.target.value);
                            setLookup(null);
                        }}
                    />
                </label>
                <Button type="submit" variant="secondary" className="!w-auto" loading={busy && !lookup} disabled={busy}>
                    Find
                </Button>
            </form>
            {lookup && (
                <div className="flex flex-col gap-3">
                    {typeof manifest === "string" ? (
                        <Alert>{manifest}</Alert>
                    ) : (
                        <div className="text-sm">
                            <div className="font-semibold">{manifest?.displayName}</div>
                            {manifest?.description && <div className="text-text-muted">{manifest.description}</div>}
                        </div>
                    )}
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-semibold">Version</span>
                        <select aria-label="Version" className={INPUT_CLASS} value={selectedVersion} onChange={(e) => setSelectedVersion(e.target.value)}>
                            {lookup.package.versions.map((version) => (
                                <option key={version} value={version}>
                                    {version}
                                    {version === lookup.package.latest ? " (latest)" : ""}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className="flex gap-2 justify-end">
                        <Button type="button" variant="secondary" className="!w-auto" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="button" className="!w-auto" loading={busy} disabled={busy || typeof manifest === "string"} onClick={() => void add()}>
                            Add plugin
                        </Button>
                    </div>
                </div>
            )}
        </Modal>
    );
}

function ChangeVersionModal({
    plugin,
    onClose,
    onSave,
}: {
    plugin: Plugin;
    onClose: () => void;
    /** Resolves why the version couldn't be changed, or `null`. */
    onSave: (packageVersion: string) => Promise<string | null>;
}) {
    const [versions, setVersions] = useState<string[] | null>(null);
    const [latest, setLatest] = useState<string | undefined>();
    const [selected, setSelected] = useState(plugin.packageVersion);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        lookupPluginPackage(plugin.name)
            .then((found) => {
                setVersions(found.package.versions);
                setLatest(found.package.latest);
            })
            .catch((err) => setError(errorMessage(err, "Could not load the available versions.")));
    }, [plugin.name]);

    async function save() {
        setBusy(true);
        setError(null);
        const problem = await onSave(selected);
        if (problem) {
            setError(problem);
            setBusy(false);
        }
    }

    return (
        <Modal open onClose={onClose} title={`${plugin.manifest.displayName} version`}>
            {error && <Alert>{error}</Alert>}
            {versions === null ? (
                !error && <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : (
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-semibold">Version</span>
                        <select aria-label="Version" className={INPUT_CLASS} value={selected} onChange={(e) => setSelected(e.target.value)}>
                            {versions.map((version) => (
                                <option key={version} value={version}>
                                    {version}
                                    {version === latest ? " (latest)" : ""}
                                    {version === plugin.packageVersion ? " (installed)" : ""}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className="flex gap-2 justify-end">
                        <Button type="button" variant="secondary" className="!w-auto" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            className="!w-auto"
                            loading={busy}
                            disabled={busy || selected === plugin.packageVersion}
                            onClick={() => void save()}
                        >
                            Save
                        </Button>
                    </div>
                </div>
            )}
        </Modal>
    );
}

/** Lists the plugins a change also installs or enables, and makes the change once confirmed. */
function ConfirmDependenciesModal({
    change,
    displayNameOf,
    onClose,
    onDone,
}: {
    change: PendingChange;
    displayNameOf: (name: string) => string;
    onClose: () => void;
    onDone: () => void;
}) {
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const { plan } = change;

    async function proceed() {
        setBusy(true);
        setError(null);
        try {
            await change.apply(plan);
            onDone();
        } catch (err) {
            setError(errorMessage(err, change.failure));
            setBusy(false);
        }
    }

    return (
        <Modal open onClose={onClose} title={`${change.displayName} requires other plugins`}>
            {error && <Alert>{error}</Alert>}
            <p className="text-sm mb-2">
                {change.displayName} {plan.plugin.version} needs these plugins, so they&apos;ll be changed too:
            </p>
            <ul className="text-sm list-disc pl-5 mb-4">
                {plan.install.map((dependency) => (
                    <li key={dependency.name}>
                        Install {dependency.manifest.displayName} {dependency.version}
                    </li>
                ))}
                {plan.enable.map((name) => (
                    <li key={name}>Enable {displayNameOf(name)}</li>
                ))}
            </ul>
            <div className="flex gap-2 justify-end">
                <Button type="button" variant="secondary" className="!w-auto" onClick={onClose}>
                    Cancel
                </Button>
                <Button type="button" className="!w-auto" loading={busy} disabled={busy} onClick={() => void proceed()}>
                    Continue
                </Button>
            </div>
        </Modal>
    );
}

/** A setting's current form value: its saved value, else its default. Kept as a string for text inputs. */
function initialValue(definition: PluginSettingDefinition, saved: PluginSettingValue | undefined): PluginSettingValue | "" {
    const value = saved ?? definition.default;
    if (definition.type === "boolean") {
        return value === true;
    }
    return value === undefined ? "" : String(value);
}

function SettingsModal({ plugin, onClose, onSaved }: { plugin: Plugin; onClose: () => void; onSaved: (plugin: Plugin) => void }) {
    const definitions: PluginSettingDefinition[] = plugin.manifest.settings ?? [];
    const initial = useRef(Object.fromEntries(definitions.map((d) => [d.key, initialValue(d, plugin.settings[d.key])])));
    const [values, setValues] = useState<Record<string, PluginSettingValue | "">>(initial.current);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function save(e: FormEvent) {
        e.preventDefault();
        const settings: Record<string, PluginSettingValue | null> = {};
        for (const definition of definitions) {
            const value = values[definition.key];
            if (definition.type === "number") {
                if (value === "") {
                    settings[definition.key] = null;
                    continue;
                }
                // A number input only ever reports a valid number or an empty string.
                settings[definition.key] = Number(value);
            } else {
                settings[definition.key] = value === "" ? null : value;
            }
        }
        setBusy(true);
        setError(null);
        try {
            onSaved(await updatePlugin(plugin.uid, { version: plugin.version, settings }));
        } catch (err) {
            setError(errorMessage(err, "Could not save the settings."));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal open onClose={onClose} title={`${plugin.manifest.displayName} settings`}>
            {error && <Alert>{error}</Alert>}
            <form onSubmit={save} className="flex flex-col gap-4">
                {definitions.map((definition) => (
                    <SettingField
                        key={definition.key}
                        definition={definition}
                        value={values[definition.key]}
                        onChange={(value) => setValues((prev) => ({ ...prev, [definition.key]: value }))}
                    />
                ))}
                <p className="text-xs text-text-muted">Saving restarts the servers one at a time to apply the new settings.</p>
                <div className="flex gap-2 justify-end">
                    <Button type="button" variant="secondary" className="!w-auto" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" className="!w-auto" loading={busy} disabled={busy}>
                        Save
                    </Button>
                </div>
            </form>
        </Modal>
    );
}

function SettingField({
    definition,
    value,
    onChange,
}: {
    definition: PluginSettingDefinition;
    value: PluginSettingValue | "";
    onChange: (value: PluginSettingValue | "") => void;
}) {
    const help = definition.help && <span className="text-xs text-text-muted">{definition.help}</span>;
    if (definition.type === "boolean") {
        return (
            <label className="flex flex-col gap-1 text-sm">
                <span className="inline-flex items-center gap-2 font-semibold">
                    <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
                    {definition.label}
                </span>
                {help}
            </label>
        );
    }
    return (
        <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-semibold">{definition.label}</span>
            {definition.type === "select" ? (
                <select aria-label={definition.label} className={INPUT_CLASS} value={String(value)} onChange={(e) => onChange(e.target.value)}>
                    {!definition.required && <option value="">Default</option>}
                    {(definition.options ?? []).map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            ) : (
                <input
                    aria-label={definition.label}
                    className={INPUT_CLASS}
                    type={definition.type === "number" ? "number" : "text"}
                    min={definition.min}
                    max={definition.max}
                    required={definition.required}
                    value={String(value)}
                    onChange={(e) => onChange(e.target.value)}
                />
            )}
            {help}
        </label>
    );
}

function RemoveModal({ plugin, onClose, onRemoved }: { plugin: Plugin; onClose: () => void; onRemoved: () => void }) {
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function remove() {
        setBusy(true);
        setError(null);
        try {
            await removePlugin(plugin.uid);
            onRemoved();
        } catch (err) {
            setError(errorMessage(err, "Could not uninstall the plugin."));
            setBusy(false);
        }
    }

    return (
        <Modal open onClose={onClose} title={`Uninstall ${plugin.manifest.displayName}?`}>
            {error && <Alert>{error}</Alert>}
            <p className="text-sm mb-4">
                The servers stop running this plugin after they restart. Data it stored stays in the database, and adding
                the plugin again brings it back.
            </p>
            <div className="flex gap-2 justify-end">
                <Button type="button" variant="secondary" className="!w-auto" onClick={onClose}>
                    Cancel
                </Button>
                <Button type="button" className="!w-auto" loading={busy} disabled={busy} onClick={() => void remove()}>
                    Uninstall
                </Button>
            </div>
        </Modal>
    );
}

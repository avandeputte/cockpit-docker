/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Settings of a host: stacks directory, primary hostname, global.env and console.
 * Dockge's login, password, 2FA and appearance settings are handled by Cockpit itself.
 */

import React, { useEffect, useState } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { Form, FormGroup, FormHelperText } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText/index.js";
import { InputGroup, InputGroupItem } from "@patternfly/react-core/dist/esm/components/InputGroup/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";

import cockpit from 'cockpit';
import { useDialogs } from "dialogs.jsx";
import { EmptyStatePanel } from "cockpit-components-empty-state.jsx";
import { ModalError } from "cockpit-components-inline-notification.jsx";

import * as docker from './docker';
import type { AutoUpdate, Host, Settings } from './docker';
import { CodeEditor } from './CodeEditor';
import { Model } from './model';

const _ = cockpit.gettext;

export const SettingsDialog = ({ model }: { model: Model }) => {
    const Dialogs = useDialogs();
    const [host, setHost] = useState<Host>("");
    const [settings, setSettings] = useState<Settings | null>(null);
    const [savedAutoUpdate, setSavedAutoUpdate] = useState<AutoUpdate>("off");
    const [globalEnv, setGlobalEnv] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setSettings(null);
        setError(null);
        (async () => {
            const s = host === "" ? model.localSettings ?? await docker.loadSettings("") : await docker.loadSettings(host);
            const env = await docker.readGlobalEnv(host, s);
            if (!cancelled) {
                setSettings({ ...s });
                setSavedAutoUpdate(s.autoUpdate);
                setGlobalEnv(env);
            }
        })().catch(ex => !cancelled && setError(docker.errorMessage(ex)));
        return () => { cancelled = true };
    }, [host, model]);

    const save = () => {
        if (!settings)
            return;
        const stacksDir = settings.stacksDir.trim();
        if (!stacksDir.startsWith("/")) {
            setError(_("The stacks directory must be an absolute path"));
            return;
        }
        setBusy(true);
        setError(null);
        const updated = { ...settings, stacksDir, primaryHostname: settings.primaryHostname.trim() };
        (async () => {
            // Always reinstall when on, so that the timer gets the current update script
            if (updated.autoUpdate !== "off" || savedAutoUpdate !== "off")
                await docker.configureAutoUpdate(host, updated.autoUpdate);
            await model.saveHostSettings(host, updated);
            await docker.writeGlobalEnv(host, updated, globalEnv);
        })()
                .then(() => Dialogs.close())
                .catch(ex => setError(docker.errorMessage(ex)))
                .finally(() => setBusy(false));
    };

    const update = (patch: Partial<Settings>) => setSettings(s => s ? { ...s, ...patch } : s);

    return (
        <Modal id="settings-dialog" position="top" variant="medium" isOpen onClose={() => Dialogs.close()}>
            <ModalHeader title={_("Settings")} />
            <ModalBody>
                {error && <ModalError dialogError={_("Failed to save settings")} dialogErrorDetail={error} />}
                {model.hostList.length > 1 &&
                    <Form>
                        <FormGroup label={_("Host")} fieldId="settings-host">
                            <FormSelect id="settings-host" value={host} onChange={(_ev, v) => setHost(v)}>
                                {model.hostList.map(h => <FormSelectOption key={h} value={h} label={model.hostDisplayName(h)} />)}
                            </FormSelect>
                        </FormGroup>
                    </Form>}
                {!settings
                    ? <EmptyStatePanel loading />
                    : (
                        <Form isHorizontal onSubmit={ev => { ev.preventDefault(); save() }}>
                            <FormGroup label={_("Stacks directory")} fieldId="settings-stacks-dir">
                                <TextInput id="settings-stacks-dir" value={settings.stacksDir}
                                           onChange={(_ev, v) => update({ stacksDir: v })} />
                                <FormHelperText>
                                    <HelperText>
                                        <HelperTextItem>{_("Each stack is a directory with a compose file in here.")}</HelperTextItem>
                                    </HelperText>
                                </FormHelperText>
                            </FormGroup>
                            <FormGroup label={_("Primary hostname")} fieldId="settings-hostname">
                                <InputGroup>
                                    <InputGroupItem isFill>
                                        <TextInput id="settings-hostname" value={settings.primaryHostname}
                                                   placeholder={model.hostnameFor(host)}
                                                   onChange={(_ev, v) => update({ primaryHostname: v })} />
                                    </InputGroupItem>
                                    <InputGroupItem>
                                        <Button variant="control" onClick={() => update({ primaryHostname: window.location.hostname })}>
                                            {_("Use current")}
                                        </Button>
                                    </InputGroupItem>
                                </InputGroup>
                                <FormHelperText>
                                    <HelperText>
                                        <HelperTextItem>{_("Used for the links to published ports.")}</HelperTextItem>
                                    </HelperText>
                                </FormHelperText>
                            </FormGroup>
                            <FormGroup label={_("Global .env")} fieldId="settings-global-env">
                                <CodeEditor id="settings-global-env" language="env" value={globalEnv} onChange={setGlobalEnv}
                                            ariaLabel={_("Global .env")} minHeight="8em" />
                                <FormHelperText>
                                    <HelperText>
                                        <HelperTextItem>
                                            {_("Saved as global.env in the stacks directory and passed to every stack, before the stack's own .env.")}
                                        </HelperTextItem>
                                    </HelperText>
                                </FormHelperText>
                            </FormGroup>
                            <FormGroup label={_("Image updates")} fieldId="settings-check-updates" hasNoPaddingTop>
                                <Checkbox id="settings-check-updates" isChecked={settings.checkUpdates}
                                          onChange={(_ev, v) => update({ checkUpdates: v })}
                                          label={_("Check for newer images when this page opens")}
                                          description={_("Asks the registries for the current digest of each image; nothing is downloaded.")} />
                            </FormGroup>
                            <FormGroup label={_("Automatic updates")} fieldId="settings-auto-update">
                                <FormSelect id="settings-auto-update" value={settings.autoUpdate}
                                            onChange={(_ev, v) => update({ autoUpdate: v as AutoUpdate })}>
                                    <FormSelectOption value="off" label={_("Off")} />
                                    <FormSelectOption value="daily" label={_("Daily")} />
                                    <FormSelectOption value="weekly" label={_("Weekly")} />
                                </FormSelect>
                                <FormHelperText>
                                    <HelperText>
                                        <HelperTextItem>
                                            {_("A systemd timer on this host pulls newer images for running stacks and restarts them, even when Cockpit is not open. Turn it off for single stacks on their page.")}
                                        </HelperTextItem>
                                        {savedAutoUpdate !== "off" &&
                                            <HelperTextItem>
                                                <Button variant="link" isInline id="settings-auto-update-logs"
                                                        onClick={() => cockpit.jump("/system/logs#/?prio=info&_SYSTEMD_UNIT=" + docker.UPDATE_UNIT + ".service", host || undefined)}>
                                                    {_("Show the log of automatic updates")}
                                                </Button>
                                            </HelperTextItem>}
                                    </HelperText>
                                </FormHelperText>
                            </FormGroup>
                            <FormGroup label={_("Console")} fieldId="settings-console" hasNoPaddingTop>
                                <Checkbox id="settings-console" isChecked={settings.enableConsole}
                                          onChange={(_ev, v) => update({ enableConsole: v })}
                                          label={_("Show a shell in the stacks directory")}
                                          description={_("The shell runs with administrative access when it is available.")} />
                            </FormGroup>
                        </Form>
                    )}
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" id="settings-save" onClick={save} isLoading={busy} isDisabled={busy || !settings}>
                    {_("Save")}
                </Button>
                <Button variant="link" onClick={() => Dialogs.close()}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};

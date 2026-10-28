/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Download stacks as a .tar.gz, and import them from one. The archive has the
 * layout of the stacks directory (NAME/compose.yaml, NAME/.env, global.env),
 * so it can also be unpacked there by hand.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox/index.js";
import { Form, FormGroup, FormHelperText } from "@patternfly/react-core/dist/esm/components/Form/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@patternfly/react-core/dist/esm/components/Modal/index.js";

import cockpit from 'cockpit';
import { useDialogs } from "dialogs.jsx";
import { ModalError } from "cockpit-components-inline-notification.jsx";

import * as docker from './docker';
import type { Host, ImportArchive } from './docker';
import { Model, goto } from './model';

const _ = cockpit.gettext;

function saveFile(data: Uint8Array, filename: string) {
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: "application/gzip" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const HostSelect = ({ model, id, host, setHost, isDisabled = false }: {
    model: Model, id: string, host: Host, setHost: (h: Host) => void, isDisabled?: boolean,
}) => {
    if (model.hostList.length < 2)
        return null;
    return (
        <FormGroup label={_("Host")} fieldId={id}>
            <FormSelect id={id} value={host} isDisabled={isDisabled} onChange={(_ev, v) => setHost(v)}>
                {model.hostList.map(h => (
                    <FormSelectOption key={h} value={h} label={model.hostDisplayName(h)}
                                      isDisabled={model.hosts.get(h)?.status !== "online"} />
                ))}
            </FormSelect>
        </FormGroup>
    );
};

/** Download one stack (name given) or all managed stacks of a host */
export const DownloadDialog = ({ model, host: initialHost, name }: { model: Model, host: Host, name?: string }) => {
    const Dialogs = useDialogs();
    const [host, setHost] = useState<Host>(initialHost);
    const [everything, setEverything] = useState(false);
    const [withGlobalEnv, setWithGlobalEnv] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const settings = model.settingsFor(host);
    const names = name ? [name] : (model.hosts.get(host)?.stacks ?? []).filter(s => s.isManaged).map(s => s.name);

    const download = () => {
        if (!settings)
            return;
        setBusy(true);
        setError(null);
        docker.exportStacks(host, settings, names, everything, !name && withGlobalEnv)
                .then(data => {
                    const date = new Date().toISOString()
                            .substring(0, 10);
                    const base = name ?? "stacks-" + (model.hostnameFor(host) || "localhost");
                    saveFile(data, `${base}-${date}.tar.gz`);
                    Dialogs.close();
                })
                .catch(ex => setError(docker.errorMessage(ex)))
                .finally(() => setBusy(false));
    };

    return (
        <Modal id="download-dialog" position="top" variant="small" isOpen onClose={() => Dialogs.close()}>
            <ModalHeader title={name ? cockpit.format(_("Download $0"), name) : _("Download all stacks")} />
            <ModalBody>
                {error && <ModalError dialogError={_("Download failed")} dialogErrorDetail={error} />}
                <Form onSubmit={ev => { ev.preventDefault(); download() }}>
                    {!name && <HostSelect model={model} id="download-host" host={host} setHost={setHost} />}
                    <FormGroup fieldId="download-content" label={_("Content")} isStack>
                        <HelperText>
                            <HelperTextItem>
                                {name
                                    ? _("The compose file and .env of the stack.")
                                    : cockpit.format(cockpit.ngettext("The compose file and .env of $0 stack.",
                                                                      "The compose files and .env of $0 stacks.", names.length),
                                                     names.length)}
                            </HelperTextItem>
                        </HelperText>
                        {!name &&
                            <Checkbox id="download-global-env" isChecked={withGlobalEnv}
                                      onChange={(_ev, v) => setWithGlobalEnv(v)}
                                      label={_("Include global.env")} />}
                        <Checkbox id="download-everything" isChecked={everything}
                                  onChange={(_ev, v) => setEverything(v)}
                                  label={_("Include all other files in the stack directories")}
                                  description={_("For example bind-mounted data. This can be large, and files that containers are writing to may be inconsistent.")} />
                    </FormGroup>
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" id="download-confirm" onClick={download}
                        isLoading={busy} isDisabled={busy || !settings || names.length === 0}>
                    {_("Download")}
                </Button>
                <Button variant="link" onClick={() => Dialogs.close()}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};

/** Import stacks from a .tar.gz made by DownloadDialog (or by hand) */
export const ImportDialog = ({ model }: { model: Model }) => {
    const Dialogs = useDialogs();
    const [host, setHost] = useState<Host>("");
    const [archive, setArchive] = useState<ImportArchive | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const [withGlobalEnv, setWithGlobalEnv] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const archiveRef = useRef<ImportArchive | null>(null);

    // Remove the unpacked archive from the host when the dialog goes away
    useEffect(() => () => {
        if (archiveRef.current)
            docker.closeImportArchive(archiveRef.current).catch(ex => console.warn(docker.errorMessage(ex)));
    }, []);

    const settings = model.settingsFor(host);
    const exists = (n: string) => !!model.findStack(host, n)?.isManaged;

    const setArchiveState = (a: ImportArchive | null) => {
        if (archiveRef.current)
            docker.closeImportArchive(archiveRef.current).catch(ex => console.warn(docker.errorMessage(ex)));
        archiveRef.current = a;
        setArchive(a);
    };

    const onFile = (file: File | undefined) => {
        setArchiveState(null);
        setError(null);
        if (!file)
            return;
        setBusy(true);
        file.arrayBuffer()
                .then(buf => docker.openImportArchive(host, new Uint8Array(buf)))
                .then(a => {
                    setArchiveState(a);
                    // Existing stacks are only overwritten when asked for
                    setSelected(a.stacks.filter(n => !exists(n)));
                    setWithGlobalEnv(false);
                    if (a.stacks.length === 0 && !a.hasGlobalEnv)
                        setError(_("The archive contains no stacks. Stacks are directories with a compose file."));
                })
                .catch(ex => setError(cockpit.format(_("Cannot read the archive: $0"), docker.errorMessage(ex))))
                .finally(() => setBusy(false));
    };

    const doImport = () => {
        if (!archive || !settings)
            return;
        setBusy(true);
        setError(null);
        docker.importStacks(archive, settings, selected, withGlobalEnv)
                .then(() => model.refresh(host))
                .then(() => {
                    Dialogs.close();
                    if (selected.length === 1)
                        goto(["stack", selected[0]], host);
                })
                .catch(ex => setError(docker.errorMessage(ex)))
                .finally(() => setBusy(false));
    };

    const toggle = (n: string, checked: boolean) =>
        setSelected(s => checked ? [...s, n] : s.filter(x => x !== n));

    return (
        <Modal id="import-dialog" position="top" variant="small" isOpen onClose={() => Dialogs.close()}>
            <ModalHeader title={_("Import stacks")} />
            <ModalBody>
                {error && <ModalError dialogError={_("Import failed")} dialogErrorDetail={error} />}
                <Form onSubmit={ev => ev.preventDefault()}>
                    <HostSelect model={model} id="import-host" host={host} isDisabled={busy}
                                setHost={h => { setHost(h); setArchiveState(null) }} />
                    <FormGroup label={_("Archive")} fieldId="import-file">
                        <input type="file" id="import-file" accept=".tar.gz,.tgz,application/gzip" disabled={busy}
                               onChange={ev => onFile(ev.target.files?.[0])} />
                        <FormHelperText>
                            <HelperText>
                                <HelperTextItem>
                                    {_("A .tar.gz from \"Download\", or any archive with one directory per stack.")}
                                </HelperTextItem>
                            </HelperText>
                        </FormHelperText>
                    </FormGroup>
                    {archive && archive.stacks.length > 0 &&
                        <FormGroup label={_("Stacks")} fieldId="import-stacks" role="group" isStack>
                            {archive.stacks.map(n => (
                                <Checkbox key={n} id={"import-stack-" + n} className="import-stack"
                                          isChecked={selected.includes(n)}
                                          onChange={(_ev, v) => toggle(n, v)}
                                          label={<>
                                              {n}
                                              {exists(n) &&
                                                  <Label isCompact color="orange" className="pf-v6-u-ml-sm">
                                                      {selected.includes(n) ? _("Exists, will be overwritten") : _("Exists")}
                                                  </Label>}
                                          </>} />
                            ))}
                        </FormGroup>}
                    {archive?.hasGlobalEnv &&
                        <FormGroup fieldId="import-global-env" hasNoPaddingTop label={_("Global .env")}>
                            <Checkbox id="import-global-env" isChecked={withGlobalEnv}
                                      onChange={(_ev, v) => setWithGlobalEnv(v)}
                                      label={_("Replace global.env with the one in the archive")} />
                        </FormGroup>}
                    {archive && selected.length > 0 &&
                        <Alert isInline isPlain variant="info"
                               title={_("Imported stacks are saved, not started. Deploy them from their page.")} />}
                </Form>
            </ModalBody>
            <ModalFooter>
                <Button variant="primary" id="import-confirm" onClick={doImport}
                        isLoading={busy && !!archive} isDisabled={busy || !archive || !settings || (selected.length === 0 && !withGlobalEnv)}>
                    {_("Import")}
                </Button>
                <Button variant="link" onClick={() => Dialogs.close()}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};

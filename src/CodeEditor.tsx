/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * A small CodeMirror 6 editor for compose.yaml and .env files, styled
 * with PatternFly variables so that it follows Cockpit's light/dark theme.
 */

import React, { useEffect, useRef } from 'react';

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import { StreamLanguage, HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching } from '@codemirror/language';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { tags } from '@lezer/highlight';

import cockpit from 'cockpit';

import "./CodeEditor.scss";

const _ = cockpit.gettext;

const highlightStyle = HighlightStyle.define([
    { tag: [tags.keyword, tags.propertyName, tags.definition(tags.propertyName)], class: "ct-cm-key" },
    { tag: [tags.string, tags.special(tags.string)], class: "ct-cm-string" },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], class: "ct-cm-atom" },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], class: "ct-cm-comment" },
    { tag: [tags.meta, tags.labelName, tags.typeName], class: "ct-cm-meta" },
    { tag: [tags.punctuation, tags.separator, tags.operator], class: "ct-cm-punct" },
]);

export const CodeEditor = ({ id, value, onChange, language, readOnly = false, ariaLabel, minHeight }: {
    id?: string,
    value: string,
    onChange?: (value: string) => void,
    language: "yaml" | "env",
    readOnly?: boolean,
    ariaLabel: string,
    minHeight?: string,
}) => {
    const parent = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const editable = useRef(new Compartment());
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    useEffect(() => {
        if (!parent.current)
            return;
        const v = new EditorView({
            parent: parent.current,
            state: EditorState.create({
                doc: value,
                extensions: [
                    lineNumbers(),
                    highlightActiveLineGutter(),
                    highlightActiveLine(),
                    drawSelection(),
                    history(),
                    indentOnInput(),
                    bracketMatching(),
                    EditorState.tabSize.of(2),
                    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
                    language === "yaml" ? yaml() : StreamLanguage.define(properties),
                    syntaxHighlighting(highlightStyle),
                    EditorView.lineWrapping,
                    EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
                    editable.current.of([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]),
                    EditorView.updateListener.of(update => {
                        if (update.docChanged)
                            onChangeRef.current?.(update.state.doc.toString());
                    }),
                ],
            }),
        });
        view.current = v;
        return () => {
            v.destroy();
            view.current = null;
        };
        // The editor is created once; value and readOnly are synced below
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [language]);

    // Sync external value changes (e.g. edits made through the service forms)
    useEffect(() => {
        const v = view.current;
        if (v && v.state.doc.toString() !== value)
            v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }, [value]);

    useEffect(() => {
        view.current?.dispatch({
            effects: editable.current.reconfigure([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]),
        });
    }, [readOnly]);

    return (
        <div id={id}
             className={"ct-code-editor" + (readOnly ? " ct-code-editor-readonly" : "")}
             style={minHeight ? { minHeight } : undefined}
             title={readOnly ? _("Click \"Edit\" to change this file") : undefined}
             ref={parent} />
    );
};

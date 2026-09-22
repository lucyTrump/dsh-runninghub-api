/**
 * One plugin's form: a header naming the plugin and what its settings govern,
 * disclosing that plugin's controls in place, with the save that writes them.
 * The Plugins page draws the bundle's title, icon, and crumb itself and renders
 * this below them, so the card carries only the plugin's own name and copy. It
 * opens expanded: the page it sits on exists for this one bundle.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import {
  IconChevronDownOutline14,
  Tag,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { CardShell } from "./card-form.ts";
import type { RunningHubLocaleKey } from "./locales.ts";
import css from "./PluginCard.module.css";

/** Card chrome shared by the RunningHub settings section. */
export interface PluginCardProps {
  /** Locale reader for this section's copy. */
  t: (key: RunningHubLocaleKey) => string;
  /** Locale key of the plugin's name. */
  titleKey: RunningHubLocaleKey;
  /** Locale key of the line describing what this plugin's settings govern. */
  descriptionKey: RunningHubLocaleKey;
  /** The card's form state: availability, writability, and what a save would do. */
  state: CardShell;
  /** Write every staged edit. */
  onSave: () => void;
  /** Drop every staged edit. */
  onDiscard: () => void;
  /** The plugin's controls. */
  children: ReactNode;
}

/**
 * Render the RunningHub plugin card.
 * @param props - the plugin's copy keys, its form state, and its controls.
 * @returns the card, or nothing when the namespace is unavailable.
 */
export function PluginCard(props: PluginCardProps) {
  const [open, setOpen] = useState(true);
  const saveStarted = useRef(false);
  const { state } = props;
  // Collapse only after Host-confirmed settlement; a rejected write keeps its
  // diagnostics and retained drafts visible for correction.
  useEffect(() => {
    if (state.saving) {
      saveStarted.current = true;
      return;
    }
    if (!saveStarted.current) return;
    saveStarted.current = false;
    if (!state.dirty && !state.failed) setOpen(false);
  }, [state.dirty, state.failed, state.saving]);
  if (!state.available) return null;
  const title = props.t(props.titleKey);
  const blocked = !state.dirty || state.invalid || state.saving;
  return (
    <div className={clsx(css.card, open && css.cardOpen)}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${props.t(open ? "collapse" : "expand")}: ${title}`}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>
            {props.t(props.descriptionKey)}
          </span>
        </span>
        {state.dirty ? (
          <Tag tone="neutral" className={css.pending}>
            {props.t("unsaved")}
          </Tag>
        ) : null}
        <IconChevronDownOutline14
          className={clsx(css.chevron, open && css.chevronOpen)}
        />
      </button>
      {open ? (
        <div className={css.body} id="runninghub-api-plugin">
          {!state.writable ? (
            <p className={css.readOnly} role="status">
              {props.t("readOnly")}
            </p>
          ) : null}
          {props.children}
          <div className={css.footer}>
            {state.failed ? (
              <p className={css.failed} role="status">
                {props.t("saveFailed")}
              </p>
            ) : null}
            <button
              type="button"
              className={css.discard}
              disabled={!state.dirty || state.saving}
              onClick={props.onDiscard}
            >
              {props.t("discard")}
            </button>
            <button
              type="button"
              className={css.save}
              disabled={blocked}
              onClick={props.onSave}
            >
              {props.t(state.saving ? "saving" : "save")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

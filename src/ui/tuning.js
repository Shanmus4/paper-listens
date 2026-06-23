// tuning.js — the live painting-tuning panel.
//
// Builds a side panel from PARAM_GROUPS (the single source of truth in
// visual/params.js). Each slider writes straight into the live params via
// setParam, so dragging it changes the running simulation on the next frame and
// the ink already on screen re-evolves under the new value. A "Copy values"
// button hands back a JSON snapshot so the final numbers can be baked into the
// defaults. The panel only renders; it owns no painting logic.

import { PARAM_GROUPS, setParam, resetParams, exportParams, params } from "../visual/params.js";

// Format a value for the little readout: integers plain, fine steps with enough
// decimals to actually show the change.
function fmt(p, v) {
  if (p.int) return String(Math.round(v));
  if (p.step < 0.01) return v.toFixed(3);
  if (p.step < 0.1) return v.toFixed(2);
  return v.toFixed(2).replace(/\.?0+$/, "");
}

// Paint the slider's filled portion (sepia up to the value), matching the rest
// of the app's range styling (a progress line, no handle dot).
function setFill(el) {
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty("--pct", pct + "%");
}

export function createTuningPanel(root, { onClose } = {}) {
  // The inputs, keyed by param, so Reset/refresh can push values back into them.
  const rows = new Map();

  // One shared tooltip for the info icons. Lives on <body> with fixed position so
  // the panel's scroll/overflow can never clip it, and so we never build 16 of them.
  let tip = document.querySelector(".tuning-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tuning-tip";
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  function attachTip(icon, text) {
    const show = () => {
      tip.textContent = text;
      tip.hidden = false;
      const r = icon.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      const pad = 8;
      // Prefer the right of the icon; flip left if it would run off-screen.
      let left = r.right + pad;
      if (left + t.width > window.innerWidth - pad) left = r.left - pad - t.width;
      let top = r.top + r.height / 2 - t.height / 2;
      top = Math.max(pad, Math.min(top, window.innerHeight - pad - t.height));
      tip.style.left = `${Math.max(pad, left)}px`;
      tip.style.top = `${top}px`;
    };
    const hide = () => {
      tip.hidden = true;
    };
    icon.addEventListener("mouseenter", show);
    icon.addEventListener("mouseleave", hide);
    icon.addEventListener("focus", show);
    icon.addEventListener("blur", hide);
  }

  const head = document.createElement("div");
  head.className = "tuning-head";
  head.innerHTML = '<span class="tuning-title">Painting controls</span>';
  const headActions = document.createElement("div");
  headActions.className = "tuning-head-actions";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "tuning-reset";
  resetBtn.textContent = "Reset";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "tuning-close";
  closeBtn.setAttribute("aria-label", "Close tuning panel");
  closeBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M3 3 L13 13 M13 3 L3 13" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round"/></svg>';
  closeBtn.addEventListener("click", () => onClose?.());
  headActions.append(resetBtn, closeBtn);
  head.appendChild(headActions);
  root.appendChild(head);

  const body = document.createElement("div");
  body.className = "tuning-body";
  root.appendChild(body);

  for (const group of PARAM_GROUPS) {
    const sec = document.createElement("section");
    sec.className = "tuning-group";
    const h = document.createElement("h3");
    h.className = "tuning-group-title";
    h.textContent = group.title;
    sec.appendChild(h);
    if (group.note) {
      const n = document.createElement("p");
      n.className = "tuning-group-note";
      n.textContent = group.note;
      sec.appendChild(n);
    }

    for (const p of group.params) {
      const row = document.createElement("label");
      row.className = "tuning-row";

      const top = document.createElement("div");
      top.className = "tuning-row-top";
      const labelWrap = document.createElement("span");
      labelWrap.className = "tuning-label-wrap";
      const label = document.createElement("span");
      label.className = "tuning-label";
      label.textContent = p.label;
      labelWrap.appendChild(label);
      if (p.help) {
        const info = document.createElement("span");
        info.className = "tuning-info";
        info.textContent = "i";
        info.tabIndex = 0;
        info.setAttribute("role", "img");
        info.setAttribute("aria-label", p.help);
        attachTip(info, p.help);
        labelWrap.appendChild(info);
      }
      const val = document.createElement("span");
      val.className = "tuning-val";
      val.textContent = fmt(p, params[p.key]);
      top.append(labelWrap, val);

      const input = document.createElement("input");
      input.type = "range";
      input.className = "range tuning-range";
      input.min = String(p.min);
      input.max = String(p.max);
      input.step = String(p.step);
      input.value = String(params[p.key]);
      setFill(input);

      input.addEventListener("input", () => {
        const v = Number(input.value);
        setParam(p.key, v);
        val.textContent = fmt(p, v);
        setFill(input);
        renderOut();
      });

      row.append(top, input);
      sec.appendChild(row);
      rows.set(p.key, { input, val, def: p });
    }
    body.appendChild(sec);
  }

  // Footer: copy the current values + a textarea fallback for easy selection.
  const foot = document.createElement("div");
  foot.className = "tuning-foot";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "tuning-copy";
  copyBtn.textContent = "Copy values";
  const out = document.createElement("textarea");
  out.className = "tuning-out";
  out.readOnly = true;
  out.spellcheck = false;
  foot.append(copyBtn, out);
  root.appendChild(foot);

  function renderOut() {
    out.value = JSON.stringify(exportParams(), null, 2);
  }
  renderOut();

  // Reflect programmatic param changes (Reset) back into the controls.
  function refresh() {
    for (const [key, { input, val, def }] of rows) {
      input.value = String(params[key]);
      val.textContent = fmt(def, params[key]);
      setFill(input);
    }
    renderOut();
  }

  resetBtn.addEventListener("click", () => {
    resetParams();
    refresh();
  });

  copyBtn.addEventListener("click", async () => {
    renderOut();
    try {
      await navigator.clipboard.writeText(out.value);
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.textContent = "Copy values"), 1200);
    } catch (_) {
      // Clipboard blocked: select the textarea so the user can copy manually.
      out.focus();
      out.select();
    }
  });

  return {
    setVisible(on) {
      root.hidden = !on;
      if (on) refresh();
    },
    refresh,
  };
}

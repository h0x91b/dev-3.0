(function () {
  function setTheme(theme) {
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  }

  window.addEventListener("message", function (event) {
    if (event.data && event.data.type === "dev3-artifact-theme") setTheme(event.data.theme);
  });
  if (!document.documentElement.dataset.theme) {
    setTheme(matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  }

  const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- text size ------------------------------------------------------------
  // Every font size in app.css is a rem, so one root scale resizes the whole
  // report. The bounds are the range the layout survives: below 80% the dense
  // evidence tables stop being legible, above 150% the 12-column dashboard and
  // the topbar run out of room on a laptop.
  const FONT_SCALE_STEPS = [.8, .9, 1, 1.1, 1.2, 1.3, 1.4, 1.5];
  const FONT_SCALE_KEY = "dev3-artifact-font-scale";
  const DEFAULT_FONT_SCALE_INDEX = FONT_SCALE_STEPS.indexOf(1);

  // A sandboxed artifact has an opaque origin, where touching localStorage
  // throws instead of returning null, so the preference is best-effort.
  function storedFontScaleIndex() {
    try {
      const stored = Number(localStorage.getItem(FONT_SCALE_KEY));
      const index = FONT_SCALE_STEPS.indexOf(stored);
      return index === -1 ? DEFAULT_FONT_SCALE_INDEX : index;
    } catch { return DEFAULT_FONT_SCALE_INDEX; }
  }

  let fontScaleIndex = storedFontScaleIndex();
  const fontScale = () => FONT_SCALE_STEPS[fontScaleIndex];
  // Ahead of the control wiring below, so a remembered scale is in place before
  // report code lays anything out.
  document.documentElement.style.setProperty("--dev3-font-scale-user", String(fontScale()));
  // ECharts sizes are raw px numbers, so chart text needs the multiplier applied
  // by hand where CSS cannot reach.
  const scaledFont = (px) => Math.round(px * fontScale() * 10) / 10;

  // ---- dev3 chart bridge ----------------------------------------------------
  // The pinned cdnjs script exposes window.echarts. Charts use the SVG renderer
  // so print/PDF output stays crisp. Offline charts degrade to a notice.
  const CHART_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const chartsAvailable = typeof window.echarts !== "undefined";
  const dev3ChartRegistry = new Set();
  let appliedChartTheme;

  function tokenColor(name, alpha) {
    const triplet = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).join(", ");
    return alpha == null ? `rgb(${triplet})` : `rgba(${triplet}, ${alpha})`;
  }

  // ---- navigation and enhanced native controls ------------------------------
  function fragmentTarget(link) {
    if (!link.hash || link.hash === "#") return null;
    try { return document.getElementById(decodeURIComponent(link.hash.slice(1))); }
    catch { return null; }
  }

  function focusSection(target) {
    const heading = target.matches("h1, h2, h3") ? target : target.querySelector("h1, h2, h3");
    if (!heading) return;
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  }

  function initializeNavigation() {
    const localLinks = [...document.querySelectorAll('a[href^="#"]')]
      .map((link) => ({ link, target: fragmentTarget(link) }))
      .filter((entry) => entry.target);

    localLinks.forEach(({ link, target }) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        target.scrollIntoView({ block: "start" });
        focusSection(target);
        try { history.replaceState(null, "", `#${target.id}`); } catch {}
        const nav = link.closest(".section-nav");
        if (nav) {
          nav.querySelectorAll('a[href^="#"]').forEach((item) => item.removeAttribute("aria-current"));
          link.setAttribute("aria-current", "location");
        }
      });
    });

    document.querySelectorAll(".section-nav").forEach((nav) => {
      const entries = localLinks.filter(({ link }) => nav.contains(link));
      if (!entries.length) return;
      let frame;
      const update = () => {
        frame = undefined;
        const activationLine = nav.getBoundingClientRect().bottom + 18;
        let current = entries[0];
        entries.forEach((entry) => {
          if (entry.target.getBoundingClientRect().top <= activationLine) current = entry;
        });
        entries.forEach(({ link }) => link.toggleAttribute("aria-current", link === current.link));
        if (current.link.hasAttribute("aria-current")) current.link.setAttribute("aria-current", "location");
      };
      const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
      window.addEventListener("scroll", schedule, { passive: true });
      window.addEventListener("resize", schedule);
      update();
    });
  }

  // A sticky table header must land below the sticky section nav, and sit at the
  // very top when a report has no nav at all.
  function applyStickyOffset() {
    const nav = document.querySelector(".section-nav");
    const offset = nav ? Math.round(nav.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty("--dev3-table-head-top", `${offset}px`);
  }

  function trackStickyOffset() {
    applyStickyOffset();
    window.addEventListener("resize", applyStickyOffset);
  }

  // A `<table data-sortable>` sorts its own rows in place, so a report whose
  // rows live in the markup needs no JavaScript at all. The `data-sort` value
  // of a cell wins over its text, so "1.2 GB" can still order numerically.
  function sortRowsInPlace(table, heading, direction) {
    const index = [...heading.parentElement.children].indexOf(heading);
    const key = (row) => {
      const cell = row.children[index];
      return cell ? cell.dataset.sort ?? cell.textContent.trim() : "";
    };
    table.querySelectorAll("tbody").forEach((body) => {
      [...body.rows]
        .sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true, sensitivity: "base" }) * direction)
        .forEach((row) => body.appendChild(row));
    });
  }

  // The shell owns the visible sort state, so every artifact shows which column
  // is sorted and in which direction; report code owns the data unless the
  // table asked the shell to sort its rows.
  function initializeSortIndicators() {
    document.querySelectorAll("thead").forEach((head) => {
      const headings = [...head.querySelectorAll("th[data-sort]")];
      if (!headings.length) return;
      const table = head.closest("table");
      const mark = (heading) => {
        const next = heading.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
        headings.forEach((item) => item.removeAttribute("aria-sort"));
        heading.setAttribute("aria-sort", next);
        if (table?.hasAttribute("data-sortable")) sortRowsInPlace(table, heading, next === "ascending" ? 1 : -1);
      };
      headings.forEach((heading) => {
        heading.addEventListener("click", () => mark(heading));
        heading.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") mark(heading);
        });
      });
    });
  }

  // ---- top-layer overlays ---------------------------------------------------
  // The classic artifact bug is a menu nested in a card: the card clips it, a
  // sticky header covers it, and the author is left tuning z-index numbers that
  // cannot win. Every panel that opens over the report is promoted into the
  // browser top layer instead, where no ancestor overflow or stacking context
  // reaches it, and the shell places it against its trigger by hand.
  const topLayerSupported = typeof HTMLElement.prototype.showPopover === "function";
  const openOverlays = new Map();
  const VIEWPORT_MARGIN = 8;

  function placeOverlay(panel, anchor, options = {}) {
    const gap = options.gap ?? 5;
    const box = anchor.getBoundingClientRect();
    panel.style.position = "fixed";
    if (options.matchWidth) panel.style.width = `${Math.round(box.width)}px`;
    panel.style.maxHeight = "";
    const natural = panel.getBoundingClientRect().height;
    const roomBelow = window.innerHeight - box.bottom - gap - VIEWPORT_MARGIN;
    const roomAbove = box.top - gap - VIEWPORT_MARGIN;
    const flip = natural > roomBelow && roomAbove > roomBelow;
    const height = Math.min(natural, Math.max(flip ? roomAbove : roomBelow, 96));
    panel.style.maxHeight = `${Math.round(height)}px`;
    panel.style.top = `${Math.round(flip ? box.top - gap - height : box.bottom + gap)}px`;
    const width = panel.getBoundingClientRect().width;
    const overflowRight = box.left + width - (window.innerWidth - VIEWPORT_MARGIN);
    const left = Math.max(VIEWPORT_MARGIN, box.left - Math.max(0, overflowRight));
    panel.style.left = `${Math.round(left)}px`;
    panel.dataset.placement = flip ? "top" : "bottom";
  }

  let overlayFrame;
  function repositionOverlays() {
    overlayFrame = undefined;
    openOverlays.forEach((entry, panel) => placeOverlay(panel, entry.anchor, entry.options));
  }
  function scheduleReposition() {
    if (!openOverlays.size || overlayFrame) return;
    overlayFrame = requestAnimationFrame(repositionOverlays);
  }
  window.addEventListener("scroll", scheduleReposition, { capture: true, passive: true });
  window.addEventListener("resize", scheduleReposition);

  function openOverlay(panel, anchor, options = {}) {
    panel.dataset.open = "true";
    if (topLayerSupported) {
      if (!panel.hasAttribute("popover")) panel.setAttribute("popover", "manual");
      if (!panel.matches(":popover-open")) panel.showPopover();
    }
    openOverlays.set(panel, { anchor, options });
    placeOverlay(panel, anchor, options);
  }

  function closeOverlay(panel) {
    openOverlays.delete(panel);
    delete panel.dataset.open;
    if (topLayerSupported && panel.matches(":popover-open")) panel.hidePopover();
  }

  // ---- declarative popover menus --------------------------------------------
  const popoverTriggers = new Map();

  function popoverItems(panel) {
    return [...panel.querySelectorAll('button, a[href], input, select, [tabindex]:not([tabindex="-1"])')]
      .filter((item) => !item.disabled && item.offsetParent !== null);
  }

  function closePopover(panel, restoreFocus = true) {
    const trigger = popoverTriggers.get(panel);
    if (!panel.dataset.open) return;
    const hadFocus = panel.contains(document.activeElement);
    closeOverlay(panel);
    trigger?.setAttribute("aria-expanded", "false");
    if (restoreFocus && hadFocus) trigger?.focus();
  }

  function closeAllPopovers(except) {
    popoverTriggers.forEach((_, panel) => { if (panel !== except) closePopover(panel, false); });
  }

  function openPopover(panel) {
    const trigger = popoverTriggers.get(panel);
    if (!trigger) return;
    closeAllPopovers(panel);
    openOverlay(panel, trigger, { gap: 6 });
    trigger.setAttribute("aria-expanded", "true");
    (popoverItems(panel)[0] || panel).focus({ preventScroll: true });
  }

  function togglePopover(panel) {
    if (panel.dataset.open) closePopover(panel);
    else openPopover(panel);
  }

  function initializePopovers(root) {
    root.querySelectorAll("[data-popover-trigger]:not([data-popover-ready])").forEach((trigger) => {
      const panel = document.getElementById(trigger.getAttribute("data-popover-trigger"));
      if (!panel) return;
      trigger.dataset.popoverReady = "true";
      trigger.setAttribute("aria-haspopup", "true");
      trigger.setAttribute("aria-expanded", "false");
      panel.classList.add("popover");
      if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
      popoverTriggers.set(panel, trigger);

      trigger.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        togglePopover(panel);
      });
      // A menu closes on the action it was opened for; opt out per item when the
      // panel is a filter panel rather than a menu.
      panel.addEventListener("click", (event) => {
        const item = event.target.closest("button, a[href]");
        if (item && panel.contains(item) && !item.hasAttribute("data-popover-keep-open")) closePopover(panel);
      });
      panel.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const items = popoverItems(panel);
        if (!items.length) return;
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        const index = items.indexOf(document.activeElement);
        items[(index + step + items.length) % items.length].focus();
      });
    });
  }

  document.addEventListener("pointerdown", (event) => {
    popoverTriggers.forEach((trigger, panel) => {
      if (!panel.dataset.open) return;
      if (panel.contains(event.target) || trigger.contains(event.target)) return;
      closePopover(panel, false);
    });
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    popoverTriggers.forEach((_, panel) => { if (panel.dataset.open) closePopover(panel); });
  });

  const selectControls = new Map();
  const sliderControls = new Map();

  function initializeSelects(root) {
    if (typeof window.Choices !== "function") return;
    root.querySelectorAll("select[data-ui-select]:not([data-ui-ready])").forEach((select) => {
      select.dataset.uiReady = "true";
      select.dataset.uiDefaultValue = select.value;
      const instance = new window.Choices(select, {
        allowHTML: false,
        itemSelectText: "",
        searchEnabled: select.dataset.search === "true",
        shouldSort: false,
      });
      select.setAttribute("aria-hidden", "true");
      selectControls.set(select, instance);

      // Choices anchors its list to the field, so a card with overflow eats it.
      // The same top-layer lift keeps every option reachable.
      const container = select.closest(".choices");
      const dropdown = container?.querySelector(".choices__list--dropdown, .choices__list[aria-expanded]");
      const field = container?.querySelector(".choices__inner");
      if (!dropdown || !field) return;
      select.addEventListener("showDropdown", () => openOverlay(dropdown, field, { matchWidth: true }));
      select.addEventListener("hideDropdown", () => closeOverlay(dropdown));
    });
  }

  function sliderFormatter(input, numericOnly) {
    const step = input.step && input.step !== "any" ? input.step : "1";
    const decimals = Number(input.dataset.decimals ?? (step.includes(".") ? step.split(".")[1].length : 0));
    return {
      to(value) {
        const number = Number(value);
        const formatted = decimals ? number.toFixed(decimals) : String(Math.round(number));
        return numericOnly ? formatted : `${input.dataset.prefix || ""}${formatted}${input.dataset.unit || ""}`;
      },
      from(value) { return Number(String(value).replace(/[^0-9.+-]/g, "")); },
    };
  }

  function initializeSliders(root) {
    if (!window.noUiSlider) return;
    root.querySelectorAll('input[type="range"][data-ui-slider]:not([data-ui-ready])').forEach((input) => {
      const output = [...document.querySelectorAll("output[for]")].find((item) => item.getAttribute("for") === input.id);
      const label = input.closest("label") || (input.id ? document.querySelector(`label[for="${input.id}"]`) : null);
      const labelText = label?.textContent.replace(output?.textContent || "", "").trim() || "Range value";
      const formatter = sliderFormatter(input, false);
      const slider = document.createElement("div");
      slider.className = "ui-range-control";
      input.after(slider);
      const options = {
        animate: !prefersReducedMotion(),
        animationDuration: 220,
        ariaFormat: formatter,
        connect: "lower",
        handleAttributes: [{ "aria-label": labelText }],
        keyboardSupport: true,
        range: { min: Number(input.min || 0), max: Number(input.max || 100) },
        start: Number(input.value),
        step: input.step && input.step !== "any" ? Number(input.step) : 1,
        tooltips: formatter,
      };
      const pipCount = Number(input.dataset.pips || 0);
      if (pipCount > 1) options.pips = { mode: "count", values: pipCount, density: 12, format: sliderFormatter(input, true) };
      window.noUiSlider.create(slider, options);
      input.dataset.uiReady = "true";
      input.classList.add("is-enhanced");
      input.hidden = true;
      label?.addEventListener("click", (event) => {
        event.preventDefault();
        slider.querySelector(".noUi-handle")?.focus();
      });
      slider.noUiSlider.on("update", (values) => {
        const value = Number(values[0]);
        input.value = String(value);
        if (output) {
          output.value = formatter.to(value);
          output.textContent = formatter.to(value);
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      slider.noUiSlider.on("set", () => input.dispatchEvent(new Event("change", { bubbles: true })));
      input.addEventListener("input", () => {
        if (Number(slider.noUiSlider.get()) !== Number(input.value)) slider.noUiSlider.set(input.value);
      });
      sliderControls.set(input, slider.noUiSlider);
    });
  }

  // A narrow table stacks each row into labelled lines, and the label has to come
  // from the column heading. The shell copies it onto every cell so report markup
  // stays a plain <table> with no per-cell label attribute to keep in sync.
  function labelTableCells(root = document) {
    root.querySelectorAll("table").forEach((table) => {
      const headings = Array.from(table.querySelectorAll("thead tr:last-of-type th"), (th) => th.textContent.trim());
      if (!headings.length) return;
      table.querySelectorAll("tbody tr").forEach((row) => {
        Array.from(row.cells).forEach((cell, index) => {
          // A spanning cell (empty state, total) belongs to no single column.
          if (cell.colSpan > 1) return;
          const label = headings[index];
          if (label) cell.setAttribute("data-dev3-label", label);
        });
      });
    });
  }

  let queuedLabelPass = 0;
  function scheduleTableLabels() {
    if (queuedLabelPass) return;
    queuedLabelPass = requestAnimationFrame(() => {
      queuedLabelPass = 0;
      labelTableCells();
    });
  }

  function enhanceControls(root = document) {
    initializePopovers(root);
    initializeSelects(root);
    initializeSliders(root);
    labelTableCells(root);
  }

  function setControlValue(control, value) {
    if (!control) return;
    const slider = sliderControls.get(control);
    if (slider) {
      slider.set(value);
      return;
    }
    control.value = String(value);
    selectControls.get(control)?.setChoiceByValue(String(value));
    control.dispatchEvent(new Event(control.type === "range" ? "input" : "change", { bubbles: true }));
  }

  document.addEventListener("reset", (event) => {
    const form = event.target;
    requestAnimationFrame(() => {
      selectControls.forEach((instance, select) => {
        if (!form.contains(select)) return;
        select.value = select.dataset.uiDefaultValue;
        instance.setChoiceByValue(select.dataset.uiDefaultValue);
      });
      sliderControls.forEach((instance, input) => { if (form.contains(input)) instance.set(input.value); });
    });
  });

  function registerDev3ChartTheme() {
    if (!chartsAvailable) return;
    appliedChartTheme = document.documentElement.dataset.theme;
    const axisLabel = { color: tokenColor("--dev3-text-muted"), fontSize: scaledFont(12) };
    const softSplit = { lineStyle: { color: tokenColor("--dev3-border", .6) } };
    window.echarts.registerTheme("dev3", {
      // Categorical, never semantic: the old default painted series three yellow
      // and series four red, so a chart claimed a warning and a failure purely
      // from series order. The viz ramp sits at one lightness, so no series
      // outshouts its neighbours either.
      color: [
        tokenColor("--dev3-viz-1"), tokenColor("--dev3-viz-2"), tokenColor("--dev3-viz-3"),
        tokenColor("--dev3-viz-4"), tokenColor("--dev3-viz-5"), tokenColor("--dev3-viz-6"),
      ],
      backgroundColor: "transparent",
      textStyle: { fontFamily: CHART_FONT, color: tokenColor("--dev3-text-secondary"), fontSize: scaledFont(12) },
      categoryAxis: { axisLine: { lineStyle: { color: tokenColor("--dev3-border") } }, axisTick: { show: false }, axisLabel, splitLine: { show: false } },
      valueAxis: { axisLine: { show: false }, axisTick: { show: false }, axisLabel, splitLine: softSplit },
      legend: { textStyle: { color: tokenColor("--dev3-text-secondary"), fontSize: scaledFont(11) }, itemWidth: 14, itemHeight: 9 },
      radar: { axisName: { color: tokenColor("--dev3-text-muted"), fontSize: scaledFont(10) }, axisLine: { lineStyle: { color: tokenColor("--dev3-border") } }, splitLine: softSplit, splitArea: { show: false } },
    });
  }

  function syncChartViewBox(element) {
    const svg = element.querySelector("svg");
    if (svg) svg.setAttribute("viewBox", `0 0 ${svg.getAttribute("width")} ${svg.getAttribute("height")}`);
  }

  // A chart option is the one place a size is written as a raw number, so report
  // code would otherwise keep its own labels at 100% while the page grew. The
  // shell rescales every `fontSize` it finds instead, without touching the
  // author's object: plain branches are copied, everything else (functions,
  // primitive data arrays) is carried over by reference.
  function isOptionBranch(value) {
    if (Array.isArray(value)) return true;
    if (!value || typeof value !== "object") return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function scaleOptionFonts(value) {
    if (Array.isArray(value)) return value.some(isOptionBranch) ? value.map(scaleOptionFonts) : value;
    if (!isOptionBranch(value)) return value;
    const scaled = {};
    Object.entries(value).forEach(([key, item]) => {
      scaled[key] = key === "fontSize" && typeof item === "number" ? scaledFont(item) : scaleOptionFonts(item);
    });
    return scaled;
  }

  function chartShellOption(option) {
    return scaleOptionFonts({
      // ECharts derives label contrast from the canvas background. Left
      // transparent it assumes white paper and paints every value label dark
      // grey inside a 2px white halo — illegible on the dark theme. Naming the
      // card surface it actually sits on keeps labels readable in both themes.
      backgroundColor: tokenColor("--dev3-surface-raised"),
      ...option,
      animation: prefersReducedMotion() ? false : option.animation ?? true,
      aria: { enabled: true, ...(option.aria || {}) },
      tooltip: {
        backgroundColor: tokenColor("--dev3-surface-elevated"),
        borderColor: tokenColor("--dev3-border"),
        textStyle: { color: tokenColor("--dev3-text-primary"), fontSize: 12 },
        ...(option.tooltip || {}),
      },
    });
  }

  // Misuse throws here with the fix in the message. Left to ECharts, an id string
  // surfaces as `t.appendChild is not a function` from minified library code, and
  // an argument passed to update()/remount() is silently ignored — both cost a
  // debug loop because neither says what to write instead.
  function assertNoArgument(name, args) {
    if (args.length === 0) return;
    throw new TypeError(`dev3Artifact.chart(...).${name}() takes no arguments — it re-reads the option factory passed to chart(). Update the data your factory reads, then call ${name}().`);
  }

  function dev3Chart(element, optionFactory) {
    if (typeof element === "string") {
      throw new TypeError(`dev3Artifact.chart(element, optionFactory) needs an element, not an id — pass document.getElementById("${element}").`);
    }
    // Offline and missing-host handles keep the argument guard: an author who hits
    // the misuse while cdnjs is unreachable must still be told, not silently no-opped.
    const unavailable = {
      chart: null,
      update() { assertNoArgument("update", arguments); },
      resize() {},
      remount() { assertNoArgument("remount", arguments); },
    };
    if (!element) return unavailable;
    if (!chartsAvailable) {
      element.innerHTML = '<div class="chart-unavailable">Charts need network access to cdnjs.cloudflare.com — reconnect and reload.</div>';
      return unavailable;
    }
    const factory = typeof optionFactory === "function" ? optionFactory : () => optionFactory;
    const entry = {
      chart: null,
      update() {
        assertNoArgument("update", arguments);
        entry.chart.setOption(chartShellOption(factory()));
        syncChartViewBox(element);
      },
      resize() {
        const bounds = element.getBoundingClientRect();
        entry.chart.resize({ width: Math.round(bounds.width), height: Math.round(bounds.height) });
        syncChartViewBox(element);
      },
      remount() {
        assertNoArgument("remount", arguments);
        if (entry.chart) entry.chart.dispose();
        entry.chart = window.echarts.init(element, "dev3", { renderer: "svg" });
        entry.update();
      },
    };
    entry.remount();
    new ResizeObserver(() => entry.resize()).observe(element);
    dev3ChartRegistry.add(entry);
    return entry;
  }

  function rethemeDev3Charts() {
    registerDev3ChartTheme();
    dev3ChartRegistry.forEach((entry) => entry.remount());
  }

  new MutationObserver(() => {
    const theme = document.documentElement.dataset.theme;
    if (theme === appliedChartTheme) return;
    appliedChartTheme = theme;
    rethemeDev3Charts();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const printClosedDetails = new Set();
  window.addEventListener("beforeprint", () => {
    closeAllPopovers();
    document.querySelectorAll("details:not([open])").forEach((detail) => {
      printClosedDetails.add(detail);
      detail.open = true;
    });
    document.documentElement.classList.add("printing");
    // Flush compact print heights before ECharts measures its containers.
    void document.body.offsetHeight;
    dev3ChartRegistry.forEach((entry) => {
      entry.chart.dispatchAction({ type: "hideTip" });
      entry.resize();
    });
  });
  window.addEventListener("afterprint", () => {
    document.documentElement.classList.remove("printing");
    printClosedDetails.forEach((detail) => { detail.open = false; });
    printClosedDetails.clear();
    dev3ChartRegistry.forEach((entry) => entry.resize());
  });

  registerDev3ChartTheme();
  initializeNavigation();
  trackStickyOffset();
  initializeSortIndicators();
  enhanceControls();

  // report.js renders and re-renders rows after the shell has run, so relabel
  // whenever a table's contents change. childList only — writing the attribute
  // must not retrigger the pass. A report usually writes the whole table at once
  // into a plain host div, and then the mutation target is that div, not a cell.
  function recordTouchesTable(record) {
    if (record.target instanceof Element && record.target.closest("table")) return true;
    return Array.from(record.addedNodes).some(
      (node) => node instanceof Element && (node.matches("table") || node.querySelector("table")),
    );
  }

  new MutationObserver((records) => {
    if (records.some(recordTouchesTable)) scheduleTableLabels();
  }).observe(document.body, { childList: true, subtree: true });

  // ---- generic shell controls -----------------------------------------------
  let themeMode = "auto";
  let hostTheme = document.documentElement.dataset.theme || "dark";
  const artifactTheme = document.getElementById("artifactTheme");
  const toast = document.getElementById("toast");

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(window.toastTimer);
    window.toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
  }

  function applyArtifactTheme() {
    const theme = themeMode === "auto" ? hostTheme : themeMode;
    document.documentElement.dataset.theme = theme;
    if (!artifactTheme) return;
    artifactTheme.textContent = themeMode === "auto" ? "◐ Auto" : themeMode === "light" ? "☀ Light" : "☾ Dark";
    artifactTheme.title = themeMode === "auto" ? "Theme: Follow host" : `Theme: ${themeMode}`;
    showToast(themeMode === "auto" ? "Following the host theme" : `Artifact theme: ${themeMode}`);
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type !== "dev3-artifact-theme") return;
    hostTheme = event.data.theme;
    if (themeMode === "auto") document.documentElement.dataset.theme = hostTheme;
  });
  artifactTheme?.addEventListener("click", () => {
    themeMode = themeMode === "auto" ? "light" : themeMode === "light" ? "dark" : "auto";
    applyArtifactTheme();
  });

  function applyFontScale(options = {}) {
    const scale = fontScale();
    const percent = `${Math.round(scale * 100)}%`;
    document.documentElement.style.setProperty("--dev3-font-scale-user", String(scale));
    document.querySelectorAll("[data-font-step]").forEach((button) => {
      const step = Number(button.dataset.fontStep);
      if (step === 0) {
        button.textContent = percent;
        button.disabled = fontScaleIndex === DEFAULT_FONT_SCALE_INDEX;
        return;
      }
      button.disabled = FONT_SCALE_STEPS[fontScaleIndex + step] === undefined;
    });
    if (options.announce) showToast(`Text size ${percent}`);
    if (options.persist) {
      try { localStorage.setItem(FONT_SCALE_KEY, String(scale)); } catch {}
    }
    // Chart labels are px numbers rather than rem, sticky offsets are measured in
    // px, and an open menu was placed against a trigger that just changed size.
    rethemeDev3Charts();
    applyStickyOffset();
    scheduleReposition();
  }

  function stepFontScale(step) {
    const next = step === 0 ? DEFAULT_FONT_SCALE_INDEX : fontScaleIndex + step;
    if (FONT_SCALE_STEPS[next] === undefined || next === fontScaleIndex) return;
    fontScaleIndex = next;
    applyFontScale({ announce: true, persist: true });
  }

  document.querySelectorAll("[data-font-step]").forEach((button) => {
    button.addEventListener("click", () => stepFontScale(Number(button.dataset.fontStep)));
  });
  applyFontScale();

  // Report code that builds a panel after load registers it the same way the
  // markup does, so a dynamic menu gets the same top layer and dismissal.
  function popoverApi(panelOrId, anchor) {
    const panel = typeof panelOrId === "string" ? document.getElementById(panelOrId) : panelOrId;
    if (!panel) return { open() {}, close() {}, toggle() {}, get isOpen() { return false; } };
    if (anchor) {
      panel.classList.add("popover");
      if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
      popoverTriggers.set(panel, anchor);
      if (!panel.dataset.popoverReady) {
        panel.dataset.popoverReady = "true";
        panel.addEventListener("click", (event) => {
          const item = event.target.closest("button, a[href]");
          if (item && panel.contains(item) && !item.hasAttribute("data-popover-keep-open")) closePopover(panel);
        });
      }
    }
    return {
      open: () => openPopover(panel),
      close: () => closePopover(panel),
      toggle: () => togglePopover(panel),
      get isOpen() { return Boolean(panel.dataset.open); },
    };
  }

  // ---- local assets ---------------------------------------------------------
  // The in-app viewer rewrites asset references by scanning the stored HTML, so a
  // src built by report code is never rewritten and resolves to nothing inside the
  // opaque-origin iframe. The viewer publishes its resolved map instead; over
  // file:// and in the downloaded ZIP there is no map and the path is already right.
  function assetUrl(path) {
    if (typeof path !== "string" || !path) return path;
    const map = window.__dev3ArtifactAssets;
    if (!map) return path;
    const clean = path.trim().split(/[?#]/)[0];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(clean)) return path;
    const segments = [];
    for (const segment of clean.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") { segments.pop(); continue; }
      segments.push(segment);
    }
    return map[segments.join("/")] || path;
  }

  window.dev3Artifact = Object.freeze({
    asset: assetUrl,
    chart: dev3Chart,
    color: tokenColor,
    enhance: enhanceControls,
    fontScale,
    popover: popoverApi,
    scaleFont: scaledFont,
    setControl: setControlValue,
    toast: showToast,
  });
})();

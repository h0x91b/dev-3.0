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
  function trackStickyOffset() {
    const nav = document.querySelector(".section-nav");
    const apply = () => {
      const offset = nav ? Math.round(nav.getBoundingClientRect().height) : 0;
      document.documentElement.style.setProperty("--dev3-table-head-top", `${offset}px`);
    };
    apply();
    window.addEventListener("resize", apply);
  }

  // Report code owns sorting; the shell owns only the visible sort state, so
  // every artifact shows which column is sorted and in which direction.
  function initializeSortIndicators() {
    document.querySelectorAll("thead").forEach((head) => {
      const headings = [...head.querySelectorAll("th[data-sort]")];
      if (!headings.length) return;
      const mark = (heading) => {
        const next = heading.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
        headings.forEach((item) => item.removeAttribute("aria-sort"));
        heading.setAttribute("aria-sort", next);
      };
      headings.forEach((heading) => {
        heading.addEventListener("click", () => mark(heading));
        heading.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") mark(heading);
        });
      });
    });
  }

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

  function enhanceControls(root = document) {
    initializeSelects(root);
    initializeSliders(root);
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
    const axisLabel = { color: tokenColor("--dev3-text-muted") };
    const softSplit = { lineStyle: { color: tokenColor("--dev3-border", .6) } };
    window.echarts.registerTheme("dev3", {
      color: [tokenColor("--dev3-accent"), tokenColor("--dev3-success"), tokenColor("--dev3-warning"), tokenColor("--dev3-danger"), tokenColor("--dev3-text-secondary")],
      backgroundColor: "transparent",
      textStyle: { fontFamily: CHART_FONT, color: tokenColor("--dev3-text-secondary") },
      categoryAxis: { axisLine: { lineStyle: { color: tokenColor("--dev3-border") } }, axisTick: { show: false }, axisLabel, splitLine: { show: false } },
      valueAxis: { axisLine: { show: false }, axisTick: { show: false }, axisLabel, splitLine: softSplit },
      legend: { textStyle: { color: tokenColor("--dev3-text-secondary"), fontSize: 11 }, itemWidth: 14, itemHeight: 9 },
      radar: { axisName: { color: tokenColor("--dev3-text-muted"), fontSize: 10 }, axisLine: { lineStyle: { color: tokenColor("--dev3-border") } }, splitLine: softSplit, splitArea: { show: false } },
    });
  }

  function syncChartViewBox(element) {
    const svg = element.querySelector("svg");
    if (svg) svg.setAttribute("viewBox", `0 0 ${svg.getAttribute("width")} ${svg.getAttribute("height")}`);
  }

  function chartShellOption(option) {
    return {
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
    };
  }

  function dev3Chart(element, optionFactory) {
    const unavailable = { chart: null, update() {}, resize() {}, remount() {} };
    if (!element) return unavailable;
    if (!chartsAvailable) {
      element.innerHTML = '<div class="chart-unavailable">Charts need network access to cdnjs.cloudflare.com — reconnect and reload.</div>';
      return unavailable;
    }
    const factory = typeof optionFactory === "function" ? optionFactory : () => optionFactory;
    const entry = {
      chart: null,
      update() {
        entry.chart.setOption(chartShellOption(factory()));
        syncChartViewBox(element);
      },
      resize() {
        const bounds = element.getBoundingClientRect();
        entry.chart.resize({ width: Math.round(bounds.width), height: Math.round(bounds.height) });
        syncChartViewBox(element);
      },
      remount() {
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

  window.dev3Artifact = Object.freeze({
    chart: dev3Chart,
    color: tokenColor,
    enhance: enhanceControls,
    setControl: setControlValue,
    toast: showToast,
  });
})();

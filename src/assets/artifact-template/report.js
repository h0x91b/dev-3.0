(function () {
  const report = {
    velocity: {
      initialPeriod: 30,
      seriesName: "Tasks completed",
      unit: "tasks",
      datasets: {
        7: [12, 18, 15, 24, 21, 29, 35],
        30: [9, 14, 12, 18, 22, 19, 28, 31, 26, 38, 42, 39],
        90: [8, 12, 10, 15, 14, 19, 17, 24, 22, 27, 31, 29, 35, 39, 37, 44],
      },
    },
    pipeline: {
      seriesName: "Pipeline",
      labels: ["Running", "Review", "Blocked"],
      initialShare: [62, 24, 14],
    },
    capability: {
      labels: ["Speed", "Quality", "Autonomy", "Coverage", "Efficiency", "Predictability"],
      currentLabel: "Current scenario",
      targetLabel: "Target",
      initialValues: [78, 82, 68, 88, 75, 72],
      targetValues: [82, 88, 80, 86, 84, 82],
    },
    runs: [
      { name: "Artifact workspace", status: "Shipped", agent: "Codex · Sol", progress: 100, cycle: "18m" },
      { name: "Remote mobile QA", status: "Review", agent: "Claude · Opus", progress: 88, cycle: "31m" },
      { name: "CLI error taxonomy", status: "Running", agent: "Codex · Terra", progress: 67, cycle: "24m" },
      { name: "Updater dependency audit", status: "Shipped", agent: "Claude · Sonnet", progress: 100, cycle: "42m" },
      { name: "Git race reproducer", status: "Review", agent: "Codex · Luna", progress: 92, cycle: "27m" },
      { name: "Theme contrast sweep", status: "Running", agent: "Codex · Sol", progress: 54, cycle: "16m" },
    ],
    gallery: {
      hours: ["8a", "9a", "10a", "11a", "12p", "1p", "2p", "3p", "4p", "5p", "6p", "7p"],
      days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      heatmapUnit: "runs",
      sankeyNodes: [
        { name: "Backlog", token: "--dev3-text-muted" },
        { name: "Planned", token: "--dev3-accent", alpha: .55 },
        { name: "In progress", token: "--dev3-accent" },
        { name: "Review", token: "--dev3-warning" },
        { name: "Shipped", token: "--dev3-success" },
        { name: "Rework", token: "--dev3-warning", alpha: .7 },
        { name: "Blocked", token: "--dev3-danger" },
      ],
      sankeyLinks: [
        { source: "Backlog", target: "Planned", value: 34 },
        { source: "Backlog", target: "Blocked", value: 4 },
        { source: "Planned", target: "In progress", value: 30 },
        { source: "In progress", target: "Review", value: 26 },
        { source: "In progress", target: "Blocked", value: 4 },
        { source: "Review", target: "Shipped", value: 22 },
        { source: "Review", target: "Rework", value: 4 },
      ],
      sunburst: [
        { name: "App", children: [{ name: "UI", value: 14 }, { name: "State", value: 8 }, { name: "RPC", value: 6 }] },
        { name: "CLI", children: [{ name: "Commands", value: 9 }, { name: "Hooks", value: 5 }] },
        { name: "Infra", children: [{ name: "CI", value: 6 }, { name: "Release", value: 4 }] },
      ],
      gauge: { value: 94, name: "Agent success" },
    },
  };

  const { chart: dev3Chart, color: tokenColor, toast: showToast } = window.dev3Artifact;
  const datasets = report.velocity.datasets;
  const runs = report.runs;
  let velocityValues = datasets[report.velocity.initialPeriod];
  let pipelineShare = [...report.pipeline.initialShare];
  let capabilityValues = [...report.capability.initialValues];
  let currentPeriod = report.velocity.initialPeriod;
  let sortKey = "name";
  let sortDirection = 1;

  const refresh = document.getElementById("refresh");
  const shipped = document.getElementById("shipped");
  const success = document.getElementById("success");
  const cycle = document.getElementById("cycle");
  const queue = document.getElementById("queue");
  const search = document.getElementById("search");
  const statusFilter = document.getElementById("statusFilter");
  const runRows = document.getElementById("runRows");
  const empty = document.getElementById("empty");

  // ---- charts ---------------------------------------------------------------
  const velocityChart = dev3Chart(document.getElementById("velocityChart"), () => ({
    grid: { left: 40, right: 16, top: 28, bottom: 26 },
    tooltip: { trigger: "axis", valueFormatter: (value) => `${value} ${report.velocity.unit}` },
    xAxis: { type: "category", boundaryGap: false, data: velocityValues.map((_, index) => String(index + 1)) },
    yAxis: { type: "value" },
    series: [{
      name: report.velocity.seriesName,
      type: "line",
      smooth: true,
      symbol: "circle",
      symbolSize: 7,
      lineStyle: { width: 3 },
      areaStyle: {
        color: {
          type: "linear", x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: tokenColor("--dev3-accent", .3) },
            { offset: 1, color: tokenColor("--dev3-accent", 0) },
          ],
        },
      },
      data: velocityValues,
    }],
  }));

  const pipelinePie = dev3Chart(document.getElementById("pipelinePie"), () => ({
    color: [tokenColor("--dev3-accent"), tokenColor("--dev3-warning"), tokenColor("--dev3-danger")],
    tooltip: { trigger: "item", formatter: "{b}: {c}%" },
    legend: { bottom: 0, icon: "circle" },
    series: [{
      name: report.pipeline.seriesName,
      type: "pie",
      radius: ["52%", "76%"],
      center: ["50%", "42%"],
      itemStyle: { borderColor: tokenColor("--dev3-surface-raised"), borderWidth: 3, borderRadius: 7 },
      label: { show: false, position: "center" },
      labelLine: { show: false },
      emphasis: { label: { show: true, fontSize: 16, fontWeight: 700, color: tokenColor("--dev3-text-primary"), formatter: "{b}\n{c}%" } },
      data: [
        { name: report.pipeline.labels[0], value: pipelineShare[0] },
        { name: report.pipeline.labels[1], value: pipelineShare[1] },
        { name: report.pipeline.labels[2], value: pipelineShare[2] },
      ],
    }],
  }));

  const capabilityRadar = dev3Chart(document.getElementById("capabilityRadar"), () => ({
    tooltip: {},
    legend: { bottom: 0, icon: "roundRect" },
    radar: { indicator: report.capability.labels.map((name) => ({ name, max: 100 })), radius: "64%", center: ["50%", "46%"] },
    series: [{
      type: "radar",
      symbol: "circle",
      symbolSize: 5,
      data: [
        { name: report.capability.currentLabel, value: capabilityValues, lineStyle: { width: 3 }, areaStyle: { opacity: .22 } },
        { name: report.capability.targetLabel, value: report.capability.targetValues, symbol: "none", lineStyle: { type: "dashed", width: 2, color: tokenColor("--dev3-success") }, itemStyle: { color: tokenColor("--dev3-success") } },
      ],
    }],
  }));

  // ---- chart gallery --------------------------------------------------------
  const galleryHours = report.gallery.hours;
  const galleryDays = report.gallery.days;
  let galleryType = "heatmap";

  const galleryOptions = {
    heatmap: () => ({
      grid: { left: 44, right: 16, top: 14, bottom: 44 },
      tooltip: { position: "top", formatter: (point) => `${galleryDays[point.value[1]]} ${galleryHours[point.value[0]]}: ${point.value[2]} ${report.gallery.heatmapUnit}` },
      xAxis: { type: "category", data: galleryHours },
      yAxis: { type: "category", data: galleryDays },
      visualMap: {
        min: 0, max: 10, orient: "horizontal", left: "center", bottom: 0,
        itemWidth: 10, itemHeight: 90,
        textStyle: { color: tokenColor("--dev3-text-muted"), fontSize: 10 },
        inRange: { color: [tokenColor("--dev3-accent", .06), tokenColor("--dev3-accent")] },
      },
      series: [{
        type: "heatmap",
        itemStyle: { borderColor: tokenColor("--dev3-surface-raised"), borderWidth: 2, borderRadius: 3 },
        data: galleryDays.flatMap((_, day) => galleryHours.map((_, hour) => [hour, day, (day * 5 + hour * 7 + 3) % 11])),
      }],
    }),
    sankey: () => ({
      tooltip: { trigger: "item" },
      series: [{
        type: "sankey",
        left: 12, right: 80, top: 14, bottom: 14,
        nodeGap: 14,
        lineStyle: { color: "gradient", opacity: .25, curveness: .5 },
        itemStyle: { borderRadius: 4 },
        label: { color: tokenColor("--dev3-text-secondary"), fontSize: 11 },
        data: report.gallery.sankeyNodes.map(({ name, token, alpha }) => ({
          name,
          itemStyle: { color: tokenColor(token, alpha) },
        })),
        links: report.gallery.sankeyLinks,
      }],
    }),
    sunburst: () => ({
      tooltip: { trigger: "item", formatter: "{b}: {c}" },
      series: [{
        type: "sunburst",
        radius: ["18%", "90%"],
        itemStyle: { borderColor: tokenColor("--dev3-surface-raised"), borderWidth: 2, borderRadius: 6 },
        label: { fontSize: 10, minAngle: 14 },
        data: report.gallery.sunburst,
      }],
    }),
    gauge: () => ({
      series: [{
        type: "gauge",
        startAngle: 210, endAngle: -30, min: 0, max: 100,
        progress: { show: true, width: 14, roundCap: true },
        axisLine: { lineStyle: { width: 14, color: [[1, tokenColor("--dev3-border", .55)]] } },
        axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false }, pointer: { show: false }, anchor: { show: false },
        title: { offsetCenter: [0, "30%"], color: tokenColor("--dev3-text-secondary"), fontSize: 12 },
        detail: { offsetCenter: [0, "-6%"], formatter: "{value}%", color: tokenColor("--dev3-text-primary"), fontSize: 30, fontWeight: 700, valueAnimation: true },
        itemStyle: { color: tokenColor("--dev3-accent") },
        data: [report.gallery.gauge],
      }],
    }),
  };

  const galleryChart = dev3Chart(document.getElementById("galleryChart"), () => galleryOptions[galleryType]());

  document.getElementById("galleryTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-gallery]");
    if (!button) return;
    galleryType = button.dataset.gallery;
    document.querySelectorAll("[data-gallery]").forEach((item) => item.classList.toggle("active", item === button));
    galleryChart.remount();
  });

  // ---- table and scenario ---------------------------------------------------
  function statusClass(status) {
    return status === "Shipped" ? "success" : status === "Review" ? "warning" : "accent";
  }

  function renderTable() {
    if (!search || !statusFilter || !runRows || !empty) return;
    const query = search.value.toLowerCase();
    const filter = statusFilter.value;
    const shown = runs
      .filter((run) => (filter === "all" || run.status === filter) && run.name.toLowerCase().includes(query))
      .sort((a, b) => String(a[sortKey]).localeCompare(String(b[sortKey]), undefined, { numeric: true }) * sortDirection);
    runRows.innerHTML = shown.map((run) => `<tr><td><strong>${run.name}</strong></td><td><span class="pill ${statusClass(run.status)}">${run.status}</span></td><td>${run.agent}</td><td><div class="bar-cell"><div class="mini-track"><div class="mini-fill" style="width:${run.progress}%"></div></div><span>${run.progress}%</span></div></td><td>${run.cycle}</td></tr>`).join("");
    empty.hidden = shown.length > 0;
  }

  function scenarioRadar(risk, agentCount) {
    return [
      Math.min(98, 54 + agentCount * 3 + risk * 2),
      Math.max(48, 96 - risk * 3),
      Math.min(96, 48 + agentCount * 4 + risk),
      Math.max(52, 91 - risk * 2),
      Math.min(97, 58 + agentCount * 2 + risk * 2),
      Math.max(45, 94 - risk * 3 + agentCount),
    ];
  }

  function simulate() {
    const riskInput = document.getElementById("risk");
    const agentsInput = document.getElementById("agents");
    if (!riskInput || !agentsInput) return;
    const risk = Number(riskInput.value);
    const agentCount = Number(agentsInput.value.split(" ")[0]);
    if (shipped) shipped.textContent = 118 + risk * agentCount;
    if (success) success.textContent = `${(97.2 - risk * .45).toFixed(1)}%`;
    if (cycle) cycle.textContent = `${Math.max(9, 30 - agentCount - risk)}m`;
    if (queue) queue.textContent = Math.max(2, 12 - risk);
    const running = Math.min(78, 50 + risk * 2);
    const review = Math.min(94, running + 22);
    velocityValues = datasets[currentPeriod].map((value, index) => Math.round(value * (.82 + risk * .035) + (index % 3) * agentCount / 3));
    pipelineShare = [running, review - running, 100 - review];
    capabilityValues = scenarioRadar(risk, agentCount);
    velocityChart.update();
    pipelinePie.update();
    capabilityRadar.update();
    showToast(`Scenario recalculated with ${agentCount} agents`);
  }

  document.getElementById("periods")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-period]");
    if (!button) return;
    currentPeriod = Number(button.dataset.period);
    document.querySelectorAll("[data-period]").forEach((item) => item.classList.toggle("active", item === button));
    velocityValues = datasets[currentPeriod];
    velocityChart.remount();
    showToast(`${currentPeriod} day window loaded`);
  });

  document.getElementById("scenarioForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    simulate();
  });
  document.getElementById("scenarioForm")?.addEventListener("reset", () => {
    setTimeout(() => {
      showToast("Scenario reset");
    }, 0);
  });
  document.getElementById("runTop")?.addEventListener("click", simulate);
  refresh?.addEventListener("click", () => {
    refresh.textContent = "↻ Refreshing…";
    setTimeout(() => {
      refresh.textContent = "↻ Refresh";
      showToast("Live data refreshed");
    }, 650);
  });
  search?.addEventListener("input", renderTable);
  statusFilter?.addEventListener("change", renderTable);
  document.querySelectorAll("th[data-sort]").forEach((heading) => {
    const sort = () => {
      sortDirection = sortKey === heading.dataset.sort ? -sortDirection : 1;
      sortKey = heading.dataset.sort;
      renderTable();
    };
    heading.addEventListener("click", sort);
    heading.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      sort();
    });
  });

  renderTable();
})();

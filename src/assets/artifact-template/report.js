(function () {
  // Report data and behaviour live here; the shell (app.js) already owns the
  // theme, text size, navigation, table sorting and stacking. A static report
  // can leave this file as an empty IIFE.
  const report = {
    runs: ["run 1", "run 2", "run 3", "run 4", "run 5"],
    failures: [12, 9, 4, 4, 0],
  };

  const { chart, color } = window.dev3Artifact;

  // chart(element, optionFactory): the factory is re-read on theme and text-size
  // changes, so it reads the data it closes over instead of receiving it.
  const host = document.getElementById("trendChart");
  if (host) {
    chart(host, () => ({
      grid: { left: 36, right: 12, top: 20, bottom: 28 },
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: report.runs },
      yAxis: { type: "value", minInterval: 1 },
      series: [{
        name: "Failures",
        type: "bar",
        data: report.failures,
        itemStyle: { color: color("--dev3-viz-4"), borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: "top", fontSize: 11 },
      }],
    }));
  }
})();

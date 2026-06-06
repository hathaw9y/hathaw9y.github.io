(function () {
  function isWaveDromCode(code) {
    return /\blanguage-(wavedrom|wavejson)\b/i.test(code.className);
  }

  function getBlockContainer(code) {
    var highlight = code.closest("div.highlight");

    if (highlight) {
      return highlight;
    }

    return code.closest("pre");
  }

  function createDiagram(code) {
    var wrapper = document.createElement("div");
    var source = document.createElement("script");

    wrapper.className = "wavedrom-diagram";
    source.type = "WaveDrom";
    source.text = code.textContent;
    wrapper.appendChild(source);

    return wrapper;
  }

  function renderWaveDromBlocks() {
    if (!window.WaveDrom || typeof window.WaveDrom.ProcessAll !== "function") {
      return;
    }

    document.querySelectorAll("pre > code").forEach(function (code) {
      var container;
      var diagram;

      if (!isWaveDromCode(code) || code.dataset.wavedrom === "rendered") {
        return;
      }

      container = getBlockContainer(code);

      if (!container) {
        return;
      }

      code.dataset.wavedrom = "rendered";
      diagram = createDiagram(code);
      container.parentNode.replaceChild(diagram, container);
    });

    window.WaveDrom.ProcessAll();
  }

  document.addEventListener("DOMContentLoaded", renderWaveDromBlocks);
})();

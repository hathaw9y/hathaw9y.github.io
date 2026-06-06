(function () {
  var svKeywords = [
    "alias", "always", "always_comb", "always_ff", "always_latch", "and", "assign", "automatic",
    "begin", "bind", "bins", "binsof", "bit", "break", "buf", "bufif0", "bufif1", "case", "casex",
    "casez", "cell", "chandle", "class", "clocking", "config", "const", "constraint", "context",
    "continue", "cover", "covergroup", "coverpoint", "cross", "deassign", "default", "defparam",
    "design", "disable", "dist", "do", "edge", "else", "end", "endcase", "endclass", "endclocking",
    "endconfig", "endfunction", "endgenerate", "endgroup", "endinterface", "endmodule", "endpackage",
    "endprimitive", "endprogram", "endproperty", "endspecify", "endsequence", "endtable", "endtask",
    "enum", "event", "expect", "export", "extends", "extern", "final", "first_match", "for",
    "force", "foreach", "forever", "fork", "forkjoin", "function", "generate", "genvar", "global",
    "if", "iff", "ifnone", "ignore_bins", "illegal_bins", "import", "incdir", "include", "initial",
    "inout", "inside", "instance", "interface", "intersect", "join", "join_any", "join_none",
    "large", "liblist", "library", "local", "localparam", "macromodule", "matches", "medium",
    "modport", "module", "nand", "negedge", "new", "nmos", "nor", "not", "notif0", "notif1",
    "or", "package", "packed", "parameter", "pmos", "posedge", "primitive", "priority", "program",
    "property", "protected", "pull0", "pull1", "pulldown", "pullup", "pulsestyle_ondetect",
    "pulsestyle_onevent", "pure", "rand", "randc", "randcase", "randsequence", "rcmos", "real",
    "ref", "release", "repeat", "return", "rnmos", "rpmos", "rtran", "rtranif0", "rtranif1",
    "scalared", "sequence", "shortreal", "showcancelled", "signed", "small", "solve", "specify",
    "specparam", "static", "strong0", "strong1", "struct", "super", "table", "tagged", "task",
    "this", "throughout", "time", "timeprecision", "timeunit", "tran", "tranif0", "tranif1",
    "tri", "tri0", "tri1", "triand", "trior", "trireg", "union", "unique", "unsigned", "use",
    "uwire", "vectored", "virtual", "void", "wait", "wait_order", "wand", "weak0", "weak1",
    "while", "wildcard", "wire", "with", "within", "wor", "xnor", "xor"
  ];
  var svTypes = [
    "byte", "integer", "int", "logic", "longint", "reg", "shortint", "shortreal", "string"
  ];
  var svKeywordMap = toLookup(svKeywords);
  var svTypeMap = toLookup(svTypes);

  function toLookup(words) {
    return words.reduce(function (lookup, word) {
      lookup[word] = true;
      return lookup;
    }, {});
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function span(className, text) {
    return '<span class="' + className + '">' + escapeHtml(text) + "</span>";
  }

  function isSystemVerilogCode(code) {
    return /\blanguage-(sv|systemverilog)\b/i.test(code.className);
  }

  function isWaveDromCode(code) {
    return /\blanguage-(wavedrom|wavejson)\b/i.test(code.className);
  }

  function highlightSystemVerilog(text) {
    var tokenPattern = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:'[sS]?[bBoOdDhH][0-9a-fA-F_xzXZ?]+)?\b|\$?[A-Za-z_][A-Za-z0-9_$]*|[=!<>+\-*\/%&|^~?:;,.#()[\]{}@]+)/g;
    var html = "";
    var index = 0;
    var match;

    while ((match = tokenPattern.exec(text)) !== null) {
      var token = match[0];
      html += escapeHtml(text.slice(index, match.index));

      if (token.indexOf("//") === 0) {
        html += span("c1", token);
      } else if (token.indexOf("/*") === 0) {
        html += span("c", token);
      } else if (token.charAt(0) === '"' || token.charAt(0) === "'") {
        html += span("s", token);
      } else if (/^\d/.test(token)) {
        html += span("mi", token);
      } else if (svTypeMap[token]) {
        html += span("kt", token);
      } else if (svKeywordMap[token]) {
        html += span("k", token);
      } else if (token.charAt(0) === "$") {
        html += span("nb", token);
      } else if (/^[A-Za-z_]/.test(token)) {
        html += span("n", token);
      } else if (/^[()[\]{},.;#@]$/.test(token)) {
        html += span("p", token);
      } else {
        html += span("o", token);
      }

      index = tokenPattern.lastIndex;
    }

    return html + escapeHtml(text.slice(index));
  }

  function highlightSystemVerilogBlocks() {
    document.querySelectorAll("pre > code").forEach(function (code) {
      if (!isSystemVerilogCode(code) || code.dataset.highlighted === "sv") {
        return;
      }

      code.innerHTML = highlightSystemVerilog(code.textContent);
      code.dataset.highlighted = "sv";
    });
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }

    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();

    try {
      document.execCommand("copy");
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    } finally {
      document.body.removeChild(textarea);
    }
  }

  function addCopyButton(container, code) {
    if (container.querySelector(".code-copy-button")) {
      return;
    }

    var button = document.createElement("button");
    button.className = "code-copy-button";
    button.type = "button";
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy code");

    button.addEventListener("click", function () {
      copyText(code.textContent).then(function () {
        button.textContent = "Copied";
        button.classList.add("is-copied");

        window.setTimeout(function () {
          button.textContent = "Copy";
          button.classList.remove("is-copied");
        }, 1600);
      });
    });

    container.appendChild(button);
  }

  document.addEventListener("DOMContentLoaded", function () {
    highlightSystemVerilogBlocks();

    document.querySelectorAll(".post-content div.highlight, .page-content div.highlight").forEach(function (highlight) {
      var code = highlight.querySelector("pre code");

      if (code && !isWaveDromCode(code)) {
        addCopyButton(highlight, code);
      }
    });

    document.querySelectorAll(".post-content > pre, .page-content > pre").forEach(function (pre) {
      if (pre.closest(".highlight")) {
        return;
      }

      var code = pre.querySelector("code");

      if (!code || isWaveDromCode(code)) {
        return;
      }

      var wrapper = document.createElement("div");
      wrapper.className = isSystemVerilogCode(code) ? "highlight code-copy-wrapper" : "code-copy-wrapper";
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);
      addCopyButton(wrapper, code);
    });
  });
})();

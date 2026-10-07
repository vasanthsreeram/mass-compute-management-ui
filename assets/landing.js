(function () {
  var root = document.documentElement;
  var btn = document.getElementById("theme");
  var meta = document.querySelector('meta[name="theme-color"]');

  function current() {
    var t = root.getAttribute("data-theme");
    if (t === "dark" || t === "light") return t;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function paint(theme) {
    root.setAttribute("data-theme", theme);
    if (meta) meta.setAttribute("content", theme === "dark" ? "#1a1410" : "#f6f1ea");
    if (btn) {
      var dark = theme === "dark";
      btn.setAttribute("aria-pressed", dark ? "true" : "false");
      btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    }
  }

  paint(current());

  if (btn) {
    btn.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      try { localStorage.setItem("desk-theme", next); } catch (e) {}
      paint(next);
    });
  }

  document.querySelectorAll("[data-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      var node = document.getElementById(button.getAttribute("data-copy"));
      if (!node) return;
      var text = node.innerText.replace(/\n$/, "");
      function done(ok) {
        var prev = button.textContent;
        button.textContent = ok ? "Copied" : "Select";
        button.setAttribute("data-state", ok ? "done" : "fail");
        window.setTimeout(function () {
          button.textContent = prev;
          button.removeAttribute("data-state");
        }, 1400);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      } else {
        done(false);
      }
    });
  });
})();

/** mealog mockup theme switcher — default: Light Mint Air (A) */
(function () {
  var THEMES = {
    /* A · Soft Mint Air — 밝고 가벼운 브랜드 연속 */
    a: {
      "--green": "#3cb889",
      "--green-deep": "#2d9f74",
      "--green-soft": "#eaf8f2",
      "--green-mute": "#b4e2cd",
      "--coral": "#f2a8b4",
      "--coral-soft": "#fff0f3",
      "--ink": "#241f1c",
      "--ink-2": "#4f4841",
      "--muted": "#7a7268",
      "--line": "#d0c6ba",
      "--page": "#fffcf9",
      "--card": "#ffffff",
      "--c1": "#3cb889",
      "--c2": "#f2a8b4",
      "--c3": "#f0c89a",
      "--c4": "#9ec4e0",
      "--c5": "#d4aee0"
    },
    /* B · Blush Air — 크림·블러시 */
    b: {
      "--green": "#f0b7bc",
      "--green-deep": "#e0929a",
      "--green-soft": "#fff3f4",
      "--green-mute": "#f7d6d9",
      "--coral": "#e8c4a0",
      "--coral-soft": "#fff6ec",
      "--ink": "#2f2a28",
      "--ink-2": "#5a524e",
      "--muted": "#8f8580",
      "--line": "#e0d5cf",
      "--page": "#fffbfa",
      "--card": "#ffffff",
      "--c1": "#f0b7bc",
      "--c2": "#e8c4a0",
      "--c3": "#f5d5c8",
      "--c4": "#b5d0c4",
      "--c5": "#d9b8c8"
    },
    /* C · Soft Clay Air — 밝은 테라코타 */
    c: {
      "--green": "#e59a7a",
      "--green-deep": "#d07d5c",
      "--green-soft": "#fff3ec",
      "--green-mute": "#f3d2c2",
      "--coral": "#9cb892",
      "--coral-soft": "#f2f7ef",
      "--ink": "#2c2926",
      "--ink-2": "#574f48",
      "--muted": "#8c837a",
      "--line": "#ddd4c8",
      "--page": "#fffcf7",
      "--card": "#ffffff",
      "--c1": "#e59a7a",
      "--c2": "#9cb892",
      "--c3": "#f0c89a",
      "--c4": "#9ec4e0",
      "--c5": "#d4aee0"
    }
  };

  function currentTheme() {
    var t = (new URLSearchParams(location.search).get("theme") || "a").toLowerCase();
    return THEMES[t] ? t : "a";
  }

  function applyMealogTheme() {
    var key = currentTheme();
    var vars = THEMES[key];
    var root = document.documentElement;
    Object.keys(vars).forEach(function (k) {
      root.style.setProperty(k, vars[k]);
    });
    document.documentElement.dataset.theme = key;

    if (key === "a") return;
    document.querySelectorAll("a[href]").forEach(function (a) {
      var href = a.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("http") || href.startsWith("mailto:")) return;
      try {
        var url = new URL(href, location.href);
        if (!/\.html?/i.test(url.pathname)) return;
        if (!url.searchParams.has("theme")) url.searchParams.set("theme", key);
        var file = url.pathname.split("/").pop();
        a.setAttribute("href", file + url.search + url.hash);
      } catch (e) {}
    });
  }

  window.applyMealogTheme = applyMealogTheme;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyMealogTheme);
  } else {
    applyMealogTheme();
  }
})();
